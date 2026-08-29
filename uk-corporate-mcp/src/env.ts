export interface Env {
  /** Companies House REST API key (free, from developer.company-information.service.gov.uk). */
  CH_API_KEY?: string;

  /** Canonical public origin, used to build x402 resource URLs. */
  PUBLIC_BASE_URL?: string;

  /** Set to "false" to serve the tools free — useful while shaking out a deploy. */
  X402_ENABLED?: string;
  /** CAIP-2 network identifier. Default: Base Sepolia. */
  X402_NETWORK?: string;
  /** Payment asset contract address. */
  X402_ASSET?: string;
  X402_ASSET_NAME?: string;
  /** EIP-712 domain version of the asset, needed by the exact scheme. */
  X402_ASSET_VERSION?: string;
  X402_ASSET_DECIMALS?: string;
  /** Wallet that receives settlement. */
  X402_PAY_TO?: string;
  X402_FACILITATOR_URL?: string;
  /** Bearer token, if the facilitator requires one (the CDP facilitator does). */
  X402_FACILITATOR_TOKEN?: string;
  /** Comma-separated schemes to advertise. Default: "exact,upto". */
  X402_SCHEMES?: string;

  /** Guards /admin/usage. */
  ADMIN_TOKEN?: string;

  /** Per-call usage ledger. */
  METER?: KVNamespace;
  /** Optional Analytics Engine dataset; used in addition to METER when bound. */
  ANALYTICS?: AnalyticsEngineDataset;
}

export interface ResolvedConfig {
  paymentsEnabled: boolean;
  baseUrl: string;
  network: string;
  asset: string;
  assetName: string;
  assetVersion: string;
  assetDecimals: number;
  payTo: string;
  facilitatorUrl: string;
  facilitatorToken?: string;
  schemes: string[];
  maxTimeoutSeconds: number;
}

const DEFAULTS = {
  // Base Sepolia and its USDC. Deploying to mainnet means overriding both
  // X402_NETWORK (eip155:8453) and X402_ASSET in wrangler.jsonc.
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  assetName: "USDC",
  assetVersion: "2",
  assetDecimals: 6,
  facilitatorUrl: "https://x402.org/facilitator",
  maxTimeoutSeconds: 120,
};

/**
 * Payments are only advertised when the deployment is actually able to take
 * money: a missing payTo would otherwise produce a 402 no client can satisfy.
 */
export function resolveConfig(env: Env, request?: Request): ResolvedConfig {
  const payTo = env.X402_PAY_TO?.trim() ?? "";
  const enabledFlag = (env.X402_ENABLED ?? "true").toLowerCase() !== "false";

  let baseUrl = env.PUBLIC_BASE_URL?.trim() ?? "";
  if (!baseUrl && request) baseUrl = new URL(request.url).origin;
  baseUrl = baseUrl.replace(/\/+$/, "");

  const decimals = Number.parseInt(env.X402_ASSET_DECIMALS ?? "", 10);

  return {
    paymentsEnabled: enabledFlag && payTo.length > 0,
    baseUrl,
    network: env.X402_NETWORK?.trim() || DEFAULTS.network,
    asset: env.X402_ASSET?.trim() || DEFAULTS.asset,
    assetName: env.X402_ASSET_NAME?.trim() || DEFAULTS.assetName,
    assetVersion: env.X402_ASSET_VERSION?.trim() || DEFAULTS.assetVersion,
    assetDecimals: Number.isFinite(decimals) ? decimals : DEFAULTS.assetDecimals,
    payTo,
    facilitatorUrl: (env.X402_FACILITATOR_URL?.trim() || DEFAULTS.facilitatorUrl).replace(/\/+$/, ""),
    facilitatorToken: env.X402_FACILITATOR_TOKEN?.trim() || undefined,
    schemes: (env.X402_SCHEMES?.trim() || "exact,upto")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxTimeoutSeconds: DEFAULTS.maxTimeoutSeconds,
  };
}
