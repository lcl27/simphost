import type { ResolvedConfig } from "../env.js";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "./types.js";

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions?: string[];
  /** Map of CAIP-2 patterns ("eip155:*") to the facilitator's signer addresses. */
  signers?: Record<string, string[]>;
}

export class FacilitatorError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "FacilitatorError";
  }
}

function headers(config: ResolvedConfig): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (config.facilitatorToken) h["authorization"] = `Bearer ${config.facilitatorToken}`;
  return h;
}

async function postJson<T>(url: string, body: unknown, config: ResolvedConfig): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: headers(config), body: JSON.stringify(body) });
  } catch (cause) {
    throw new FacilitatorError(`facilitator unreachable: ${(cause as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new FacilitatorError(`facilitator ${response.status}: ${text.slice(0, 400)}`, response.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FacilitatorError(`facilitator returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export async function verify(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  config: ResolvedConfig,
): Promise<VerifyResponse> {
  return postJson<VerifyResponse>(
    `${config.facilitatorUrl}/verify`,
    { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements },
    config,
  );
}

/**
 * `requirements.amount` here is what will actually be charged. Under the `upto`
 * scheme that is the metered amount, which must not exceed the ceiling the
 * client authorised at verify time.
 */
export async function settle(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  config: ResolvedConfig,
): Promise<SettleResponse> {
  return postJson<SettleResponse>(
    `${config.facilitatorUrl}/settle`,
    { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements },
    config,
  );
}

const SUPPORTED_TTL_MS = 10 * 60 * 1000;
let supportedCache: { url: string; at: number; value: SupportedResponse | null } | null = null;

/**
 * Cached in module scope rather than the Cache API: it is a small document, it
 * changes rarely, and a Worker isolate is short-lived enough that a ten-minute
 * memo is the right amount of staleness.
 */
export async function getSupported(config: ResolvedConfig): Promise<SupportedResponse | null> {
  const now = Date.now();
  if (supportedCache && supportedCache.url === config.facilitatorUrl && now - supportedCache.at < SUPPORTED_TTL_MS) {
    return supportedCache.value;
  }
  let value: SupportedResponse | null = null;
  try {
    const response = await fetch(`${config.facilitatorUrl}/supported`, { headers: headers(config) });
    if (response.ok) value = (await response.json()) as SupportedResponse;
  } catch {
    value = null;
  }
  supportedCache = { url: config.facilitatorUrl, at: now, value };
  return value;
}

/** Exposed so tests do not leak the memo between cases. */
export function resetSupportedCache(): void {
  supportedCache = null;
}

/**
 * The `upto` scheme binds the client's Permit2 signature to a named facilitator,
 * so we cannot advertise it until we know which address that is.
 */
export function facilitatorAddressFor(supported: SupportedResponse | null, network: string): string | null {
  if (!supported?.signers) return null;
  const namespace = network.split(":")[0] ?? "";
  const candidates = [network, `${namespace}:*`, "*"];
  for (const key of candidates) {
    const addresses = supported.signers[key];
    if (addresses && addresses.length > 0 && addresses[0]) return addresses[0];
  }
  return null;
}

export function facilitatorSupports(supported: SupportedResponse | null, scheme: string, network: string): boolean {
  if (!supported?.kinds) return true; // unknown: assume yes rather than refusing to quote
  return supported.kinds.some((k) => k.scheme === scheme && k.network === network);
}
