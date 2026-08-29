import { createChClient } from "./companies-house/client.js";
import { resolveConfig, type Env } from "./env.js";
import { record, type CallEvent } from "./metering/ledger.js";
import { findTool } from "./tools/registry.js";
import { ToolArgumentError } from "./tools/types.js";
import { gate } from "./x402/gate.js";
import type { PaymentPayload } from "./x402/types.js";

/**
 * The REST mirror of the two MCP tools.
 *
 * It exists because discovery is the whole point: x402 indexes and AWS
 * AgentCore's paid-API discovery both crawl plain HTTP resources, and an agent
 * that finds the endpoint that way should not have to speak MCP to use it.
 */
export const HTTP_ROUTES: Record<string, string> = {
  "/v1/filing-history": "get_company_filing_history",
  "/v1/psc-verification": "get_psc_verification_status",
};

function decodeHeaderPayload(raw: string | null): { payload: PaymentPayload | null; error?: string } {
  if (!raw) return { payload: null };
  try {
    const decoded = JSON.parse(atob(raw.trim())) as PaymentPayload;
    if (!decoded || typeof decoded !== "object") return { payload: null, error: "payment header did not decode to an object" };
    if (!("accepted" in decoded)) {
      return {
        payload: null,
        error:
          "This endpoint speaks x402 v2: the payment payload must carry an `accepted` object. " +
          "A v1 payload (top-level `scheme`/`network`) is not accepted.",
      };
    }
    return { payload: decoded };
  } catch {
    return { payload: null, error: "payment header is not base64-encoded JSON" };
  }
}

function encodeHeaderPayload(value: unknown): string {
  return btoa(JSON.stringify(value));
}

export async function handleHttpTool(
  path: string,
  request: Request,
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  const toolName = HTTP_ROUTES[path];
  const tool = toolName ? findTool(toolName) : undefined;
  if (!tool) return new Response("Not found", { status: 404 });

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed", message: "Use POST with a JSON body." }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST" },
    });
  }

  let args: Record<string, unknown> = {};
  try {
    const body = await request.text();
    if (body.trim()) args = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json", message: "Request body is not valid JSON." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const config = resolveConfig(env, request);
  const client = createChClient(env);
  const started = Date.now();
  const cf = (request as { cf?: { country?: string; colo?: string } }).cf;

  const { payload, error: payloadError } = decodeHeaderPayload(
    request.headers.get("payment-signature") ?? request.headers.get("x-payment"),
  );

  const event: CallEvent = {
    ts: new Date().toISOString(),
    transport: "http",
    tool: tool.name,
    outcome: "free",
    duration_ms: 0,
    upstream_requests: 0,
    client: request.headers.get("user-agent") ?? undefined,
    country: cf?.country,
    colo: cf?.colo,
    subject: typeof args["company_number"] === "string" ? args["company_number"] : undefined,
    scheme: typeof payload?.accepted?.scheme === "string" ? payload.accepted.scheme : undefined,
  };

  const resource = {
    url: `${config.baseUrl}${path}`,
    description: tool.title,
    mimeType: "application/json",
  };

  let outcome;
  try {
    outcome = await gate({
      config,
      price: tool.price,
      resource,
      payload,
      run: () => tool.run(args, { env, client }),
    });
  } catch (cause) {
    event.outcome = "error";
    event.duration_ms = Date.now() - started;
    event.upstream_requests = client.requestCount;
    event.error = cause instanceof Error ? cause.message : String(cause);
    waitUntil(record(env, event));
    const status = cause instanceof ToolArgumentError ? 400 : 500;
    const message = cause instanceof ToolArgumentError ? cause.message : "Internal error while running the tool.";
    return new Response(JSON.stringify({ error: status === 400 ? "invalid_argument" : "internal_error", message }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  event.duration_ms = Date.now() - started;
  event.upstream_requests = client.requestCount;

  if (outcome.kind === "payment-required") {
    const paymentRequired = payloadError
      ? { ...outcome.paymentRequired, error: payloadError }
      : outcome.paymentRequired;
    event.outcome = "payment_required";
    event.error = paymentRequired.error;
    waitUntil(record(env, event));
    return new Response(JSON.stringify(paymentRequired), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": encodeHeaderPayload(paymentRequired),
        "cache-control": "no-store",
      },
    });
  }

  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };

  if (outcome.kind === "ok") {
    event.outcome = "paid";
    event.charged = outcome.charged;
    event.payer = outcome.payer;
    event.network = outcome.settlement?.network ?? config.network;
    event.transaction = outcome.settlement?.transaction;
    headers["payment-response"] = encodeHeaderPayload(outcome.settlement);
  } else if (outcome.kind === "unbilled") {
    event.outcome = "unbilled";
    event.payer = outcome.payer;
    headers["payment-response"] = encodeHeaderPayload({
      success: true,
      transaction: "",
      network: config.network,
      amount: "0",
      payer: outcome.payer,
    });
  }

  waitUntil(record(env, event));
  return new Response(JSON.stringify(outcome.value, null, 2), { status: 200, headers });
}
