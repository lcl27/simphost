import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyCapitalEvent,
  extractCapitalEvents,
  latestIssuedCapital,
  parseFigures,
} from "../src/companies-house/capital.js";
import { createChClient } from "../src/companies-house/client.js";
import { capitalStructureTool } from "../src/tools/capital-structure.js";
import { filingHistoryTool } from "../src/tools/filing-history.js";
import { workbookToCsv } from "../src/spreadsheet/capital-workbook.js";
import { installFetchStub, testEnv } from "./helpers.js";
import { capitalFilingHistoryFixture } from "./fixtures/companies-house.js";

afterEach(() => vi.unstubAllGlobals());

const ctx = () => ({ env: testEnv(), client: createChClient(testEnv()) });

describe("capital event classification, in UK terms", () => {
  const cases: Array<[string, string, string]> = [
    ["capital-allotment-shares", "allotment", "increase"],
    ["capital-allotment-new-class-of-shares", "class-created", "restructure"],
    ["capital-alter-shares-subdivision-statement-of-capital", "subdivision", "restructure"],
    ["capital-alter-shares-consolidation-statement-of-capital", "consolidation", "restructure"],
    ["capital-alter-shares-consolidation-subdivision", "consolidation", "restructure"],
    ["capital-alter-shares-reconversion", "reconversion", "restructure"],
    ["capital-alter-shares-redemption", "redemption", "decrease"],
    ["capital-redomination-of-shares", "redenomination", "restructure"],
    ["capital-statement-directors-reduction-of-capital-following-redomination", "reduction", "decrease"],
    ["capital-return-purchase-own-shares-capital-date", "purchase-of-own-shares", "decrease"],
    ["capital-cancellation-treasury-shares-with-date-currency-capital-figure", "treasury-cancellation", "decrease"],
    ["capital-sale-or-transfer-treasury-shares-with-date", "treasury-sale", "none"],
    ["capital-cancellation-shares-by-plc", "cancellation", "decrease"],
    ["capital-name-of-class-of-shares-with-date", "class-renamed", "none"],
    ["capital-variation-of-rights-attached-to-shares", "class-rights-varied", "none"],
    ["capital-statement-capital-company-with-date-currency-figure", "statement-of-capital", "none"],
    ["incorporation-company", "incorporation", "increase"],
  ];

  it.each(cases)("reads %s as %s", (code, event, effect) => {
    const rule = classifyCapitalEvent(code);
    expect(rule?.event).toBe(event);
    expect(rule?.effect).toBe(effect);
  });

  it("distinguishes a combined consolidation and subdivision from either alone", () => {
    expect(classifyCapitalEvent("capital-alter-shares-consolidation-subdivision-statement-of-capital")?.label).toContain(
      "Consolidation and subdivision",
    );
    expect(classifyCapitalEvent("capital-alter-shares-subdivision")?.label).toBe("Subdivision of shares");
  });

  it("does not classify a filing that has nothing to do with capital", () => {
    expect(classifyCapitalEvent("accounts-with-accounts-type-full")).toBeNull();
    expect(classifyCapitalEvent(undefined)).toBeNull();
  });
});

describe("figure parsing", () => {
  it("keeps the published string and adds a number a spreadsheet can total", () => {
    expect(parseFigures([{ currency: "gbp", figure: "1,000,000.50" }])).toEqual([
      { currency: "GBP", figure: "1,000,000.50", value: 1_000_000.5 },
    ]);
  });

  it("keeps a figure it cannot parse rather than dropping it", () => {
    expect(parseFigures([{ currency: "GBP", figure: "see attached" }])[0]).toMatchObject({ value: null, figure: "see attached" });
  });

  it("tolerates rubbish without throwing", () => {
    expect(parseFigures(undefined)).toEqual([]);
    expect(parseFigures("not an array")).toEqual([]);
    expect(parseFigures([null, {}, { currency: "USD" }])).toEqual([{ currency: "USD", figure: "", value: null }]);
  });
});

describe("capital events from filing history", () => {
  const filings = capitalFilingHistoryFixture.items.map((i) => ({
    transaction_id: i.transaction_id,
    date: i.date,
    form_type: i.type,
    description_code: i.description,
    description_values: i.description_values,
    document_metadata_url: i.links?.document_metadata,
  }));

  it("picks up capital filings and the statements of capital carried by others", () => {
    const events = extractCapitalEvents(filings);
    // Eight of the nine filings carry capital; the accounts filing does not.
    expect(events).toHaveLength(8);
    expect(events.some((e) => e.form_type === "AA")).toBe(false);
    expect(events.some((e) => e.form_type === "CS01")).toBe(true);
    expect(events.some((e) => e.form_type === "NEWINC")).toBe(true);
  });

  it("orders events newest first on the effective date, not the filing date", () => {
    const events = extractCapitalEvents(filings);
    expect(events[0]?.as_at).toBe("2025-06-01");
    expect(events[events.length - 1]?.as_at).toBe("2015-01-06");
  });

  it("reads the effective date from made_up_date on a confirmation statement", () => {
    const events = extractCapitalEvents(filings);
    const cs01 = events.find((e) => e.form_type === "CS01");
    expect(cs01?.as_at).toBe("2025-06-01");
    expect(cs01?.filed_on).toBe("2025-06-20");
  });

  it("separates the treasury figure from the aggregate", () => {
    const events = extractCapitalEvents(filings);
    const treasury = events.find((e) => e.event === "treasury-cancellation");
    expect(treasury?.capital[0]).toMatchObject({ currency: "GBP", value: 4_850_000 });
    expect(treasury?.treasury_capital[0]).toMatchObject({ currency: "GBP", value: 150_000 });
  });

  it("takes the latest figure for each currency separately", () => {
    const issued = latestIssuedCapital(extractCapitalEvents(filings));
    expect(issued).toHaveLength(2);
    expect(issued.find((l) => l.currency === "GBP")).toMatchObject({ value: 4_850_000, as_at: "2025-06-01" });
    // A currency superseded by a redenomination still shows, because the
    // filings never say it ceased. Deliberate, and called out in the limits.
    expect(issued.find((l) => l.currency === "EUR")).toMatchObject({ value: 1_150_000, as_at: "2022-03-10" });
  });
});

describe("the capital structure tool", () => {
  it("returns the model and a renderable workbook as JSON", async () => {
    installFetchStub();
    const outcome = await capitalStructureTool.run({ company_number: "00000002" }, ctx());
    const value = outcome.value as any;

    expect(outcome.billable).toBe(true);
    expect(value.company_number).toBe("00000002");
    expect(value.basis.capital_events_found).toBe(8);
    expect(value.issued_share_capital.map((l: any) => l.currency)).toEqual(["EUR", "GBP"]);

    const names = value.workbook.sheets.map((s: any) => s.name);
    expect(names).toEqual([
      "Summary",
      "Issued share capital",
      "Capital history",
      "Capital events",
      "Control (PSC)",
      "Notes and limits",
    ]);
    expect(value.limits.length).toBeGreaterThan(4);
    expect(value.file).toBeUndefined();
  });

  it("flattens control to one row per notified nature of control", async () => {
    installFetchStub();
    const value = (await capitalStructureTool.run({ company_number: "00000002" }, ctx())).value as any;
    // The PSC fixture has four people carrying five natures of control between them.
    expect(value.control).toHaveLength(5);
    const holder = value.control.filter((r: any) => r.name === "Ms Verified Holder");
    expect(holder.map((r: any) => r.right).sort()).toEqual(["shares", "voting-rights"]);
    expect(holder[0].verification_status).toBe("verified");
  });

  it("omits control when asked to, and costs less upstream", async () => {
    installFetchStub();
    const withControl = await capitalStructureTool.run({ company_number: "00000002" }, ctx());
    installFetchStub();
    const without = await capitalStructureTool.run({ company_number: "00000002", include_control: false }, ctx());
    expect(without.upstreamRequests).toBeLessThan(withControl.upstreamRequests);
    expect((without.value as any).control).toEqual([]);
  });

  it("produces a real xlsx when asked for one", async () => {
    installFetchStub();
    const value = (await capitalStructureTool.run({ company_number: "00000002", format: "xlsx" }, ctx())).value as any;

    expect(value.file.filename).toBe("00000002-capital-structure.xlsx");
    expect(value.file.content_type).toContain("spreadsheetml");
    const bytes = atob(value.file.base64);
    expect(bytes.slice(0, 2)).toBe("PK");
    expect(bytes).toContain("xl/worksheets/sheet6.xml");
    // The workbook model is not duplicated alongside the file.
    expect(value.workbook).toBeUndefined();
  });

  it("produces a CSV carrying every sheet", async () => {
    installFetchStub();
    const value = (await capitalStructureTool.run({ company_number: "00000002", format: "csv" }, ctx())).value as any;
    expect(value.file.filename).toBe("00000002-capital-structure.csv");
    for (const sheet of ["# Summary", "# Issued share capital", "# Capital events", "# Notes and limits"]) {
      expect(value.file.text).toContain(sheet);
    }
    expect(value.file.text).toContain("Allotment of shares");
  });

  it("quotes CSV fields containing commas rather than breaking the row", () => {
    const csv = workbookToCsv([
      { name: "S", columns: [{ header: "A" }, { header: "B" }], rows: [["has, comma", 'has "quotes"']] },
    ]);
    expect(csv).toContain('"has, comma"');
    expect(csv).toContain('"has ""quotes"""');
  });

  it("rejects an unknown format", async () => {
    installFetchStub();
    await expect(capitalStructureTool.run({ company_number: "00000002", format: "pdf" }, ctx())).rejects.toThrow(/format/);
  });

  it("does not charge for an unknown company", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const outcome = await capitalStructureTool.run({ company_number: "99999999" }, ctx());
    expect(outcome.billable).toBe(false);
    expect((outcome.value as any).error).toBe("not_found");
  });

  it("does not charge for a malformed company number", async () => {
    installFetchStub();
    const outcome = await capitalStructureTool.run({ company_number: "??" }, ctx());
    expect(outcome.billable).toBe(false);
    expect(outcome.upstreamRequests).toBe(0);
  });

  it("still produces a workbook for a company with no capital filings", async () => {
    installFetchStub();
    const outcome = await capitalStructureTool.run({ company_number: "00000001" }, ctx());
    const value = outcome.value as any;
    // The general fixture has one capital filing but no capital figures on it.
    expect(value.issued_share_capital).toEqual([]);
    expect(value.workbook.sheets).toHaveLength(6);
  });

  it("reports more upstream work than the filing-history tool alone, which drives the metered price", async () => {
    installFetchStub();
    const capital = await capitalStructureTool.run({ company_number: "00000002" }, ctx());
    installFetchStub();
    const filings = await filingHistoryTool.run({ company_number: "00000002", fetch_all: true }, ctx());
    expect(capital.upstreamRequests).toBeGreaterThan(filings.upstreamRequests);
  });
});

describe("the summary sheet", () => {
  it("attributes each as-at date to the currency it was reported for", async () => {
    installFetchStub();
    const value = (await capitalStructureTool.run({ company_number: "00000002" }, ctx())).value as any;
    const summary = value.workbook.sheets[0];
    const labels = summary.rows.map((r: any[]) => String(r[0] ?? ""));

    expect(labels).toContain("   EUR (as at 2022-03-10)");
    expect(labels).toContain("   GBP (as at 2025-06-01)");
    // No bare as-at row that would pin one currency's date to the whole position.
    expect(labels.some((l: string) => l.trim() === "As at")).toBe(false);
  });

  it("says plainly when no capital figure was ever reported", async () => {
    installFetchStub();
    const value = (await capitalStructureTool.run({ company_number: "00000001" }, ctx())).value as any;
    const summary = value.workbook.sheets[0];
    const row = summary.rows.find((r: any[]) => String(r[0]).startsWith("Issued share capital"));
    expect(row[1]).toBe("Not reported in any filing on record");
  });
});
