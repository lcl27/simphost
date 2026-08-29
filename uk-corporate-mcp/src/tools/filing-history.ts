import { CompaniesHouseError, normaliseCompanyNumber, InvalidCompanyNumberError } from "../companies-house/client.js";
import { classifyFiling, FILING_GROUPS, type FilingGroup, type Significance } from "../companies-house/taxonomy.js";
import { DEFAULT_PRICE } from "../x402/pricing.js";
import type { HandlerOutcome } from "../x402/gate.js";
import {
  SOURCE_ATTRIBUTION,
  ToolArgumentError,
  optionalBoolean,
  optionalInteger,
  optionalStringArray,
  requireString,
  type ToolContext,
  type ToolDefinition,
} from "./types.js";

const MAX_PAGES = 5;
const PAGE_SIZE = 100;

interface ChFilingItem {
  transaction_id?: string;
  barcode?: string;
  type?: string;
  date?: string;
  action_date?: string;
  category?: string;
  subcategory?: string | string[];
  description?: string;
  description_values?: Record<string, unknown>;
  paper_filed?: boolean;
  pages?: number;
  links?: { self?: string; document_metadata?: string };
  associated_filings?: unknown[];
  resolutions?: unknown[];
}

interface ChFilingHistory {
  etag?: string;
  filing_history_status?: string;
  items?: ChFilingItem[];
  items_per_page?: number;
  start_index?: number;
  total_count?: number;
}

interface NormalisedFiling {
  transaction_id?: string;
  date?: string;
  action_date?: string;
  form_type?: string;
  description_code?: string;
  description_values?: Record<string, unknown>;
  companies_house_category?: string;
  group: FilingGroup;
  group_label: string;
  significance: Significance;
  label: string;
  paper_filed: boolean;
  pages?: number;
  document_metadata_url?: string;
}

function normaliseItem(item: ChFilingItem): NormalisedFiling {
  const classification = classifyFiling(item.description, item.category);
  const normalised: NormalisedFiling = {
    transaction_id: item.transaction_id,
    date: item.date,
    action_date: item.action_date,
    form_type: item.type,
    description_code: item.description,
    description_values: item.description_values,
    companies_house_category: item.category,
    group: classification.group,
    group_label: FILING_GROUPS[classification.group],
    significance: classification.significance,
    label: classification.label,
    paper_filed: item.paper_filed === true,
    pages: item.pages,
    document_metadata_url: item.links?.document_metadata,
  };
  return normalised;
}

function yearOf(date: string | undefined): string | null {
  if (!date || date.length < 4) return null;
  const year = date.slice(0, 4);
  return /^\d{4}$/.test(year) ? year : null;
}

function daysBetween(earlier: string, later: string): number | undefined {
  const a = Date.parse(earlier);
  const b = Date.parse(later);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return Math.round((b - a) / 86_400_000);
}

export interface Chronology {
  first_filing_date?: string;
  last_filing_date?: string;
  span_days?: number;
  counts_by_group: Record<string, number>;
  counts_by_significance: Record<Significance, number>;
  filings_by_year: Record<string, number>;
  latest_accounts?: NormalisedFiling;
  latest_confirmation_statement?: NormalisedFiling;
  material_events: NormalisedFiling[];
  /** Only true when every page was retrieved; otherwise the chronology is partial. */
  derived_from_complete_history: boolean;
}

/**
 * The chronology is the part a caller cannot get from Companies House directly:
 * the raw endpoint returns a flat, paginated list of form codes, and the
 * question being asked of it is almost always shaped like "when did this company
 * last do anything that matters".
 */
export function buildChronology(items: NormalisedFiling[], complete: boolean): Chronology {
  const dated = items.filter((i) => typeof i.date === "string" && i.date.length > 0);
  const sorted = [...dated].sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : 0));

  const countsByGroup: Record<string, number> = {};
  const countsBySignificance: Record<Significance, number> = { routine: 0, notable: 0, material: 0 };
  const filingsByYear: Record<string, number> = {};

  for (const item of items) {
    countsByGroup[item.group] = (countsByGroup[item.group] ?? 0) + 1;
    countsBySignificance[item.significance] += 1;
    const year = yearOf(item.date);
    if (year) filingsByYear[year] = (filingsByYear[year] ?? 0) + 1;
  }

  const newest = sorted[0];
  const oldest = sorted[sorted.length - 1];

  const chronology: Chronology = {
    first_filing_date: oldest?.date,
    last_filing_date: newest?.date,
    counts_by_group: countsByGroup,
    counts_by_significance: countsBySignificance,
    filings_by_year: filingsByYear,
    latest_accounts: sorted.find((i) => i.group === "accounts"),
    latest_confirmation_statement: sorted.find((i) => i.group === "confirmation"),
    material_events: sorted.filter((i) => i.significance === "material").slice(0, 25),
    derived_from_complete_history: complete,
  };

  if (oldest?.date && newest?.date) {
    chronology.span_days = daysBetween(oldest.date, newest.date);
  }
  return chronology;
}

async function run(args: Record<string, unknown>, ctx: ToolContext): Promise<HandlerOutcome<unknown>> {
  let companyNumber: string;
  try {
    companyNumber = normaliseCompanyNumber(requireString(args, "company_number"));
  } catch (cause) {
    if (cause instanceof InvalidCompanyNumberError || cause instanceof ToolArgumentError) {
      return { value: { error: "invalid_argument", message: cause.message }, upstreamRequests: 0, billable: false };
    }
    throw cause;
  }

  const categories = optionalStringArray(args, "category");
  const fetchAll = optionalBoolean(args, "fetch_all", false);
  const itemsPerPage = optionalInteger(args, "items_per_page", fetchAll ? PAGE_SIZE : 50, 1, PAGE_SIZE);
  const startIndex = optionalInteger(args, "start_index", 0, 0, 100_000);

  const path = `/company/${companyNumber}/filing-history`;
  const baseParams: Record<string, string | number | undefined> = {
    items_per_page: itemsPerPage,
    start_index: startIndex,
  };
  // Companies House takes `category` as a repeated parameter; the client builds
  // a single query string, so join and let the API split it.
  if (categories) baseParams["category"] = categories.join(",");

  const collected: ChFilingItem[] = [];
  let page: ChFilingHistory;
  try {
    page = await ctx.client.get<ChFilingHistory>(path, baseParams);
  } catch (cause) {
    return toolErrorOutcome(cause, ctx);
  }

  collected.push(...(page.items ?? []));
  const totalCount = page.total_count ?? collected.length;
  let complete = startIndex === 0 && collected.length >= totalCount;

  if (fetchAll && !complete) {
    let cursor = startIndex + collected.length;
    for (let pageNumber = 1; pageNumber < MAX_PAGES && cursor < totalCount; pageNumber += 1) {
      try {
        const next = await ctx.client.get<ChFilingHistory>(path, { ...baseParams, start_index: cursor });
        const items = next.items ?? [];
        if (items.length === 0) break;
        collected.push(...items);
        cursor += items.length;
      } catch (cause) {
        // A partial history is still worth returning; the flag below says so.
        if (cause instanceof CompaniesHouseError && cause.code === "rate_limited") break;
        return toolErrorOutcome(cause, ctx);
      }
    }
    complete = startIndex === 0 && collected.length >= totalCount;
  }

  const items = collected.map(normaliseItem);

  return {
    value: {
      source: SOURCE_ATTRIBUTION,
      retrieved_at: new Date().toISOString(),
      company_number: companyNumber,
      filing_history_status: page.filing_history_status,
      paging: {
        start_index: startIndex,
        items_per_page: itemsPerPage,
        total_count: totalCount,
        returned: items.length,
        complete,
        truncated_at_page_limit: fetchAll && !complete && collected.length > 0,
      },
      chronology: buildChronology(items, complete),
      items,
    },
    upstreamRequests: ctx.client.requestCount,
    billable: true,
  };
}

/** Upstream faults and unknown company numbers are surfaced, not charged for. */
export function toolErrorOutcome(cause: unknown, ctx: ToolContext): HandlerOutcome<unknown> {
  if (cause instanceof CompaniesHouseError) {
    return {
      value: {
        error: cause.code,
        message: cause.message,
        retry_after_seconds: cause.retryAfterSeconds,
      },
      upstreamRequests: ctx.client.requestCount,
      billable: cause.billable,
    };
  }
  throw cause;
}

export const filingHistoryTool: ToolDefinition = {
  name: "get_company_filing_history",
  title: "UK company filing history and chronology",
  description:
    "Return the Companies House filing history for a UK company, with each filing classified into a stable group " +
    "(accounts, confirmation, officers, control, capital, charges, distress, formation, governance, registered-details) " +
    "and a significance rating, plus a derived chronology: first and last filing, filings per year, counts per group, " +
    "the latest accounts and confirmation statement, and every material event (insolvency, strike-off, charges, capital " +
    "reductions, restorations). Source: Companies House public data API.",
  inputSchema: {
    type: "object",
    properties: {
      company_number: {
        type: "string",
        description:
          "UK company number. Accepts loose input: '1234567', 'SC 090312' and 'oc301540' are all normalised to the " +
          "canonical eight-character form.",
      },
      category: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional Companies House filing categories to restrict to, e.g. ['accounts','officers','mortgage']. " +
          "Omit for all categories.",
      },
      fetch_all: {
        type: "boolean",
        default: false,
        description:
          `Page through the whole history (up to ${MAX_PAGES * PAGE_SIZE} filings) so the chronology is complete. ` +
          "Costs more under the metered 'upto' scheme: one increment per extra page.",
      },
      items_per_page: { type: "integer", minimum: 1, maximum: PAGE_SIZE, default: 50 },
      start_index: { type: "integer", minimum: 0, default: 0 },
    },
    required: ["company_number"],
    additionalProperties: false,
  },
  price: DEFAULT_PRICE,
  run,
};
