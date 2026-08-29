import {
  CAPITAL_DATA_LIMITS,
  extractCapitalEvents,
  latestIssuedCapital,
  type CapitalEvent,
} from "../companies-house/capital.js";
import { InvalidCompanyNumberError, normaliseCompanyNumber } from "../companies-house/client.js";
import { buildCapitalWorkbook, workbookToCsv, type ControlRow } from "../spreadsheet/capital-workbook.js";
import { buildXlsx, toBase64 } from "../spreadsheet/xlsx.js";
import type { HandlerOutcome } from "../x402/gate.js";
import { filingHistoryTool } from "./filing-history.js";
import { pscVerificationTool } from "./psc-verification.js";
import {
  SOURCE_ATTRIBUTION,
  ToolArgumentError,
  optionalBoolean,
  requireString,
  type ToolContext,
  type ToolDefinition,
} from "./types.js";

/**
 * Assembling this costs more upstream work than either underlying tool: the
 * whole filing history has to be paged to catch capital events from years back,
 * and the PSC register is read on top. Priced accordingly, and metered so that a
 * short history costs less than a long one.
 */
const PRICE = {
  baseMicros: 5_000, // USD 0.005
  ceilingMicros: 25_000, // USD 0.025
  perExtraUpstreamMicros: 2_000, // USD 0.002
};

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface CapitalFile {
  filename: string;
  content_type: string;
  /** Present for `xlsx`. */
  base64?: string;
  /** Present for `csv`. */
  text?: string;
}

function controlRows(pscPayload: Record<string, unknown> | undefined): ControlRow[] {
  const people = (pscPayload?.["persons_with_significant_control"] ?? []) as Array<Record<string, unknown>>;
  const rows: ControlRow[] = [];

  for (const person of people) {
    const verification = (person["identity_verification"] ?? {}) as Record<string, unknown>;
    const natures = (person["natures_of_control"] ?? []) as Array<Record<string, unknown>>;
    const base: ControlRow = {
      name: person["name"] as string | undefined,
      kind: person["kind"] as string | undefined,
      notified_on: person["notified_on"] as string | undefined,
      ceased_on: person["ceased_on"] as string | undefined,
      verification_status: verification["status"] as string | undefined,
      verified_on: verification["identity_verified_on"] as string | undefined,
    };

    if (natures.length === 0) {
      rows.push(base);
      continue;
    }
    // One row per nature of control: a person holding both shares and votes is
    // two distinct notifications, and flattening them loses that.
    for (const nature of natures) {
      rows.push({
        ...base,
        right: nature["right"] as string | undefined,
        band: (nature["band"] ?? null) as string | null,
        held_via: nature["held_via"] as string | undefined,
        scope: nature["scope"] as string | undefined,
      });
    }
  }

  return rows;
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

  const rawFormat = args["format"];
  const format = rawFormat === undefined || rawFormat === null || rawFormat === "" ? "json" : String(rawFormat).toLowerCase();
  if (!["json", "xlsx", "csv"].includes(format)) {
    throw new ToolArgumentError(`"format" must be one of json, xlsx, csv.`);
  }
  const includeControl = optionalBoolean(args, "include_control", true);

  // The whole history is paged rather than filtered by category: a statement of
  // capital also arrives with an incorporation and with confirmation statements,
  // so filtering on the capital category alone would miss events.
  const filingOutcome = await filingHistoryTool.run({ company_number: companyNumber, fetch_all: true }, ctx);
  const filingValue = filingOutcome.value as Record<string, unknown>;
  if (filingValue["error"]) {
    return { value: filingValue, upstreamRequests: ctx.client.requestCount, billable: filingOutcome.billable };
  }

  const filings = (filingValue["items"] ?? []) as Array<Record<string, unknown>>;
  const paging = (filingValue["paging"] ?? {}) as Record<string, unknown>;
  const events: CapitalEvent[] = extractCapitalEvents(filings as never);
  const issuedCapital = latestIssuedCapital(events);

  let pscValue: Record<string, unknown> | undefined;
  if (includeControl) {
    const pscOutcome = await pscVerificationTool.run(
      { company_number: companyNumber, include_ceased: true, include_statements: true },
      ctx,
    );
    const value = pscOutcome.value as Record<string, unknown>;
    // A missing PSC register is not a reason to withhold the capital structure.
    if (!value["error"]) pscValue = value;
  }

  const control = controlRows(pscValue);
  const controlAssessment = (pscValue?.["summary"] as Record<string, unknown> | undefined)?.["assessment"] as string | undefined;
  const retrievedAt = new Date().toISOString();

  const sheets = buildCapitalWorkbook({
    companyNumber,
    retrievedAt,
    issuedCapital,
    events,
    control,
    controlAssessment,
    filingsExamined: filings.length,
    historyComplete: paging["complete"] === true,
  });

  const model: Record<string, unknown> = {
    source: SOURCE_ATTRIBUTION,
    retrieved_at: retrievedAt,
    company_number: companyNumber,
    basis: {
      filings_examined: filings.length,
      filing_history_complete: paging["complete"] === true,
      capital_events_found: events.length,
      control_included: includeControl && pscValue !== undefined,
    },
    issued_share_capital: issuedCapital,
    capital_events: events,
    control,
    control_assessment: controlAssessment,
    limits: CAPITAL_DATA_LIMITS,
  };

  if (format === "xlsx") {
    model["file"] = {
      filename: `${companyNumber}-capital-structure.xlsx`,
      content_type: XLSX_CONTENT_TYPE,
      base64: toBase64(buildXlsx(sheets)),
    } satisfies CapitalFile;
  } else if (format === "csv") {
    model["file"] = {
      filename: `${companyNumber}-capital-structure.csv`,
      content_type: "text/csv; charset=utf-8",
      text: workbookToCsv(sheets),
    } satisfies CapitalFile;
  } else {
    // The sheet model is returned so a caller can render its own spreadsheet
    // without paying for a second call in another format.
    model["workbook"] = {
      sheets: sheets.map((sheet) => ({
        name: sheet.name,
        preamble: sheet.preamble ?? [],
        columns: sheet.columns.map((c) => c.header),
        rows: sheet.rows,
      })),
    };
  }

  return { value: model, upstreamRequests: ctx.client.requestCount, billable: true };
}

export const capitalStructureTool: ToolDefinition = {
  name: "get_capital_structure",
  title: "UK company capital structure workbook",
  description:
    "Build a UK statement-of-capital workbook for a company from its Companies House filing history: the latest " +
    "reported aggregate nominal capital per currency, the full capital history, every capital event classified " +
    "(allotment, subdivision, consolidation, reduction, redenomination, purchase of own shares, treasury cancellation, " +
    "variation of class rights) and marked as increasing, decreasing or merely restructuring issued capital, plus the " +
    "PSC control position. Returns the structured model as JSON, or a ready-made .xlsx or .csv. This is a UK " +
    "Companies Act statement of capital, not a US venture cap table: it has no concept of preferred series, " +
    "liquidation preferences or option pools. Source: Companies House public data API.",
  inputSchema: {
    type: "object",
    properties: {
      company_number: {
        type: "string",
        description: "UK company number, in any common form; normalised to the canonical eight-character number.",
      },
      format: {
        type: "string",
        enum: ["json", "xlsx", "csv"],
        default: "json",
        description:
          "json returns the structured model plus a sheet-by-sheet workbook model you can render yourself. " +
          "xlsx returns a base64 .xlsx file. csv returns all sheets as one CSV.",
      },
      include_control: {
        type: "boolean",
        default: true,
        description:
          "Include the PSC control sheet. Costs extra upstream requests, and so more under the metered 'upto' scheme.",
      },
    },
    required: ["company_number"],
    additionalProperties: false,
  },
  price: PRICE,
  run,
};
