import { CompaniesHouseError, InvalidCompanyNumberError, normaliseCompanyNumber } from "../companies-house/client.js";
import {
  describeStatement,
  kindIsIndividual,
  kindIsSuperSecure,
  parseNatureOfControl,
  type NatureOfControl,
} from "../companies-house/psc-taxonomy.js";
import { DEFAULT_PRICE } from "../x402/pricing.js";
import type { HandlerOutcome } from "../x402/gate.js";
import { toolErrorOutcome } from "./filing-history.js";
import {
  SOURCE_ATTRIBUTION,
  ToolArgumentError,
  optionalBoolean,
  requireString,
  type ToolContext,
  type ToolDefinition,
} from "./types.js";

/**
 * `not_reported` is deliberately distinct from `unverified`. Companies House
 * publishes verification data progressively, so the absence of a date is not
 * evidence that a person is unverified — and a compliance caller that treats it
 * as such will be wrong. Anything this service cannot establish is reported as
 * unknown rather than resolved to a convenient default.
 */
export type VerificationStatus = "verified" | "unverified" | "not_reported" | "protected" | "ceased";

interface ChPscItem {
  kind?: string;
  name?: string;
  name_elements?: Record<string, unknown>;
  nationality?: string;
  country_of_residence?: string;
  date_of_birth?: { month?: number; year?: number };
  natures_of_control?: string[];
  notified_on?: string;
  ceased_on?: string;
  ceased?: boolean;
  identification?: Record<string, unknown>;
  identity_verification_details?: Record<string, unknown>;
  links?: { self?: string };
}

interface ChPscList {
  active_count?: number;
  ceased_count?: number;
  total_results?: number;
  items_per_page?: number;
  start_index?: number;
  items?: ChPscItem[];
}

interface ChStatementItem {
  statement?: string;
  notified_on?: string;
  ceased_on?: string;
}

interface ChStatementList {
  active_count?: number;
  ceased_count?: number;
  total_results?: number;
  items?: ChStatementItem[];
}

interface VerificationView {
  status: VerificationStatus;
  identity_verified_on?: string;
  verification_statement_date?: string;
  verification_statement_due_on?: string;
  verified_by_acsp?: string;
  /** Whether individual identity verification is expected of this PSC at all. */
  applies: boolean;
  /** Companies House's own object, passed through unchanged. */
  raw?: Record<string, unknown>;
}

function firstString(source: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Tolerant by design: the shape of `identity_verification_details` has changed
 * more than once since the ECCTA provisions commenced, and a schema change
 * upstream must degrade to `not_reported`, never throw.
 */
export function readVerification(item: ChPscItem): VerificationView {
  const details = (item.identity_verification_details ?? undefined) as Record<string, unknown> | undefined;
  const ceased = Boolean(item.ceased_on || item.ceased);
  const applies = kindIsIndividual(item.kind);

  if (kindIsSuperSecure(item.kind)) {
    return { status: "protected", applies: false, raw: details };
  }
  if (ceased) {
    return { status: "ceased", applies, raw: details };
  }

  const verifiedOn = firstString(details, "identity_verified_on", "identity_verification_date", "verified_on");
  const statementDate = firstString(details, "appointment_verification_statement_date", "verification_statement_date");
  const statementDue = firstString(details, "appointment_verification_statement_due_on", "appointment_verification_end_on");
  const acsp = firstString(
    details,
    "authorised_corporate_service_provider_name",
    "acsp_name",
    "anti_money_laundering_supervisory_body",
  );

  const view: VerificationView = { status: "not_reported", applies, raw: details };
  if (verifiedOn) view.identity_verified_on = verifiedOn;
  if (statementDate) view.verification_statement_date = statementDate;
  if (statementDue) view.verification_statement_due_on = statementDue;
  if (acsp) view.verified_by_acsp = acsp;

  if (verifiedOn) {
    view.status = "verified";
  } else if (details && Object.keys(details).length > 0) {
    // Companies House is publishing a verification object for this person but
    // has recorded no verification date in it.
    view.status = "unverified";
  }
  return view;
}

function normalisePsc(item: ChPscItem) {
  const natures: NatureOfControl[] = (item.natures_of_control ?? []).map(parseNatureOfControl);
  return {
    kind: item.kind,
    name: item.name,
    nationality: item.nationality,
    country_of_residence: item.country_of_residence,
    date_of_birth: item.date_of_birth,
    notified_on: item.notified_on,
    ceased_on: item.ceased_on,
    is_individual: kindIsIndividual(item.kind),
    natures_of_control: natures,
    control_summary: natures.map((n) => n.label),
    identity_verification: readVerification(item),
  };
}

type NormalisedPsc = ReturnType<typeof normalisePsc>;

export function summarise(pscs: NormalisedPsc[], statements: Array<{ statement?: string; ceased_on?: string }>) {
  const active = pscs.filter((p) => !p.ceased_on);
  const individuals = active.filter((p) => p.is_individual);

  const verified = individuals.filter((p) => p.identity_verification.status === "verified").length;
  const unverified = individuals.filter((p) => p.identity_verification.status === "unverified").length;
  const notReported = individuals.filter((p) => p.identity_verification.status === "not_reported").length;

  // Only assertable when every active individual has been reported on either
  // way. Otherwise the honest answer is that it is not known.
  const allVerified = individuals.length === 0 ? null : notReported > 0 ? null : unverified === 0;

  const activeStatements = statements.filter((s) => !s.ceased_on && s.statement);

  const parts: string[] = [];
  parts.push(`${active.length} active person${active.length === 1 ? "" : "s"} with significant control`);
  if (individuals.length > 0) {
    parts.push(`${verified} of ${individuals.length} individual${individuals.length === 1 ? "" : "s"} recorded as identity-verified`);
    if (notReported > 0) parts.push(`${notReported} with no verification data published`);
  }
  if (activeStatements.length > 0) parts.push(`${activeStatements.length} active PSC statement${activeStatements.length === 1 ? "" : "s"}`);

  return {
    active_psc_count: active.length,
    ceased_psc_count: pscs.length - active.length,
    active_individual_count: individuals.length,
    individuals_verified: verified,
    individuals_unverified: unverified,
    individuals_verification_not_reported: notReported,
    /** null means "not determinable from published data", not "no". */
    all_active_individuals_verified: allVerified,
    active_statement_count: activeStatements.length,
    assessment: `${parts.join("; ")}.`,
  };
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

  const includeCeased = optionalBoolean(args, "include_ceased", false);
  const includeStatements = optionalBoolean(args, "include_statements", true);

  let list: ChPscList;
  try {
    list = await ctx.client.get<ChPscList>(`/company/${companyNumber}/persons-with-significant-control`, {
      items_per_page: 100,
      start_index: 0,
    });
  } catch (cause) {
    // A company with no PSC register returns 404 here; that is a real answer
    // rather than an error, so long as statements can still be read.
    if (cause instanceof CompaniesHouseError && cause.code === "not_found") {
      list = { items: [], active_count: 0, ceased_count: 0, total_results: 0 };
    } else {
      return toolErrorOutcome(cause, ctx);
    }
  }

  const statements: ChStatementItem[] = [];
  let statementsAvailable = false;
  if (includeStatements) {
    try {
      const result = await ctx.client.get<ChStatementList>(
        `/company/${companyNumber}/persons-with-significant-control-statements`,
        { items_per_page: 100, start_index: 0 },
      );
      statements.push(...(result.items ?? []));
      statementsAvailable = true;
    } catch (cause) {
      if (!(cause instanceof CompaniesHouseError && cause.code === "not_found")) {
        return toolErrorOutcome(cause, ctx);
      }
      statementsAvailable = true; // 404 here means "no statements", not a fault.
    }
  }

  const all = (list.items ?? []).map(normalisePsc);
  const pscs = includeCeased ? all : all.filter((p) => !p.ceased_on);

  return {
    value: {
      source: SOURCE_ATTRIBUTION,
      retrieved_at: new Date().toISOString(),
      company_number: companyNumber,
      summary: summarise(all, statements),
      persons_with_significant_control: pscs,
      statements: statementsAvailable
        ? statements.map((s) => ({
            statement: s.statement,
            label: describeStatement(s.statement ?? ""),
            notified_on: s.notified_on,
            ceased_on: s.ceased_on,
          }))
        : undefined,
      caveats: [
        "Identity verification data is published progressively by Companies House. A status of 'not_reported' means no verification data was published for that person at the time of this call — it is not evidence that the person is unverified.",
        "'protected' indicates a super-secure record, for which Companies House withholds identifying detail.",
        "This service reports what the register says. It does not verify identity itself and is not a substitute for a regulated KYC process.",
      ],
    },
    upstreamRequests: ctx.client.requestCount,
    billable: true,
  };
}

export const pscVerificationTool: ToolDefinition = {
  name: "get_psc_verification_status",
  title: "UK company PSC register and identity-verification status",
  description:
    "Return the persons with significant control recorded against a UK company, each with its Companies House " +
    "identity-verification status resolved to one of verified / unverified / not_reported / protected / ceased, and each " +
    "nature of control decomposed into right, percentage band, how it is held and scope. Includes active PSC statements " +
    "(for example, that the company says it has no PSC) and a summary that reports genuine uncertainty as unknown rather " +
    "than resolving it. Source: Companies House public data API.",
  inputSchema: {
    type: "object",
    properties: {
      company_number: {
        type: "string",
        description: "UK company number, in any common form; normalised to the canonical eight-character number.",
      },
      include_ceased: {
        type: "boolean",
        default: false,
        description: "Include persons who have ceased to be PSCs. Summary counts always cover both.",
      },
      include_statements: {
        type: "boolean",
        default: true,
        description:
          "Also read the PSC statements register, which is where 'this company has no PSC' is recorded. " +
          "Costs one extra upstream request under the metered 'upto' scheme.",
      },
    },
    required: ["company_number"],
    additionalProperties: false,
  },
  price: DEFAULT_PRICE,
  run,
};
