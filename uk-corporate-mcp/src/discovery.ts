import { resolveConfig, type Env } from "./env.js";
import { HTTP_ROUTES } from "./http-api.js";
import { SERVER_INFO } from "./mcp/server.js";
import { TOOLS } from "./tools/registry.js";
import { microsToAtomic, microsToUsdString } from "./x402/pricing.js";
import { buildAccepts } from "./x402/requirements.js";

/**
 * The discovery surface.
 *
 * The premise of this service is that the buyer does not have to be found or
 * pitched, only discovered and priced. That puts unusual weight on these two
 * documents: they are the entire sales motion.
 */
export async function serviceCard(env: Env, request: Request) {
  const config = resolveConfig(env, request);
  return {
    service: SERVER_INFO,
    summary:
      "Metered read-only access to UK corporate reference data assembled from the Companies House public data API: " +
      "classified filing histories with a derived chronology, and PSC registers with identity-verification status resolved.",
    endpoints: {
      mcp: `${config.baseUrl}/mcp`,
      http: Object.fromEntries(Object.keys(HTTP_ROUTES).map((path) => [HTTP_ROUTES[path]!, `${config.baseUrl}${path}`])),
      discovery: `${config.baseUrl}/.well-known/x402`,
      health: `${config.baseUrl}/health`,
    },
    payment: config.paymentsEnabled
      ? {
          protocol: "x402",
          version: 2,
          network: config.network,
          asset: config.asset,
          asset_name: config.assetName,
          schemes: config.schemes,
          facilitator: config.facilitatorUrl,
          free: ["initialize", "tools/list", "ping"],
        }
      : { protocol: "x402", enabled: false, note: "This deployment is serving the tools free." },
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      input_schema: tool.inputSchema,
      price: {
        base_usd: microsToUsdString(tool.price.baseMicros),
        ceiling_usd: microsToUsdString(tool.price.ceilingMicros),
        base_atomic: microsToAtomic(tool.price.baseMicros, config.assetDecimals),
        ceiling_atomic: microsToAtomic(tool.price.ceilingMicros, config.assetDecimals),
      },
    })),
    data: {
      source: "Companies House public data API",
      licence: "Contains public sector information licensed under the Open Government Licence v3.0.",
      scope:
        "Open sources only. No LSEG RNS content, no London Stock Exchange rule text, and no other licensed material is " +
        "served by this endpoint.",
    },
    billing_policy: [
      "Discovery is free: initialize, tools/list and ping never require payment.",
      "A call is settled only after the tool has produced a result.",
      "Bad arguments, unknown company numbers and upstream faults are not charged for.",
    ],
  };
}

/** Shaped like an x402 Bazaar resource listing so an indexer can ingest it directly. */
export async function discoveryDocument(env: Env, request: Request) {
  const config = resolveConfig(env, request);
  const lastUpdated = Math.floor(Date.now() / 1000);
  const items = [];

  for (const [path, toolName] of Object.entries(HTTP_ROUTES)) {
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) continue;
    const accepts = config.paymentsEnabled ? await buildAccepts({ config, price: tool.price }) : [];
    items.push({
      resource: `${config.baseUrl}${path}`,
      type: "http",
      x402Version: 2,
      accepts,
      lastUpdated,
      metadata: {
        category: "reference-data",
        jurisdiction: "GB",
        provider: SERVER_INFO.name,
        tool: tool.name,
        title: tool.title,
        description: tool.description,
        input_schema: tool.inputSchema,
        source: "Companies House public data API",
      },
    });
  }

  for (const tool of TOOLS) {
    const accepts = config.paymentsEnabled ? await buildAccepts({ config, price: tool.price }) : [];
    items.push({
      resource: `${config.baseUrl}/mcp#${tool.name}`,
      type: "mcp",
      x402Version: 2,
      accepts,
      lastUpdated,
      metadata: {
        category: "reference-data",
        jurisdiction: "GB",
        provider: SERVER_INFO.name,
        mcp_endpoint: `${config.baseUrl}/mcp`,
        tool: tool.name,
        title: tool.title,
        description: tool.description,
        input_schema: tool.inputSchema,
        source: "Companies House public data API",
      },
    });
  }

  return { x402Version: 2, items, pagination: { limit: items.length, offset: 0, total: items.length } };
}
