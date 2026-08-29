import { CAPITAL_DATA_LIMITS, type CapitalEvent, type IssuedCapitalLine } from "../companies-house/capital.js";
import type { CellValue, Sheet } from "./xlsx.js";

/**
 * The workbook layout.
 *
 * Ordered the way a UK capital structure is read: what is in issue now, how it
 * got there, what each event did, who controls it, and — last but not least —
 * what the register does not tell you.
 */

export interface ControlRow {
  name?: string;
  kind?: string;
  notified_on?: string;
  ceased_on?: string;
  right?: string;
  band?: string | null;
  held_via?: string;
  scope?: string;
  verification_status?: string;
  verified_on?: string;
}

export interface CapitalWorkbookInput {
  companyNumber: string;
  retrievedAt: string;
  issuedCapital: IssuedCapitalLine[];
  events: CapitalEvent[];
  control: ControlRow[];
  controlAssessment?: string;
  filingsExamined: number;
  historyComplete: boolean;
}

const BAND_LABELS: Record<string, string> = {
  "25-50": "Over 25%, up to 50%",
  "50-75": "Over 50%, up to 75%",
  "75-100": "Over 75%",
  "over-25": "Over 25%",
};

function bandLabel(band: string | null | undefined): string {
  if (!band) return "Not banded";
  return BAND_LABELS[band] ?? band;
}

function figureCells(figures: { currency: string; figure: string; value: number | null }[]): [string, CellValue] {
  if (figures.length === 0) return ["", null];
  const first = figures[0]!;
  const currencies = figures.map((f) => f.currency).join(", ");
  // Where a filing reports more than one currency, the aggregate cannot be
  // summed into a single number, so the display string carries all of them.
  if (figures.length > 1) return [currencies, figures.map((f) => `${f.currency} ${f.figure}`).join("; ")];
  return [first.currency, first.value ?? first.figure];
}

export function buildCapitalWorkbook(input: CapitalWorkbookInput): Sheet[] {
  const { companyNumber, retrievedAt, issuedCapital, events, control } = input;

  const summaryPreamble: CellValue[][] = [
    ["Statement of capital summary"],
    ["Company number", companyNumber],
    ["Prepared", retrievedAt.slice(0, 10)],
    ["Source", "Companies House public data API"],
    [],
  ];

  const summaryRows: CellValue[][] = [
    ["Issued share capital (aggregate nominal)", issuedCapital.length === 0 ? "Not reported in any filing on record" : ""],
    // The as-at date belongs to the currency it was reported for. Hoisting one
    // of them to the top of the block would attribute a redenomination's date
    // to a figure that was restated years later.
    ...issuedCapital.map((line) => [
      `   ${line.currency}${line.as_at ? ` (as at ${line.as_at})` : ""}`,
      line.value ?? line.figure,
    ]),
    [],
    ["Capital events on record", events.length],
    ["Earliest capital event", events[events.length - 1]?.as_at ?? events[events.length - 1]?.filed_on ?? "—"],
    ["Most recent capital event", events[0]?.as_at ?? events[0]?.filed_on ?? "—"],
    ["Currencies in issue", issuedCapital.map((l) => l.currency).join(", ") || "—"],
    [],
    ["Filings examined", input.filingsExamined],
    ["Filing history complete", input.historyComplete ? "Yes" : "No — truncated at the paging limit"],
    [],
    ["Control", input.controlAssessment ?? "Not requested"],
    [],
    ["Important", "Read the Notes and limits sheet before relying on this."],
  ];

  const issuedSheet: Sheet = {
    name: "Issued share capital",
    preamble: [
      ["Latest reported aggregate nominal capital, per currency"],
      ["Companies House does not publish the per-class breakdown as structured data — see Notes and limits."],
      [],
    ],
    columns: [
      { header: "Currency", width: 12 },
      { header: "Aggregate nominal value", width: 24 },
      { header: "As reported", width: 22 },
      { header: "As at", width: 14 },
      { header: "Reported on", width: 38 },
      { header: "Form", width: 10 },
      { header: "Transaction ID", width: 26 },
    ],
    rows: issuedCapital.map((line) => [
      line.currency,
      line.value ?? null,
      line.figure,
      line.as_at ?? "",
      line.source_event,
      line.source_form ?? "",
      line.transaction_id ?? "",
    ]),
  };

  const historyRows: CellValue[][] = [];
  for (const event of events) {
    for (const figure of event.capital) {
      historyRows.push([
        event.as_at ?? "",
        event.filed_on ?? "",
        figure.currency,
        figure.value ?? null,
        figure.figure,
        event.event_label,
        event.form_type ?? "",
        event.transaction_id ?? "",
      ]);
    }
  }

  const historySheet: Sheet = {
    name: "Capital history",
    preamble: [
      ["Aggregate nominal capital as reported by each filing, newest first"],
      [],
    ],
    columns: [
      { header: "As at", width: 14 },
      { header: "Filed", width: 14 },
      { header: "Currency", width: 12 },
      { header: "Aggregate nominal value", width: 24 },
      { header: "As reported", width: 20 },
      { header: "Reported on", width: 38 },
      { header: "Form", width: 10 },
      { header: "Transaction ID", width: 26 },
    ],
    rows: historyRows,
  };

  const eventsSheet: Sheet = {
    name: "Capital events",
    preamble: [
      ["Every filing on record that changed or restated share capital, newest first"],
      ["\"Effect\" distinguishes events that move aggregate nominal capital from those that only rearrange it."],
      [],
    ],
    columns: [
      { header: "As at", width: 14 },
      { header: "Filed", width: 14 },
      { header: "Form", width: 10 },
      { header: "Event", width: 40 },
      { header: "Effect on issued capital", width: 22 },
      { header: "Currency", width: 12 },
      { header: "Aggregate nominal after", width: 24 },
      { header: "Treasury figure", width: 20 },
      { header: "Companies House code", width: 46 },
      { header: "Transaction ID", width: 26 },
      { header: "Document", width: 44 },
    ],
    rows: events.map((event) => {
      const [currency, amount] = figureCells(event.capital);
      const [, treasury] = figureCells(event.treasury_capital);
      return [
        event.as_at ?? "",
        event.filed_on ?? "",
        event.form_type ?? "",
        event.event_label,
        event.effect,
        currency,
        amount,
        treasury,
        event.description_code ?? "",
        event.transaction_id ?? "",
        event.document_metadata_url ?? "",
      ];
    }),
  };

  const controlSheet: Sheet = {
    name: "Control (PSC)",
    preamble: [
      ["Persons with significant control, one row per notified nature of control"],
      ["UK law requires control to be published in bands, not as an exact shareholding."],
      [],
    ],
    columns: [
      { header: "Name", width: 34 },
      { header: "Kind", width: 40 },
      { header: "Notified on", width: 14 },
      { header: "Ceased on", width: 14 },
      { header: "Right held", width: 28 },
      { header: "Band", width: 22 },
      { header: "Held via", width: 20 },
      { header: "Scope", width: 28 },
      { header: "Identity verification", width: 20 },
      { header: "Verified on", width: 14 },
    ],
    rows: control.map((row) => [
      row.name ?? "",
      row.kind ?? "",
      row.notified_on ?? "",
      row.ceased_on ?? "",
      row.right ?? "",
      bandLabel(row.band),
      row.held_via ?? "",
      row.scope ?? "",
      row.verification_status ?? "",
      row.verified_on ?? "",
    ]),
  };

  const notesSheet: Sheet = {
    name: "Notes and limits",
    preamble: [["What this workbook does and does not show"], []],
    columns: [{ header: "#", width: 5 }, { header: "Note", width: 130 }],
    rows: [
      ...CAPITAL_DATA_LIMITS.map((note, i) => [i + 1, note] as CellValue[]),
      [CAPITAL_DATA_LIMITS.length + 1, "Dates are given in ISO form (YYYY-MM-DD) so that they sort correctly in any locale."],
      [
        CAPITAL_DATA_LIMITS.length + 2,
        "This is a UK statement-of-capital view, not a venture capital table: it records classes, nominal values and allotments under the Companies Act 2006, and has no concept of preferred series, liquidation preferences or an option pool.",
      ],
      [
        CAPITAL_DATA_LIMITS.length + 3,
        "Source: Companies House. Contains public sector information licensed under the Open Government Licence v3.0.",
      ],
      [
        CAPITAL_DATA_LIMITS.length + 4,
        "This reports what the public register says. It is not a verified capital structure, not a legal opinion, and not advice. Where it matters, pull the underlying SH-series forms and confirmation statement.",
      ],
    ],
  };

  return [
    { name: "Summary", preamble: summaryPreamble, columns: [{ header: "Item", width: 42 }, { header: "Value", width: 60 }], rows: summaryRows },
    issuedSheet,
    historySheet,
    eventsSheet,
    controlSheet,
    notesSheet,
  ];
}

/** All sheets in one CSV, separated by a labelled comment line. */
export function workbookToCsv(sheets: Sheet[]): string {
  const escape = (value: CellValue): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const blocks = sheets.map((sheet) => {
    const lines: string[] = [`# ${sheet.name}`];
    for (const row of sheet.preamble ?? []) lines.push(row.map(escape).join(","));
    if (sheet.columns.length > 0) {
      lines.push(sheet.columns.map((c) => escape(c.header)).join(","));
      for (const row of sheet.rows) lines.push(row.map(escape).join(","));
    }
    return lines.join("\n");
  });

  return `${blocks.join("\n\n")}\n`;
}
