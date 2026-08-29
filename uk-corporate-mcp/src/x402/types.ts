/**
 * x402 v2 core types.
 *
 * Field names follow specs/x402-specification-v2.md in the x402 repository:
 * note that v2 renamed `maxAmountRequired` to `amount`, moved resource metadata
 * out of PaymentRequirements into a sibling `resource` object, and switched
 * `network` to CAIP-2 form (`eip155:8453`) from v1's bare names (`base`).
 */

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirements {
  /** Payment scheme identifier: "exact" (fixed price) or "upto" (metered ceiling). */
  scheme: string;
  /** CAIP-2 network identifier, e.g. "eip155:8453". */
  network: string;
  /**
   * Atomic units of `asset`.
   *
   * Phase-dependent for the `upto` scheme: the authorised ceiling when sent to
   * /verify, the amount actually being charged when sent to /settle.
   */
  amount: string;
  /** Token contract address (EVM) or ISO 4217 code for fiat. */
  asset: string;
  /** Recipient address. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  /** The PaymentRequirements the client chose to satisfy. */
  accepted: PaymentRequirements;
  /** Scheme-specific authorisation data (EIP-3009 for exact, Permit2 for upto). */
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  /** Present on the `upto` scheme: the amount actually settled. */
  amount?: string;
  extensions?: Record<string, unknown>;
}

/** Error codes from section 9 of the v2 specification that we emit ourselves. */
export const X402_ERROR = {
  INVALID_SCHEME: "invalid_scheme",
  INVALID_NETWORK: "invalid_network",
  INVALID_AMOUNT: "invalid_amount",
  INVALID_PAYLOAD: "invalid_payload",
  INVALID_X402_VERSION: "invalid_x402_version",
  UNEXPECTED_VERIFY_ERROR: "unexpected_verify_error",
  UNEXPECTED_SETTLE_ERROR: "unexpected_settle_error",
} as const;
