import { createChClient } from "../companies-house/client.js";
import { resolveConfig, type Env } from "../env.js";
import { record, type CallEvent } from "../metering/ledger.js";
import { findTool, TOOLS } from "../tools/registry.js";
import { ToolArgumentError } from "../tools/types.js";
import { gate } from "../x402/gate.js";
import { microsToAtomic, microsToUsdString } from "../x402/pricing.js";
import type { PaymentPayload } from "../x402/types.js";

export const SERVER_INFO = {
  name: "uk-corporate-mcp",
  title: "UK corporate reference data",
  version: "0.1.0",
} as const;

/** Newest first; the first entry is what we advertise when a client asks for something unknown. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

const INSTRUCTIONS =
  "Two metered tools over the Companies House public data API for UK companies. " +
  "Both are read-only and priced per call in x402; tools/list and initialize are free, so a client can inspect " +
  "schemas and prices before committing to spend. Calls that fail because of a bad argument or an unknown company " +
  "number are not charged for.";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

function toolDescriptor(tool: (typeof TOOLS)[number], paymentsEnabled: boolean, decimals: number) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    // Advertised so an agent can budget before it calls. Not part of the MCP
    // schema; namespaced under _meta as the specification requires.
    _meta: {
      "x402/price": paymentsEnabled
        ? {
            base: microsToAtomic(tool.price.baseMicros, decimals),
            ceiling: microsToAtomic(tool.price.ceilingMicros, decimals),
            base_usd: microsToUsdString(tool.price.baseMicros),
            ceiling_usd: microsToUsdString(tool.price.ceilingMicros),
            note: "The 'exact' scheme always settles the base price. The 'upto' scheme authorises the ceiling and settles the metered amount.",
          }
        : { free: true, note: "Payments are not enabled on this deployment." },
    },
  };
}

function paymentFromParams(params: Record<string, unknown> | undefined): PaymentPayload | null {
  const meta = params?.["_meta"];
  if (!meta || typeof meta !== "object") return null;
  const payment = (meta as Record<string, unknown>)["x402/payment"];
  if (!payment || typeof payment !== "object") return null;
  return payment as PaymentPayload;
}

/** The x402 MCP transport signals payment through an errored tool result, not a JSON-RPC error. */
function paymentRequiredResult(paymentRequired: unknown) {
  return {
    isError: true,
    structuredContent: paymentRequired,
    content: [{ type: "text", text: JSON.stringify(paymentRequired) }],
  };
}

function toolResult(value: unknown, meta?: Record<string, unknown>) {
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
  if (meta) result["_meta"] = meta;
  return result;
}

export interface McpContext {
  env: Env;
  request: Request;
  waitUntil: (promise: Promise<unknown>) => void;
}

export async function handleRpc(message: JsonRpcRequest, ctx: McpContext): Promise<unknown | null> {
  const { env, request } = ctx;
  const method = message.method;
  const isNotification = message.id === undefined || message.id === null;

  if (message.jsonrpc !== "2.0") {
    return isNotification ? null : rpcError(message.id, ERROR.INVALID_REQUEST, "jsonrpc must be \"2.0\"");
  }

  switch (method) {
    case "initialize": {
      const requested = String(message.params?.["protocolVersion"] ?? "");
      const clientInfo = message.params?.["clientInfo"] as { name?: string; version?: string } | undefined;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];

      ctx.waitUntil(
        record(env, {
          ...baseEvent(request),
          tool: "initialize",
          outcome: "free",
          duration_ms: 0,
          upstream_requests: 0,
          client: clientInfo?.name ? `${clientInfo.name}/${clientInfo.version ?? "?"}` : undefined,
        }),
      );

      return rpcResult(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : rpcResult(message.id, {});

    case "tools/list": {
      const config = resolveConfig(env, request);
      return rpcResult(message.id, {
        tools: TOOLS.map((tool) => toolDescriptor(tool, config.paymentsEnabled, config.assetDecimals)),
      });
    }

    case "tools/call":
      return handleToolCall(message, ctx);

    case "resources/list":
      return rpcResult(message.id, { resources: [] });

    case "prompts/list":
      return rpcResult(message.id, { prompts: [] });

    default:
      if (isNotification) return null;
      return rpcError(message.id, ERROR.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

function baseEvent(request: Request): Pick<CallEvent, "ts" | "transport" | "country" | "colo"> {
  const cf = (request as { cf?: { country?: string; colo?: string } }).cf;
  return {
    ts: new Date().toISOString(),
    transport: "mcp",
    country: cf?.country,
    colo: cf?.colo,
  };
}

async function handleToolCall(message: JsonRpcRequest, ctx: McpContext): Promise<unknown> {
  const { env, request } = ctx;
  const params = message.params ?? {};
  const name = String(params["name"] ?? "");
  const tool = findTool(name);
  const started = Date.now();

  if (!tool) {
    return rpcError(message.id, ERROR.INVALID_PARAMS, `Unknown tool: ${name}`);
  }

  const args = (params["arguments"] ?? {}) as Record<string, unknown>;
  const config = resolveConfig(env, request);
  const client = createChClient(env);
  const resource = {
    url: `${config.baseUrl}/mcp#${tool.name}`,
    description: tool.title,
    mimeType: "application/json",
  };

  const subject = typeof args["company_number"] === "string" ? args["company_number"] : undefined;
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const payment = paymentFromParams(params);
  const chosenScheme = typeof payment?.accepted?.scheme === "string" ? payment.accepted.scheme : undefined;

  let outcome;
  try {
    outcome = await gate({
      config,
      price: tool.price,
      resource,
      payload: payment,
      run: () => tool.run(args, { env, client }),
    });
  } catch (cause) {
    const messageText = cause instanceof ToolArgumentError ? cause.message : "Internal error while running the tool.";
    ctx.waitUntil(
      record(env, {
        ...baseEvent(request),
        tool: tool.name,
        outcome: "error",
        duration_ms: Date.now() - started,
        upstream_requests: client.requestCount,
        client: userAgent,
        subject,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    const code = cause instanceof ToolArgumentError ? ERROR.INVALID_PARAMS : ERROR.INTERNAL;
    return rpcError(message.id, code, messageText);
  }

  const event: CallEvent = {
    ...baseEvent(request),
    tool: tool.name,
    outcome: "free",
    duration_ms: Date.now() - started,
    upstream_requests: client.requestCount,
    client: userAgent,
    subject,
  };

  if (outcome.kind === "payment-required") {
    event.outcome = "payment_required";
    event.error = outcome.paymentRequired.error;
    ctx.waitUntil(record(env, event));
    return rpcResult(message.id, paymentRequiredResult(outcome.paymentRequired));
  }

  if (outcome.kind === "ok") {
    event.outcome = "paid";
    event.charged = outcome.charged;
    event.payer = outcome.payer;
    event.scheme = chosenScheme;
    event.network = outcome.settlement?.network ?? config.network;
    event.transaction = outcome.settlement?.transaction;
    ctx.waitUntil(record(env, event));
    return rpcResult(message.id, toolResult(outcome.value, { "x402/payment-response": outcome.settlement }));
  }

  if (outcome.kind === "unbilled") {
    event.outcome = "unbilled";
    event.payer = outcome.payer;
    ctx.waitUntil(record(env, event));
    return rpcResult(
      message.id,
      toolResult(outcome.value, {
        "x402/payment-response": {
          success: true,
          transaction: "",
          network: config.network,
          amount: "0",
          payer: outcome.payer,
          note: "Not charged: the call did not produce billable data.",
        },
      }),
    );
  }

  ctx.waitUntil(record(env, event));
  return rpcResult(message.id, toolResult(outcome.value));
}

export async function handleMcpRequest(request: Request, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify(rpcError(null, ERROR.INVALID_REQUEST, "This MCP endpoint accepts POST with a single JSON-RPC message.")),
      { status: 405, headers: { "content-type": "application/json", allow: "POST" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, ERROR.PARSE, "Request body is not valid JSON."), 400);
  }

  if (Array.isArray(body)) {
    // Batching was removed in MCP 2025-06-18; say so rather than half-supporting it.
    return json(rpcError(null, ERROR.INVALID_REQUEST, "JSON-RPC batching is not supported. Send one message per request."), 400);
  }
  if (!body || typeof body !== "object") {
    return json(rpcError(null, ERROR.INVALID_REQUEST, "Request body must be a JSON-RPC object."), 400);
  }

  const response = await handleRpc(body as JsonRpcRequest, { env, request, waitUntil });
  if (response === null) return new Response(null, { status: 202 });
  return json(response, 200);
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": SUPPORTED_PROTOCOL_VERSIONS[0]!,
      "cache-control": "no-store",
    },
  });
}
