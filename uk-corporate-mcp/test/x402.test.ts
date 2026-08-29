import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/env.js";
import { gate, settlementAmount } from "../src/x402/gate.js";
import { DEFAULT_PRICE, meteredMicros, microsToAtomic, microsToUsdString } from "../src/x402/pricing.js";
import { buildAccepts, selectRequirements } from "../src/x402/requirements.js";
import { resetSupportedCache, facilitatorAddressFor } from "../src/x402/facilitator.js";
import { ASSET, FACILITATOR_SIGNER, NETWORK, PAY_TO, PAYER, installFetchStub, paymentPayload, testEnv } from "./helpers.js";

const resource = { url: "https://uk-corporate-mcp.test/mcp#tool", description: "tool", mimeType: "application/json" };

beforeEach(() => {
  resetSupportedCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSupportedCache();
});

describe("pricing arithmetic", () => {
  it("converts micros to atomic units exactly for a six-decimal asset", () => {
    expect(microsToAtomic(2_000, 6)).toBe("2000");
    expect(microsToAtomic(10_000, 6)).toBe("10000");
  });

  it("scales for assets with other decimal counts", () => {
    expect(microsToAtomic(2_000, 18)).toBe("2000000000000000");
    expect(microsToAtomic(20_000, 2)).toBe("2");
  });

  it("rounds a sub-unit price up rather than letting it become free", () => {
    expect(microsToAtomic(2_000, 2)).toBe("1");
    expect(microsToAtomic(1, 2)).toBe("1");
    expect(microsToAtomic(0, 2)).toBe("0");
  });

  it("renders prices for humans without trailing zeros", () => {
    expect(microsToUsdString(2_000)).toBe("$0.002");
    expect(microsToUsdString(10_000)).toBe("$0.01");
  });

  it("meters one increment per extra upstream request and stops at the ceiling", () => {
    expect(meteredMicros(DEFAULT_PRICE, 1)).toBe(2_000);
    expect(meteredMicros(DEFAULT_PRICE, 2)).toBe(3_000);
    expect(meteredMicros(DEFAULT_PRICE, 5)).toBe(6_000);
    expect(meteredMicros(DEFAULT_PRICE, 500)).toBe(DEFAULT_PRICE.ceilingMicros);
  });

  it("never charges below the base, even for a call that made no upstream request", () => {
    expect(meteredMicros(DEFAULT_PRICE, 0)).toBe(2_000);
  });
});

describe("advertised requirements", () => {
  it("advertises both schemes when the facilitator supports them", async () => {
    installFetchStub();
    const accepts = await buildAccepts({ config: resolveConfig(testEnv()), price: DEFAULT_PRICE });
    expect(accepts.map((a) => a.scheme)).toEqual(["exact", "upto"]);
    expect(accepts[0]).toMatchObject({ amount: "2000", network: NETWORK, asset: ASSET, payTo: PAY_TO });
    expect(accepts[1]).toMatchObject({ amount: "10000" });
    expect(accepts[1]?.extra).toMatchObject({ facilitatorAddress: FACILITATOR_SIGNER });
  });

  it("drops upto when the facilitator publishes no signer to bind the permit to", async () => {
    installFetchStub({ signers: null });
    const accepts = await buildAccepts({ config: resolveConfig(testEnv()), price: DEFAULT_PRICE });
    expect(accepts.map((a) => a.scheme)).toEqual(["exact"]);
  });

  it("drops a scheme the facilitator does not settle on this network", async () => {
    installFetchStub({ supportedKinds: [{ scheme: "exact", network: NETWORK }] });
    const accepts = await buildAccepts({ config: resolveConfig(testEnv()), price: DEFAULT_PRICE });
    expect(accepts.map((a) => a.scheme)).toEqual(["exact"]);
  });

  it("matches a signer by CAIP-2 namespace wildcard", () => {
    expect(facilitatorAddressFor({ kinds: [], signers: { "eip155:*": ["0xabc"] } }, "eip155:8453")).toBe("0xabc");
    expect(facilitatorAddressFor({ kinds: [], signers: { "solana:*": ["abc"] } }, "eip155:8453")).toBeNull();
  });
});

describe("requirement selection is not driven by the client", () => {
  const accepts = [
    { scheme: "exact", network: NETWORK, amount: "2000", asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 120 },
    { scheme: "upto", network: NETWORK, amount: "10000", asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 120 },
  ];

  it("returns our own requirements object, not the client's", () => {
    const result = selectRequirements(accepts, paymentPayload("exact", "2000"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.requirements).toBe(accepts[0]);
  });

  it("rejects an under-priced authorisation", () => {
    const result = selectRequirements(accepts, paymentPayload("exact", "1"));
    expect(result).toMatchObject({ ok: false, reason: "invalid_amount" });
  });

  it("rejects an upto authorisation below our ceiling", () => {
    const result = selectRequirements(accepts, paymentPayload("upto", "2000"));
    expect(result).toMatchObject({ ok: false, reason: "invalid_amount" });
  });

  it("accepts an upto authorisation above our ceiling", () => {
    expect(selectRequirements(accepts, paymentPayload("upto", "20000")).ok).toBe(true);
  });

  it("rejects a redirected payTo", () => {
    const payload = paymentPayload("exact", "2000");
    payload.accepted.payTo = "0x0000000000000000000000000000000000000bad";
    expect(selectRequirements(accepts, payload)).toMatchObject({ ok: false, reason: "invalid_payload" });
  });

  it("rejects a substituted asset", () => {
    const payload = paymentPayload("exact", "2000");
    payload.accepted.asset = "0x0000000000000000000000000000000000000bad";
    expect(selectRequirements(accepts, payload)).toMatchObject({ ok: false, reason: "invalid_payload" });
  });

  it("rejects an unsupported scheme and network", () => {
    const wrongScheme = paymentPayload("exact", "2000");
    wrongScheme.accepted.scheme = "deferred";
    expect(selectRequirements(accepts, wrongScheme)).toMatchObject({ ok: false, reason: "invalid_scheme" });

    const wrongNetwork = paymentPayload("exact", "2000");
    wrongNetwork.accepted.network = "eip155:1";
    expect(selectRequirements(accepts, wrongNetwork)).toMatchObject({ ok: false, reason: "invalid_network" });
  });

  it("rejects a payload with no accepted object", () => {
    expect(selectRequirements(accepts, { x402Version: 2, payload: {} } as never)).toMatchObject({ ok: false });
  });

  it("tolerates case differences in addresses", () => {
    const payload = paymentPayload("exact", "2000");
    payload.accepted.payTo = PAY_TO.toLowerCase();
    payload.accepted.asset = ASSET.toUpperCase();
    expect(selectRequirements(accepts, payload).ok).toBe(true);
  });
});

describe("the payment gate", () => {
  const run = (upstreamRequests = 1, billable = true) => async () => ({ value: { ok: true }, upstreamRequests, billable });

  it("serves free when no payTo is configured", async () => {
    installFetchStub();
    const config = resolveConfig(testEnv({ X402_PAY_TO: "" }));
    const result = await gate({ config, price: DEFAULT_PRICE, resource, payload: null, run: run() });
    expect(result.kind).toBe("free");
  });

  it("challenges an unpaid call", async () => {
    installFetchStub();
    const result = await gate({ config: resolveConfig(testEnv()), price: DEFAULT_PRICE, resource, payload: null, run: run() });
    expect(result.kind).toBe("payment-required");
    if (result.kind === "payment-required") {
      expect(result.paymentRequired.x402Version).toBe(2);
      expect(result.paymentRequired.accepts.length).toBe(2);
      expect(result.paymentRequired.resource).toEqual(resource);
    }
  });

  it("settles the base price under the exact scheme regardless of upstream work", async () => {
    const recorder = installFetchStub();
    const result = await gate({
      config: resolveConfig(testEnv()),
      price: DEFAULT_PRICE,
      resource,
      payload: paymentPayload("exact", "2000"),
      run: run(4),
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.charged).toBe("2000");
    expect(recorder.settleBodies[0]?.paymentRequirements.amount).toBe("2000");
  });

  it("settles the metered amount under the upto scheme", async () => {
    const recorder = installFetchStub();
    const result = await gate({
      config: resolveConfig(testEnv()),
      price: DEFAULT_PRICE,
      resource,
      payload: paymentPayload("upto", "10000"),
      run: run(4),
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.charged).toBe("5000");
    // Verify sees the authorised ceiling; settle sees the amount charged.
    expect(recorder.verifyBodies[0]?.paymentRequirements.amount).toBe("10000");
    expect(recorder.settleBodies[0]?.paymentRequirements.amount).toBe("5000");
  });

  it("never settles more than the authorised ceiling", async () => {
    const recorder = installFetchStub();
    await gate({
      config: resolveConfig(testEnv()),
      price: DEFAULT_PRICE,
      resource,
      payload: paymentPayload("upto", "10000"),
      run: run(9_999),
    });
    expect(BigInt(recorder.settleBodies[0]!.paymentRequirements.amount)).toBeLessThanOrEqual(10_000n);
  });

  it("does not charge for a call that produced no billable data", async () => {
    const recorder = installFetchStub();
    const result = await gate({
      config: resolveConfig(testEnv()),
      price: DEFAULT_PRICE,
      resource,
      payload: paymentPayload("exact", "2000"),
      run: run(1, false),
    });
    expect(result.kind).toBe("unbilled");
    expect(recorder.settleBodies).toHaveLength(0);
  });

  it("does not run the handler when verification fails", async () => {
    installFetchStub({ verifyValid: false });
    const handler = vi.fn(run());
    const result = await gate({
      config: resolveConfig(testEnv()),
      price: DEFAULT_PRICE,
      resource,
      payload: paymentPayload("exact", "2000"),
      run: handler,
    });
    expect(result.kind).toBe("payment-required");
    expect(handler).not.toHaveBeenCalled();
  });

  it("withholds the result when settlement fails", async () => {
    installFetchStub({ settleSuccess: false });
    const result = await gate({
      config: resolveConfig(testEnv()),
      price: DEFAULT_PRICE,
      resource,
      payload: paymentPayload("exact", "2000"),
      run: run(),
    });
    expect(result.kind).toBe("payment-required");
    if (result.kind === "payment-required") expect(result.paymentRequired.error).toContain("Settlement failed");
  });

  it("reports the payer the facilitator identified", async () => {
    installFetchStub();
    const result = await gate({
      config: resolveConfig(testEnv()),
      price: DEFAULT_PRICE,
      resource,
      payload: paymentPayload("exact", "2000"),
      run: run(),
    });
    if (result.kind === "ok") expect(result.payer).toBe(PAYER);
  });

  it("surfaces a facilitator outage as a challenge rather than a silent free call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/supported")) {
          return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], signers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("connection refused");
      }),
    );
    const handler = vi.fn(run());
    const result = await gate({
      config: resolveConfig(testEnv()),
      price: DEFAULT_PRICE,
      resource,
      payload: paymentPayload("exact", "2000"),
      run: handler,
    });
    expect(result.kind).toBe("payment-required");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("settlement amount", () => {
  const config = resolveConfig(testEnv());
  it("is the base price for exact", () => {
    expect(settlementAmount({ scheme: "exact" } as never, DEFAULT_PRICE, config, 7)).toBe("2000");
  });
  it("is metered for upto", () => {
    expect(settlementAmount({ scheme: "upto" } as never, DEFAULT_PRICE, config, 3)).toBe("4000");
  });
});
