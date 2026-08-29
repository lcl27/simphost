import type { ResolvedConfig } from "../env.js";

/**
 * Prices are held as integer USD micros (1e-6 USD) rather than floats, so that
 * conversion to atomic token units is exact. For a 6-decimal stablecoin such as
 * USDC the two are numerically identical; the scaling below covers assets that
 * are not.
 */
export interface ToolPrice {
  /** Charged for a call that needs a single upstream Companies House request. */
  baseMicros: number;
  /** Ceiling authorised under the `upto` scheme. */
  ceilingMicros: number;
  /** Added per additional upstream request, under `upto` only. */
  perExtraUpstreamMicros: number;
}

export const DEFAULT_PRICE: ToolPrice = {
  baseMicros: 2_000, // USD 0.002
  ceilingMicros: 10_000, // USD 0.010
  perExtraUpstreamMicros: 1_000, // USD 0.001
};

export function microsToAtomic(micros: number, decimals: number): string {
  if (!Number.isFinite(micros) || micros < 0) throw new RangeError("micros must be a non-negative number");
  const whole = BigInt(Math.round(micros));
  if (decimals >= 6) return (whole * 10n ** BigInt(decimals - 6)).toString();

  // Coarser than a micro-dollar: round up rather than down, so that a price
  // below one atomic unit is charged as one atomic unit instead of silently
  // becoming free.
  const divisor = 10n ** BigInt(6 - decimals);
  const quotient = whole / divisor;
  return (whole % divisor === 0n ? quotient : quotient + 1n).toString();
}

export function microsToUsdString(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * What the `upto` scheme should actually settle, given how much upstream work
 * the call turned out to need. `exact` ignores this and always settles base.
 */
export function meteredMicros(price: ToolPrice, upstreamRequests: number): number {
  const extra = Math.max(0, upstreamRequests - 1);
  return Math.min(price.ceilingMicros, price.baseMicros + extra * price.perExtraUpstreamMicros);
}

export function priceForScheme(price: ToolPrice, scheme: string, config: ResolvedConfig): string {
  const micros = scheme === "upto" ? price.ceilingMicros : price.baseMicros;
  return microsToAtomic(micros, config.assetDecimals);
}
