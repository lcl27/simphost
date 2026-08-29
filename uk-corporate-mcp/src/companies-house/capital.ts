/**
 * Share capital events, read from Companies House filing history.
 *
 * Deliberately framed in UK terms rather than US ones. A UK capital structure is
 * a statement of capital — classes of share, nominal value per share, aggregate
 * nominal value, amounts paid up and the prescribed particulars of rights — not
 * a venture cap table of preferred series, liquidation preferences and an option
 * pool. The vocabulary here follows the Companies Act 2006 and the SH-series
 * forms: allotment, not issuance; nominal value, not par; consolidation and
 * subdivision, not splits and reverse splits.
 *
 * What the API can and cannot support is set out in `CAPITAL_DATA_LIMITS`. It is
 * a real constraint and is surfaced to the caller rather than papered over.
 */

export type CapitalEventType =
  | "incorporation"
  | "allotment"
  | "subdivision"
  | "consolidation"
  | "reconversion"
  | "redenomination"
  | "reduction"
  | "redemption"
  | "purchase-of-own-shares"
  | "treasury-cancellation"
  | "treasury-sale"
  | "cancellation"
  | "class-created"
  | "class-renamed"
  | "class-rights-varied"
  | "statement-of-capital"
  | "other";

/**
 * Whether the event moves aggregate nominal capital, or only rearranges it.
 * A consolidation or subdivision leaves the aggregate untouched while changing
 * the number of shares and the nominal value of each — a distinction that
 * matters when reading a capital history and is easy to lose.
 */
export type CapitalEffect = "increase" | "decrease" | "restructure" | "none" | "unknown";

export interface CapitalFigure {
  currency: string;
  /** As published, e.g. "1,000,000.00". */
  figure: string;
  /** Parsed where possible, so a spreadsheet can total it. */
  value: number | null;
}

export interface CapitalEvent {
  /** Effective date of the statement of capital, where the filing gives one. */
  as_at?: string;
  /** Date the document was filed. */
  filed_on?: string;
  form_type?: string;
  description_code?: string;
  event: CapitalEventType;
  event_label: string;
  effect: CapitalEffect;
  /** Aggregate nominal capital reported by this filing, by currency. */
  capital: CapitalFigure[];
  /** Treasury or alternative figure, where the filing reports one separately. */
  treasury_capital: CapitalFigure[];
  transaction_id?: string;
  document_metadata_url?: string;
}

interface Rule {
  event: CapitalEventType;
  label: string;
  effect: CapitalEffect;
  test: (code: string) => boolean;
}

const has = (...needles: string[]) => (code: string) => needles.some((n) => code.includes(n));

/**
 * Ordered, most specific first. Companies House composes these codes from
 * fragments, so a single filing can mention consolidation and subdivision
 * together; the combined case is caught before either alone.
 */
const RULES: Rule[] = [
  { event: "treasury-cancellation", label: "Cancellation of treasury shares", effect: "decrease", test: has("cancellation-treasury-shares") },
  { event: "treasury-sale", label: "Sale or transfer of treasury shares", effect: "none", test: has("sale-or-transfer-treasury-shares") },
  { event: "purchase-of-own-shares", label: "Purchase of own shares", effect: "decrease", test: has("purchase-own-shares", "purchase-of-own-shares") },
  { event: "cancellation", label: "Cancellation of shares", effect: "decrease", test: has("cancellation-shares") },
  { event: "reduction", label: "Reduction of capital", effect: "decrease", test: has("reduction-of-capital", "capital-reduction", "solvency-statement") },
  { event: "redemption", label: "Redemption of redeemable shares", effect: "decrease", test: has("alter-shares-redemption", "-redemption") },
  { event: "redenomination", label: "Redenomination of share capital", effect: "restructure", test: has("redomination", "redenomination") },
  {
    event: "consolidation",
    label: "Consolidation and subdivision of shares",
    effect: "restructure",
    test: (code) => code.includes("consolidation") && code.includes("subdivision"),
  },
  { event: "consolidation", label: "Consolidation of shares", effect: "restructure", test: has("consolidation") },
  { event: "subdivision", label: "Subdivision of shares", effect: "restructure", test: has("subdivision") },
  { event: "reconversion", label: "Reconversion of stock into shares", effect: "restructure", test: has("reconversion") },
  { event: "class-created", label: "New class of shares created", effect: "restructure", test: has("allotment-new-class-of-shares", "new-class-members") },
  { event: "class-renamed", label: "Change of share class name or designation", effect: "none", test: has("name-of-class-of-shares") },
  { event: "class-rights-varied", label: "Variation of rights attached to shares", effect: "none", test: has("variation-of-class-rights", "variation-of-rights-attached") },
  { event: "allotment", label: "Allotment of shares", effect: "increase", test: has("allotment") },
  { event: "incorporation", label: "Incorporation — initial statement of capital", effect: "increase", test: has("incorporation") },
  { event: "statement-of-capital", label: "Statement of capital", effect: "none", test: has("statement-of-capital", "statement-capital") },
  { event: "class-rights-varied", label: "Change to class of members", effect: "none", test: has("update-to-class-of-members") },
  { event: "other", label: "Other capital filing", effect: "unknown", test: has("capital") },
];

export function classifyCapitalEvent(descriptionCode: string | undefined): Rule | null {
  const code = (descriptionCode ?? "").toLowerCase().trim();
  if (!code) return null;
  for (const rule of RULES) {
    if (rule.test(code)) return rule;
  }
  return null;
}

/** Companies House publishes figures as display strings; keep both forms. */
export function parseFigures(raw: unknown): CapitalFigure[] {
  if (!Array.isArray(raw)) return [];
  const figures: CapitalFigure[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const currency = typeof record["currency"] === "string" ? record["currency"].toUpperCase() : "";
    const figure = record["figure"] === undefined || record["figure"] === null ? "" : String(record["figure"]);
    if (!currency && !figure) continue;
    const cleaned = figure.replace(/[,\s]/g, "");
    const value = cleaned !== "" && Number.isFinite(Number(cleaned)) ? Number(cleaned) : null;
    figures.push({ currency: currency || "UNKNOWN", figure, value });
  }
  return figures;
}

interface FilingLike {
  transaction_id?: string;
  date?: string;
  form_type?: string;
  description_code?: string;
  description_values?: Record<string, unknown>;
  document_metadata_url?: string;
  companies_house_category?: string;
}

/**
 * A confirmation statement or incorporation can carry a statement of capital
 * without being a capital filing, so the category is not a sufficient filter:
 * anything reporting a `capital` array is a capital event for these purposes.
 */
export function extractCapitalEvents(filings: FilingLike[]): CapitalEvent[] {
  const events: CapitalEvent[] = [];

  for (const filing of filings) {
    const values = filing.description_values ?? {};
    const capital = parseFigures(values["capital"]);
    const treasury = parseFigures(values["alt_capital"]);
    const rule = classifyCapitalEvent(filing.description_code);

    if (!rule && capital.length === 0) continue;

    const asAt =
      (typeof values["date"] === "string" && values["date"]) ||
      (typeof values["made_up_date"] === "string" && values["made_up_date"]) ||
      undefined;

    events.push({
      as_at: asAt || undefined,
      filed_on: filing.date,
      form_type: filing.form_type,
      description_code: filing.description_code,
      event: rule?.event ?? "statement-of-capital",
      event_label: rule?.label ?? "Statement of capital",
      effect: rule?.effect ?? "none",
      capital,
      treasury_capital: treasury,
      transaction_id: filing.transaction_id,
      document_metadata_url: filing.document_metadata_url,
    });
  }

  // Newest first, on the effective date where there is one.
  return events.sort((a, b) => {
    const left = a.as_at ?? a.filed_on ?? "";
    const right = b.as_at ?? b.filed_on ?? "";
    return left < right ? 1 : left > right ? -1 : 0;
  });
}

export interface IssuedCapitalLine {
  currency: string;
  figure: string;
  value: number | null;
  as_at?: string;
  source_form?: string;
  source_event: string;
  transaction_id?: string;
}

/**
 * The most recent reported aggregate nominal capital for each currency.
 *
 * Per currency rather than overall, because a UK company may have share capital
 * denominated in more than one currency and the figures do not aggregate.
 */
export function latestIssuedCapital(events: CapitalEvent[]): IssuedCapitalLine[] {
  const byCurrency = new Map<string, IssuedCapitalLine>();

  // `events` is newest first, so the first sighting of a currency wins.
  for (const event of events) {
    for (const figure of event.capital) {
      if (byCurrency.has(figure.currency)) continue;
      byCurrency.set(figure.currency, {
        currency: figure.currency,
        figure: figure.figure,
        value: figure.value,
        as_at: event.as_at ?? event.filed_on,
        source_form: event.form_type,
        source_event: event.event_label,
        transaction_id: event.transaction_id,
      });
    }
  }

  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Stated plainly and returned to the caller. The gap between what the register
 * holds and what the API publishes is the single most important thing to
 * understand about this output, and a caller who does not know it will read the
 * spreadsheet as more complete than it is.
 */
export const CAPITAL_DATA_LIMITS = [
  "The Companies House public data API publishes aggregate nominal capital by currency on capital filings. It does not publish, as structured data, the number of shares in each class, the nominal value per share, the amounts paid up or unpaid, or the prescribed particulars of the rights attached to each class.",
  "Those particulars are in the SH-series forms and the confirmation statement themselves. Document links are given in the capital events sheet so the underlying filing can be pulled where the detail is needed.",
  "The shareholder register is not available through this API. For a company that is not traded, the confirmation statement includes a shareholder list, but only within the filed document.",
  "PSC data records control in bands — more than 25%, more than 50%, more than 75% — because that is what UK law requires to be published. It is not an exact shareholding, and it is not a substitute for one.",
  "A consolidation, subdivision or reconversion rearranges share capital without changing its aggregate nominal value. Reading the aggregate alone will therefore understate how much has changed.",
  "Treasury figures, where a filing reports one separately, are shown in their own column and are not netted off the aggregate.",
  "Issued capital is reported as the most recent figure seen for each currency. After a redenomination the superseded currency may still appear, because the filings do not state that the old currency ceased to be in issue. Check the capital events sheet before treating a multi-currency line as current.",
];
