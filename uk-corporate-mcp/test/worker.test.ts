import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { resetSupportedCache } from "../src/x402/facilitator.js";
import { installFetchStub, mcpRequest, noopCtx, paymentPayload, testEnv, PAYER } from "./helpers.js";

beforeEach(() => resetSupportedCache());
afterEach(() => {
  vi.unstubAllGlobals();
  resetSupportedCache();
});

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://uk-corporate-mcp.test${path}`, { headers });
}

describe("MCP handshake and discovery are free", () => {
  it("initialises and echoes a supported protocol version", async () => {
    installFetchStub();
    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "probe", version: "1.0" } } }),
      testEnv(),
      noopCtx,
    );
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("uk-corporate-mcp");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("falls back to its own latest version for an unknown protocol version", async () => {
    installFetchStub();
    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }),
      testEnv(),
      noopCtx,
    );
    expect((await response.json() as any).result.protocolVersion).toBe("2025-06-18");
  });

  it("lists both tools with their prices, without asking for payment", async () => {
    installFetchStub();
    const response = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }), testEnv(), noopCtx);
    const body = (await response.json()) as any;
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["get_company_filing_history", "get_psc_verification_status"]);
    expect(body.result.tools[0]._meta["x402/price"]).toMatchObject({ base: "2000", ceiling: "10000", base_usd: "$0.002" });
    expect(body.result.tools[0].annotations.readOnlyHint).toBe(true);
  });

  it("answers ping and swallows notifications", async () => {
    installFetchStub();
    const ping = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 3, method: "ping" }), testEnv(), noopCtx);
    expect((await ping.json() as any).result).toEqual({});

    const notification = await worker.fetch(mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), testEnv(), noopCtx);
    expect(notification.status).toBe(202);
  });

  it("rejects unknown methods and JSON-RPC batches", async () => {
    installFetchStub();
    const unknown = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 4, method: "tools/teleport" }), testEnv(), noopCtx);
    expect((await unknown.json() as any).error.code).toBe(-32601);

    const batch = await worker.fetch(mcpRequest([{ jsonrpc: "2.0", id: 5, method: "ping" }]), testEnv(), noopCtx);
    expect(batch.status).toBe(400);
  });

  it("refuses GET on the MCP endpoint with an Allow header", async () => {
    const response = await worker.fetch(get("/mcp"), testEnv(), noopCtx);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("MCP tool calls behind the paywall", () => {
  const call = (args: Record<string, unknown>, meta?: Record<string, unknown>) =>
    mcpRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "get_company_filing_history", arguments: args, ...(meta ? { _meta: meta } : {}) },
    });

  it("returns a PaymentRequired in both required formats when unpaid", async () => {
    installFetchStub();
    const response = await worker.fetch(call({ company_number: "00000001" }), testEnv(), noopCtx);
    const body = (await response.json()) as any;

    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.x402Version).toBe(2);
    expect(body.result.structuredContent.accepts).toHaveLength(2);
    expect(body.result.structuredContent.resource.url).toBe("https://uk-corporate-mcp.test/mcp#get_company_filing_history");
    // The specification requires content[0].text to be the same object, encoded.
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
  });

  it("serves the data and the settlement receipt when paid", async () => {
    installFetchStub();
    const response = await worker.fetch(
      call({ company_number: "00000001" }, { "x402/payment": paymentPayload("exact", "2000") }),
      testEnv(),
      noopCtx,
    );
    const body = (await response.json()) as any;

    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.company_number).toBe("00000001");
    expect(body.result.structuredContent.chronology.last_filing_date).toBe("2025-06-14");
    expect(body.result._meta["x402/payment-response"]).toMatchObject({ success: true, payer: PAYER, amount: "2000" });
  });

  it("meters a paged call under the upto scheme", async () => {
    const recorder = installFetchStub();
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "get_psc_verification_status",
          arguments: { company_number: "00000001", include_statements: true },
          _meta: { "x402/payment": paymentPayload("upto", "10000") },
        },
      }),
      testEnv(),
      noopCtx,
    );
    const body = (await response.json()) as any;
    // Two upstream requests: the PSC register and the statements register.
    expect(recorder.chCalls).toHaveLength(2);
    expect(body.result._meta["x402/payment-response"].amount).toBe("3000");
  });

  it("does not charge for an unknown company number but still answers", async () => {
    installFetchStub();
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("facilitator.test/supported")) {
        return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], signers: {} }), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("facilitator.test/verify")) {
        return new Response(JSON.stringify({ isValid: true, payer: PAYER }), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("facilitator.test/settle")) throw new Error("settle must not be called");
      return new Response("{}", { status: 404 });
    }));

    const response = await worker.fetch(
      call({ company_number: "99999999" }, { "x402/payment": paymentPayload("exact", "2000") }),
      testEnv(),
      noopCtx,
    );
    const body = (await response.json()) as any;
    expect(body.result.structuredContent.error).toBe("not_found");
    expect(body.result._meta["x402/payment-response"].amount).toBe("0");
  });

  it("rejects an unknown tool with an invalid-params error", async () => {
    installFetchStub();
    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "nope", arguments: {} } }),
      testEnv(),
      noopCtx,
    );
    expect((await response.json() as any).error.code).toBe(-32602);
  });

  it("serves free when the deployment has no wallet configured", async () => {
    installFetchStub();
    const response = await worker.fetch(call({ company_number: "00000001" }), testEnv({ X402_PAY_TO: "" }), noopCtx);
    const body = (await response.json()) as any;
    expect(body.result.isError).toBe(false);
    expect(body.result._meta).toBeUndefined();
  });
});

describe("the HTTP mirror", () => {
  it("challenges an unpaid request with a 402 and the PAYMENT-REQUIRED header", async () => {
    installFetchStub();
    const response = await worker.fetch(
      new Request("https://uk-corporate-mcp.test/v1/filing-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company_number: "00000001" }),
      }),
      testEnv(),
      noopCtx,
    );
    expect(response.status).toBe(402);
    const header = response.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = JSON.parse(atob(header!));
    expect(decoded).toEqual(await response.clone().json());
    expect(decoded.accepts[0].amount).toBe("2000");
  });

  it("serves the data with a PAYMENT-RESPONSE header when paid", async () => {
    installFetchStub();
    const response = await worker.fetch(
      new Request("https://uk-corporate-mcp.test/v1/psc-verification", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": btoa(JSON.stringify(paymentPayload("exact", "2000"))),
        },
        body: JSON.stringify({ company_number: "00000001" }),
      }),
      testEnv(),
      noopCtx,
    );
    expect(response.status).toBe(200);
    const receipt = JSON.parse(atob(response.headers.get("payment-response")!));
    expect(receipt).toMatchObject({ success: true, amount: "2000" });
    expect(((await response.json()) as any).summary.active_psc_count).toBe(3);
  });

  it("tells a v1 client plainly that this endpoint speaks v2", async () => {
    installFetchStub();
    const v1Payload = { x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} };
    const response = await worker.fetch(
      new Request("https://uk-corporate-mcp.test/v1/filing-history", {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": btoa(JSON.stringify(v1Payload)) },
        body: JSON.stringify({ company_number: "00000001" }),
      }),
      testEnv(),
      noopCtx,
    );
    expect(response.status).toBe(402);
    expect(((await response.json()) as any).error).toContain("x402 v2");
  });

  it("refuses GET", async () => {
    const response = await worker.fetch(get("/v1/filing-history"), testEnv(), noopCtx);
    expect(response.status).toBe(405);
  });
});

describe("service surfaces", () => {
  it("reports health without leaking the API key", async () => {
    const response = await worker.fetch(get("/health"), testEnv(), noopCtx);
    const body = (await response.json()) as any;
    expect(body).toMatchObject({ status: "ok", companies_house_key_configured: true, payments_enabled: true });
    expect(JSON.stringify(body)).not.toContain("test-key");
  });

  it("publishes an x402 discovery document covering both transports", async () => {
    installFetchStub();
    const response = await worker.fetch(get("/.well-known/x402"), testEnv(), noopCtx);
    const body = (await response.json()) as any;
    expect(body.x402Version).toBe(2);
    expect(body.items).toHaveLength(4);
    expect(body.items.map((i: any) => i.type).sort()).toEqual(["http", "http", "mcp", "mcp"]);
    expect(body.items[0].accepts[0].payTo).toBeTruthy();
    expect(body.items[0].metadata.input_schema.required).toEqual(["company_number"]);
  });

  it("serves the service card as JSON and as a page", async () => {
    installFetchStub();
    const asJson = await worker.fetch(get("/"), testEnv(), noopCtx);
    expect(asJson.headers.get("content-type")).toContain("application/json");
    expect(((await asJson.json()) as any).tools).toHaveLength(2);

    const asHtml = await worker.fetch(get("/", { accept: "text/html" }), testEnv(), noopCtx);
    expect(asHtml.headers.get("content-type")).toContain("text/html");
    const html = await asHtml.text();
    expect(html).toContain("get_company_filing_history");
    expect(html).toContain("Open Government Licence");
  });

  it("guards the usage report", async () => {
    const unauthorised = await worker.fetch(get("/admin/usage"), testEnv({ ADMIN_TOKEN: "s3cret" }), noopCtx);
    expect(unauthorised.status).toBe(401);

    const authorised = await worker.fetch(
      get("/admin/usage", { authorization: "Bearer s3cret" }),
      testEnv({ ADMIN_TOKEN: "s3cret" }),
      noopCtx,
    );
    expect(authorised.status).toBe(200);
  });

  it("never opens the usage report when no admin token is configured", async () => {
    const response = await worker.fetch(get("/admin/usage", { authorization: "Bearer " }), testEnv(), noopCtx);
    expect(response.status).toBe(401);
  });

  it("answers CORS preflight so a browser-based agent can read the challenge headers", async () => {
    const response = await worker.fetch(
      new Request("https://uk-corporate-mcp.test/mcp", { method: "OPTIONS" }),
      testEnv(),
      noopCtx,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-expose-headers")).toContain("payment-required");
  });

  it("points a lost caller at discovery", async () => {
    const response = await worker.fetch(get("/nope"), testEnv(), noopCtx);
    expect(response.status).toBe(404);
    expect(((await response.json()) as any).discovery).toBe("/.well-known/x402");
  });
});
