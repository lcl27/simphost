import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error - plain ESM helper shared with the CLI script
import { checkFilingHistory, checkPscVerification, summariseFindings } from "../scripts/lib/checks.mjs";
import { createChClient } from "../src/companies-house/client.js";
import { filingHistoryTool } from "../src/tools/filing-history.js";
import { pscVerificationTool } from "../src/tools/psc-verification.js";
import { installFetchStub, testEnv } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const ctx = () => ({ env: testEnv(), client: createChClient(testEnv()) });
const levels = (findings: Array<{ level: string; message: string }>) => findings.map((f) => f.level);

/**
 * The checks are exercised against output from the real tools rather than
 * hand-written payloads, so that a change to the tools cannot silently stop the
 * live verification from checking anything.
 */
describe("live-verification checks, fed by the real tools", () => {
  it("passes clean filing history output", async () => {
    installFetchStub();
    const payload = (await filingHistoryTool.run({ company_number: "00000001" }, ctx())).value;
    const { findings } = checkFilingHistory(payload, "00000001");
    expect(summariseFindings(findings).failures).toHaveLength(0);
    expect(levels(findings)).toContain("note");
  });

  it("passes clean PSC output", async () => {
    installFetchStub();
    const payload = (await pscVerificationTool.run({ company_number: "00000001" }, ctx())).value;
    const { findings, unknownFields, unknownControlCodes } = checkPscVerification(payload, "00000001");
    expect(summariseFindings(findings).failures).toHaveLength(0);
    expect(unknownFields).toHaveLength(0);
    expect(unknownControlCodes).toHaveLength(0);
  });

  it("reports an upstream error rather than passing it over", () => {
    const { findings } = checkFilingHistory({ error: "not_found", message: "no such company" }, "99999999");
    expect(summariseFindings(findings).failures).toHaveLength(1);
  });
});

describe("the checks catch the drift they exist to catch", () => {
  it("fails when the taxonomy stops matching live codes", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      group: i < 6 ? "other" : "accounts",
      significance: "routine",
      description_code: `unknown-code-${i}`,
      date: "2025-01-01",
    }));
    const { findings } = checkFilingHistory({ items, chronology: { first_filing_date: "2025-01-01", last_filing_date: "2025-01-01", counts_by_group: { other: 6 }, material_events: [] } }, "X");
    expect(summariseFindings(findings).failures[0].message).toContain("fell through to \"other\"");
  });

  it("warns rather than fails on a handful of unclassified codes", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      group: i === 0 ? "other" : "accounts",
      significance: "routine",
      description_code: i === 0 ? "brand-new-code" : "accounts-x",
      date: "2025-01-01",
    }));
    const { findings, unclassified } = checkFilingHistory(
      { items, chronology: { first_filing_date: "2025-01-01", last_filing_date: "2025-01-01", counts_by_group: { accounts: 19, other: 1 }, material_events: [] } },
      "X",
    );
    expect(summariseFindings(findings).failures).toHaveLength(0);
    expect(unclassified).toEqual(["brand-new-code"]);
  });

  it("catches an inverted chronology", () => {
    const { findings } = checkFilingHistory(
      {
        items: [{ group: "accounts", significance: "routine", date: "2020-01-01" }],
        chronology: { first_filing_date: "2025-01-01", last_filing_date: "2020-01-01", counts_by_group: { accounts: 1 }, material_events: [] },
      },
      "X",
    );
    expect(summariseFindings(findings).failures[0].message).toContain("inverted");
  });

  it("catches material events that are not newest-first", () => {
    const { findings } = checkFilingHistory(
      {
        items: [{ group: "charges", significance: "material", date: "2020-01-01" }],
        chronology: {
          first_filing_date: "2020-01-01",
          last_filing_date: "2024-01-01",
          counts_by_group: { charges: 1 },
          material_events: [{ date: "2020-01-01" }, { date: "2024-01-01" }],
        },
      },
      "X",
    );
    expect(summariseFindings(findings).failures[0].message).toContain("newest-first");
  });

  it("surfaces an ECCTA verification field the parser does not read", () => {
    const { findings, unknownFields } = checkPscVerification(
      {
        summary: { assessment: "1 active PSC.", active_individual_count: 1, individuals_verification_not_reported: 0, all_active_individuals_verified: true },
        statements: [],
        persons_with_significant_control: [
          {
            identity_verification: { status: "verified", raw: { identity_verified_on: "2025-01-01", verification_tier: "enhanced" } },
            natures_of_control: [{ code: "ownership-of-shares-75-to-100-percent", right: "shares" }],
          },
        ],
      },
      "X",
    );
    expect(summariseFindings(findings).failures).toHaveLength(0);
    expect(unknownFields).toEqual(["verification_tier"]);
  });

  it("surfaces a nature-of-control code it could not decompose", () => {
    const { unknownControlCodes } = checkPscVerification(
      {
        summary: { assessment: "x", active_individual_count: 0, individuals_verification_not_reported: 0, all_active_individuals_verified: null },
        statements: [],
        persons_with_significant_control: [
          { identity_verification: { status: "not_reported", raw: {} }, natures_of_control: [{ code: "some-new-right", right: "unknown" }] },
        ],
      },
      "X",
    );
    expect(unknownControlCodes).toEqual(["some-new-right"]);
  });

  it("fails if absence of verification data is ever resolved to a verdict", () => {
    const { findings } = checkPscVerification(
      {
        summary: { assessment: "x", active_individual_count: 2, individuals_verification_not_reported: 1, all_active_individuals_verified: true },
        statements: [],
        persons_with_significant_control: [],
      },
      "X",
    );
    expect(summariseFindings(findings).failures[0].message).toContain("all_active_individuals_verified is not null");
  });

  it("rejects a verification status outside the documented set", () => {
    const { findings } = checkPscVerification(
      {
        summary: { assessment: "x", active_individual_count: 1, individuals_verification_not_reported: 0, all_active_individuals_verified: true },
        statements: [],
        persons_with_significant_control: [{ identity_verification: { status: "probably_fine", raw: {} }, natures_of_control: [] }],
      },
      "X",
    );
    expect(summariseFindings(findings).failures[0].message).toContain("unrecognised verification status");
  });
});
