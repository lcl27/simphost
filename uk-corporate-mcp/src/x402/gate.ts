import type { ResolvedConfig } from "../env.js";
import { meteredMicros, microsToAtomic, type ToolPrice } from "./pricing.js";
import { settle, verify, FacilitatorError } from "./facilitator.js";
import { buildAccepts, selectRequirements, withSettlementAmount } from "./requirements.js";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo, SettleResponse } from "./types.js";

/** What a tool handler reports back about the work it did. */
export interface HandlerOutcome<T> {
  value: T;
  /** Upstream Companies House requests made; drives metered pricing. */
  upstreamRequests: number;
  /**
   * A call that failed for the caller's own reasons — an unknown company
   * number, a malformed argument — is not charged for. Agents that get billed
   * for 404s stop calling.
   */
  billable: boolean;
}

export type GateResult<T> =
  | { kind: "ok"; value: T; settlement?: SettleResponse; charged: string; payer?: string }
  | { kind: "free"; value: T }
  | { kind: "unbilled"; value: T; payer?: string }
  | { kind: "payment-required"; paymentRequired: PaymentRequired };

export interface GateInput<T> {
  config: ResolvedConfig;
  price: ToolPrice;
  resource: ResourceInfo;
  payload: PaymentPayload | null;
  run: () => Promise<HandlerOutcome<T>>;
}

async function required(
  config: ResolvedConfig,
  price: ToolPrice,
  resource: ResourceInfo,
  error: string,
): Promise<PaymentRequired> {
  return { x402Version: 2, error, resource, accepts: await buildAccepts({ config, price }) };
}

/**
 * Runs a priced handler behind the x402 payment flow, transport-agnostically.
 *
 * Settlement happens *after* the handler succeeds, so a caller is never charged
 * for a response it did not get. The window between verify and settle is the
 * facilitator's to close; we keep it to the length of one upstream call.
 */
export async function gate<T>({ config, price, resource, payload, run }: GateInput<T>): Promise<GateResult<T>> {
  if (!config.paymentsEnabled) {
    const outcome = await run();
    return { kind: "free", value: outcome.value };
  }

  if (!payload) {
    return { kind: "payment-required", paymentRequired: await required(config, price, resource, "Payment is required to call this tool.") };
  }

  const accepts = await buildAccepts({ config, price });
  if (accepts.length === 0) {
    return {
      kind: "payment-required",
      paymentRequired: await required(config, price, resource, "No payment method is currently settleable for this resource."),
    };
  }

  const match = selectRequirements(accepts, payload);
  if (!match.ok) {
    return {
      kind: "payment-required",
      paymentRequired: { x402Version: 2, error: `${match.reason}: ${match.detail}`, resource, accepts },
    };
  }

  let payer: string | undefined;
  try {
    const verification = await verify(payload, match.requirements, config);
    payer = verification.payer;
    if (!verification.isValid) {
      return {
        kind: "payment-required",
        paymentRequired: {
          x402Version: 2,
          error: `Payment verification failed: ${verification.invalidReason ?? "unknown reason"}`,
          resource,
          accepts,
        },
      };
    }
  } catch (cause) {
    const detail = cause instanceof FacilitatorError ? cause.message : String(cause);
    return {
      kind: "payment-required",
      paymentRequired: { x402Version: 2, error: `unexpected_verify_error: ${detail}`, resource, accepts },
    };
  }

  const outcome = await run();

  if (!outcome.billable) {
    return { kind: "unbilled", value: outcome.value, payer };
  }

  const amount = settlementAmount(match.requirements, price, config, outcome.upstreamRequests);
  try {
    const settlement = await settle(payload, withSettlementAmount(match.requirements, amount), config);
    if (!settlement.success) {
      return {
        kind: "payment-required",
        paymentRequired: {
          x402Version: 2,
          error: `Settlement failed: ${settlement.errorReason ?? "unknown reason"}`,
          resource,
          accepts,
        },
      };
    }
    return { kind: "ok", value: outcome.value, settlement, charged: settlement.amount ?? amount, payer: settlement.payer ?? payer };
  } catch (cause) {
    const detail = cause instanceof FacilitatorError ? cause.message : String(cause);
    return {
      kind: "payment-required",
      paymentRequired: { x402Version: 2, error: `unexpected_settle_error: ${detail}`, resource, accepts },
    };
  }
}

export function settlementAmount(
  requirements: PaymentRequirements,
  price: ToolPrice,
  config: ResolvedConfig,
  upstreamRequests: number,
): string {
  if (requirements.scheme !== "upto") return microsToAtomic(price.baseMicros, config.assetDecimals);
  return microsToAtomic(meteredMicros(price, upstreamRequests), config.assetDecimals);
}
