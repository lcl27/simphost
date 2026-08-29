import { discoveryDocument, serviceCard } from "./discovery.js";
import { resolveConfig, type Env } from "./env.js";
import { handleHttpTool, HTTP_ROUTES } from "./http-api.js";
import { handleMcpRequest } from "./mcp/server.js";
import { summarise } from "./metering/ledger.js";
import { landingPage } from "./landing.js";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, payment-signature, x-payment, mcp-protocol-version, mcp-session-id",
  // Without this an agent's fetch cannot read the payment challenge it needs.
  "access-control-expose-headers": "payment-required, payment-response, x-payment-response, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/mcp") {
      return withCors(await handleMcpRequest(request, env, waitUntil));
    }

    if (path in HTTP_ROUTES) {
      return withCors(await handleHttpTool(path, request, env, waitUntil));
    }

    if (path === "/.well-known/x402" || path === "/discovery/resources") {
      return json(await discoveryDocument(env, request), 200, { "cache-control": "public, max-age=300" });
    }

    if (path === "/health") {
      const config = resolveConfig(env, request);
      return json({
        status: "ok",
        time: new Date().toISOString(),
        companies_house_key_configured: Boolean(env.CH_API_KEY),
        payments_enabled: config.paymentsEnabled,
        network: config.network,
        metering: env.METER ? "kv" : "none",
      });
    }

    if (path === "/admin/usage") {
      const expected = env.ADMIN_TOKEN?.trim();
      const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!expected || provided !== expected) {
        return json({ error: "unauthorised" }, 401, { "www-authenticate": "Bearer" });
      }
      const limit = Math.min(5000, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "1000", 10) || 1000));
      return json(await summarise(env, limit));
    }

    if (path === "/") {
      const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
      const card = await serviceCard(env, request);
      if (wantsHtml) {
        return new Response(landingPage(card), {
          headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS },
        });
      }
      return json(card);
    }

    return json({ error: "not_found", message: `No route for ${path}.`, discovery: "/.well-known/x402" }, 404);
  },
};
