import type { Env } from "../env.js";

const CH_BASE = "https://api.company-information.service.gov.uk";

export type ChErrorCode =
  | "not_configured"
  | "unauthorised"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "invalid_response";

export class CompaniesHouseError extends Error {
  constructor(
    readonly code: ChErrorCode,
    message: string,
    readonly status: number,
    /** Whether the caller should be charged for a call that ended this way. */
    readonly billable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "CompaniesHouseError";
  }
}

export interface ChClient {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  /** Upstream requests actually issued (cache hits excluded), for metered pricing. */
  readonly requestCount: number;
}

export interface ChClientOptions {
  /** Seconds to hold a response in the edge cache. Companies House data moves slowly. */
  cacheTtlSeconds?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Thin, honest wrapper: no data is retained beyond a short edge cache, and every
 * response is passed through to the caller with Companies House named as the
 * source. See docs/LICENSING.md for why that matters.
 */
export function createChClient(env: Env, options: ChClientOptions = {}): ChClient {
  const doFetch = options.fetchImpl ?? fetch;
  const ttl = options.cacheTtlSeconds ?? 300;
  let requestCount = 0;

  async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const apiKey = env.CH_API_KEY?.trim();
    if (!apiKey) {
      throw new CompaniesHouseError("not_configured", "CH_API_KEY is not set on this deployment.", 503, false);
    }

    const url = new URL(path, CH_BASE);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cache = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return (await hit.json()) as T;
    }

    requestCount += 1;
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        headers: {
          // Companies House uses HTTP Basic with the key as the username and an
          // empty password.
          authorization: `Basic ${btoa(`${apiKey}:`)}`,
          accept: "application/json",
          "user-agent": "uk-corporate-mcp/0.1 (+https://github.com/lcl27/simphost)",
        },
      });
    } catch (cause) {
      throw new CompaniesHouseError("upstream_error", `Companies House unreachable: ${(cause as Error).message}`, 502, false);
    }

    if (response.status === 401 || response.status === 403) {
      throw new CompaniesHouseError("unauthorised", "Companies House rejected the API key for this deployment.", 503, false);
    }
    if (response.status === 404) {
      throw new CompaniesHouseError("not_found", `Companies House has no record at ${path}.`, 404, false);
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      throw new CompaniesHouseError(
        "rate_limited",
        "Companies House rate limit reached; retry shortly.",
        429,
        false,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }
    if (!response.ok) {
      throw new CompaniesHouseError("upstream_error", `Companies House returned ${response.status}.`, 502, false);
    }

    const text = await response.text();
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new CompaniesHouseError("invalid_response", "Companies House returned a non-JSON body.", 502, false);
    }

    if (cache) {
      const cacheable = new Response(text, {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
      });
      await cache.put(cacheKey, cacheable);
    }
    return parsed;
  }

  return {
    get,
    get requestCount() {
      return requestCount;
    },
  };
}

const COMPANY_NUMBER_SHAPE = /^([A-Z]{0,2})([0-9]+)$/;

export class InvalidCompanyNumberError extends Error {
  constructor(readonly input: string) {
    super(
      `"${input}" is not a recognisable UK company number. Expected eight characters: eight digits (e.g. 00445790), ` +
        `or a two-letter prefix and six digits (e.g. SC090312, NI016341, OC301540).`,
    );
    this.name = "InvalidCompanyNumberError";
  }
}

/**
 * Agents pass company numbers in whatever form they found them — "1234567",
 * "SC 090312", "oc301540". Companies House accepts only the canonical
 * eight-character form, so normalise rather than reject.
 */
export function normaliseCompanyNumber(input: string): string {
  if (typeof input !== "string") throw new InvalidCompanyNumberError(String(input));
  const cleaned = input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned.length === 0 || cleaned.length > 8) throw new InvalidCompanyNumberError(input);

  const parts = COMPANY_NUMBER_SHAPE.exec(cleaned);
  if (!parts) throw new InvalidCompanyNumberError(input);

  const prefix = parts[1] ?? "";
  const digits = parts[2] ?? "";
  const width = 8 - prefix.length;
  if (digits.length > width) throw new InvalidCompanyNumberError(input);

  return `${prefix}${digits.padStart(width, "0")}`;
}
