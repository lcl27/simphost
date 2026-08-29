import type { ResolvedConfig } from "../env.js";
import { priceForScheme, type ToolPrice } from "./pricing.js";
import { facilitatorAddressFor, facilitatorSupports, getSupported } from "./facilitator.js";
import { X402_ERROR, type PaymentPayload, type PaymentRequired, type PaymentRequirements, type ResourceInfo } from "./types.js";

export interface QuoteInput {
  config: ResolvedConfig;
  price: ToolPrice;
  resource: ResourceInfo;
}

/**
 * Build the `accepts` list. Schemes the facilitator cannot settle are dropped
 * rather than advertised, so every entry a client sees is one it can actually
 * pay with.
 */
export async function buildAccepts({ config, price }: Omit<QuoteInput, "resource">): Promise<PaymentRequirements[]> {
  const supported = await getSupported(config);
  const facilitatorAddress = facilitatorAddressFor(supported, config.network);
  const accepts: PaymentRequirements[] = [];

  for (const scheme of config.schemes) {
    if (!facilitatorSupports(supported, scheme, config.network)) continue;
    // The upto scheme requires the client to bind its Permit2 witness to a
    // named facilitator; without that address the requirement is unsatisfiable.
    if (scheme === "upto" && !facilitatorAddress) continue;

    const extra: Record<string, unknown> = { name: config.assetName, version: config.assetVersion };
    if (scheme === "upto") extra["facilitatorAddress"] = facilitatorAddress;

    accepts.push({
      scheme,
      network: config.network,
      amount: priceForScheme(price, scheme, config),
      asset: config.asset,
      payTo: config.payTo,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      extra,
    });
  }
  return accepts;
}

export async function buildPaymentRequired(input: QuoteInput, error: string): Promise<PaymentRequired> {
  return {
    x402Version: 2,
    error,
    resource: input.resource,
    accepts: await buildAccepts(input),
  };
}

export type RequirementMatch =
  | { ok: true; requirements: PaymentRequirements }
  | { ok: false; reason: string; detail: string };

/**
 * Resolve the client's stated choice back to *our* copy of the requirements.
 *
 * The payload is attacker-controlled, so nothing from it is forwarded to the
 * facilitator: we match on scheme and network, check the remaining fields agree
 * with what we advertised, and then verify and settle against our own object.
 */
export function selectRequirements(
  accepts: PaymentRequirements[],
  payload: PaymentPayload,
): RequirementMatch {
  const chosen = payload.accepted;
  if (!chosen || typeof chosen !== "object") {
    return { ok: false, reason: X402_ERROR.INVALID_PAYLOAD, detail: "payment payload has no `accepted` object" };
  }

  const byScheme = accepts.filter((a) => a.scheme === chosen.scheme);
  if (byScheme.length === 0) {
    return {
      ok: false,
      reason: X402_ERROR.INVALID_SCHEME,
      detail: `scheme "${chosen.scheme}" is not accepted for this resource`,
    };
  }

  const match = byScheme.find((a) => a.network === chosen.network);
  if (!match) {
    return {
      ok: false,
      reason: X402_ERROR.INVALID_NETWORK,
      detail: `network "${chosen.network}" is not accepted for this resource`,
    };
  }

  if (chosen.asset?.toLowerCase() !== match.asset.toLowerCase()) {
    return { ok: false, reason: X402_ERROR.INVALID_PAYLOAD, detail: "asset does not match the advertised requirements" };
  }
  if (chosen.payTo?.toLowerCase() !== match.payTo.toLowerCase()) {
    return { ok: false, reason: X402_ERROR.INVALID_PAYLOAD, detail: "payTo does not match the advertised requirements" };
  }

  let authorised: bigint;
  let required: bigint;
  try {
    authorised = BigInt(chosen.amount);
    required = BigInt(match.amount);
  } catch {
    return { ok: false, reason: X402_ERROR.INVALID_AMOUNT, detail: "amount is not an integer string" };
  }

  // `exact` settles the signed value verbatim, so anything but equality will be
  // rejected by the facilitator anyway. `upto` only needs enough headroom.
  const amountOk = match.scheme === "upto" ? authorised >= required : authorised === required;
  if (!amountOk) {
    return {
      ok: false,
      reason: X402_ERROR.INVALID_AMOUNT,
      detail: `authorised ${chosen.amount} does not satisfy required ${match.amount}`,
    };
  }

  return { ok: true, requirements: match };
}

/** The settlement-time copy of the requirements, carrying the amount to charge. */
export function withSettlementAmount(requirements: PaymentRequirements, amount: string): PaymentRequirements {
  return { ...requirements, amount };
}
