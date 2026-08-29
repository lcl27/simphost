import { vi } from "vitest";
import type { Env } from "../src/env.js";
import type { PaymentPayload } from "../src/x402/types.js";
import { filingHistoryFixture, pscFixture, pscStatementsFixture } from "./fixtures/companies-house.js";

export const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
export const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const NETWORK = "eip155:84532";
export const FACILITATOR = "https://facilitator.test";
export const FACILITATOR_SIGNER = "0xFac1111111111111111111111111111111111111";
export const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    CH_API_KEY: "test-key",
    PUBLIC_BASE_URL: "https://uk-corporate-mcp.test",
    X402_NETWORK: NETWORK,
    X402_ASSET: ASSET,
    X402_ASSET_NAME: "USDC",
    X402_ASSET_VERSION: "2",
    X402_ASSET_DECIMALS: "6",
    X402_PAY_TO: PAY_TO,
    X402_FACILITATOR_URL: FACILITATOR,
    X402_SCHEMES: "exact,upto",
    ...overrides,
  };
}

export interface FacilitatorBehaviour {
  verifyValid?: boolean;
  verifyReason?: string;
  settleSuccess?: boolean;
  settleReason?: string;
  supportedKinds?: Array<{ scheme: string; network: string }>;
  signers?: Record<string, string[]> | null;
}

export interface Recorder {
  chCalls: string[];
  settleBodies: Array<{ paymentRequirements: { amount: string; scheme: string } }>;
  verifyBodies: Array<{ paymentRequirements: { amount: string; scheme: string } }>;
}

/**
 * Stubs both upstreams the worker talks to: Companies House and the x402
 * facilitator. Anything else being fetched is a bug and fails loudly.
 */
export function installFetchStub(behaviour: FacilitatorBehaviour = {}): Recorder {
  const recorder: Recorder = { chCalls: [], settleBodies: [], verifyBodies: [] };
  const {
    verifyValid = true,
    settleSuccess = true,
    supportedKinds = [
      { scheme: "exact", network: NETWORK },
      { scheme: "upto", network: NETWORK },
    ],
    signers = { "eip155:*": [FACILITATOR_SIGNER] },
  } = behaviour;

  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const jsonResponse = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

    if (url.startsWith(`${FACILITATOR}/supported`)) {
      return jsonResponse({
        kinds: supportedKinds.map((k) => ({ x402Version: 2, ...k })),
        extensions: [],
        ...(signers ? { signers } : {}),
      });
    }
    if (url.startsWith(`${FACILITATOR}/verify`)) {
      recorder.verifyBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(
        verifyValid ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: behaviour.verifyReason ?? "insufficient_funds", payer: PAYER },
      );
    }
    if (url.startsWith(`${FACILITATOR}/settle`)) {
      const body = JSON.parse(String(init?.body));
      recorder.settleBodies.push(body);
      return jsonResponse(
        settleSuccess
          ? {
              success: true,
              payer: PAYER,
              transaction: "0xdeadbeef",
              network: NETWORK,
              amount: body.paymentRequirements.amount,
            }
          : { success: false, errorReason: behaviour.settleReason ?? "insufficient_funds", transaction: "", network: NETWORK },
      );
    }

    if (url.startsWith("https://api.company-information.service.gov.uk")) {
      recorder.chCalls.push(url);
      const path = new URL(url).pathname;
      if (path.endsWith("/filing-history")) return jsonResponse(filingHistoryFixture);
      if (path.endsWith("/persons-with-significant-control")) return jsonResponse(pscFixture);
      if (path.endsWith("/persons-with-significant-control-statements")) return jsonResponse(pscStatementsFixture);
      return jsonResponse({ errors: [{ error: "company-profile-not-found", type: "ch:service" }] }, 404);
    }

    throw new Error(`unexpected fetch to ${url}`);
  });

  vi.stubGlobal("fetch", stub);
  return recorder;
}

export function paymentPayload(scheme: "exact" | "upto", amount: string): PaymentPayload {
  const extra: Record<string, unknown> = { name: "USDC", version: "2" };
  if (scheme === "upto") extra["facilitatorAddress"] = FACILITATOR_SIGNER;
  return {
    x402Version: 2,
    accepted: {
      scheme,
      network: NETWORK,
      amount,
      asset: ASSET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra,
    },
    payload: { signature: "0xsig", authorization: { from: PAYER, to: PAY_TO, value: amount } },
  };
}

export function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://uk-corporate-mcp.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export const noopCtx = {
  waitUntil: (_p: Promise<unknown>) => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;
