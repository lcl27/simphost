import { afterEach, describe, expect, it, vi } from "vitest";
import { createChClient, CompaniesHouseError } from "../src/companies-house/client.js";
import { filingHistoryTool } from "../src/tools/filing-history.js";
import { pscVerificationTool } from "../src/tools/psc-verification.js";
import { readVerification } from "../src/tools/psc-verification.js";
import { installFetchStub, testEnv } from "./helpers.js";
import { pscSuperSecureFixture } from "./fixtures/companies-house.js";

afterEach(() => vi.unstubAllGlobals());

function ctx(env = testEnv()) {
  const client = createChClient(env);
  return { env, client };
}

describe("get_company_filing_history", () => {
  it("classifies every filing and derives a chronology", async () => {
    installFetchStub();
    const outcome = await filingHistoryTool.run({ company_number: "1" }, ctx());
    const value = outcome.value as any;

    expect(outcome.billable).toBe(true);
    expect(value.company_number).toBe("00000001");
    expect(value.items).toHaveLength(9);
    expect(value.paging.complete).toBe(true);

    expect(value.chronology.first_filing_date).toBe("2015-01-06");
    expect(value.chronology.last_filing_date).toBe("2025-06-14");
    expect(value.chronology.span_days).toBeGreaterThan(3_000);
    expect(value.chronology.counts_by_group).toMatchObject({
      confirmation: 1,
      accounts: 1,
      charges: 1,
      officers: 2,
      control: 1,
      capital: 1,
      distress: 1,
      formation: 1,
    });
    expect(value.chronology.filings_by_year["2024"]).toBe(3);
  });

  it("surfaces the latest accounts and confirmation statement", async () => {
    installFetchStub();
    const value = (await filingHistoryTool.run({ company_number: "00000001" }, ctx())).value as any;
    expect(value.chronology.latest_accounts.date).toBe("2025-03-02");
    expect(value.chronology.latest_confirmation_statement.date).toBe("2025-06-14");
  });

  it("lists material events newest first", async () => {
    installFetchStub();
    const value = (await filingHistoryTool.run({ company_number: "00000001" }, ctx())).value as any;
    const dates = value.chronology.material_events.map((e: any) => e.date);
    expect(dates).toEqual(["2024-11-20", "2021-09-09", "2015-01-06"]);
    expect(value.chronology.material_events[0].group).toBe("charges");
  });

  it("passes the Companies House description code through untranslated", async () => {
    installFetchStub();
    const value = (await filingHistoryTool.run({ company_number: "00000001" }, ctx())).value as any;
    const charge = value.items.find((i: any) => i.transaction_id === "t7");
    expect(charge.description_code).toBe("create-charge-with-deed");
    expect(charge.form_type).toBe("MR01");
    // Companies House does not publish document metadata for every filing, and
    // we do not fabricate a link where there is none.
    expect(charge.document_metadata_url).toBeUndefined();

    const accounts = value.items.find((i: any) => i.transaction_id === "t8");
    expect(accounts.document_metadata_url).toBe("https://doc/t8");
    expect(accounts.description_values).toEqual({ made_up_date: "2024-09-30" });
  });

  it("rejects a malformed company number without charging or calling upstream", async () => {
    const recorder = installFetchStub();
    const outcome = await filingHistoryTool.run({ company_number: "not-a-number" }, ctx());
    expect(outcome.billable).toBe(false);
    expect(outcome.upstreamRequests).toBe(0);
    expect(recorder.chCalls).toHaveLength(0);
    expect((outcome.value as any).error).toBe("invalid_argument");
  });

  it("reports an unknown company as an unbilled not_found", async () => {
    installFetchStub();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const outcome = await filingHistoryTool.run({ company_number: "99999999" }, ctx());
    expect(outcome.billable).toBe(false);
    expect((outcome.value as any).error).toBe("not_found");
  });

  it("reports a rate limit with the retry hint and does not charge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "37" } })),
    );
    const outcome = await filingHistoryTool.run({ company_number: "00000001" }, ctx());
    expect(outcome.billable).toBe(false);
    expect((outcome.value as any)).toMatchObject({ error: "rate_limited", retry_after_seconds: 37 });
  });

  it("refuses to pretend it is configured when no API key is present", async () => {
    installFetchStub();
    const outcome = await filingHistoryTool.run({ company_number: "00000001" }, ctx(testEnv({ CH_API_KEY: undefined })));
    expect(outcome.billable).toBe(false);
    expect((outcome.value as any).error).toBe("not_configured");
  });

  it("sends the Companies House key as HTTP basic with an empty password", async () => {
    installFetchStub();
    const seen: RequestInit[] = [];
    const inner = globalThis.fetch as any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init: any) => {
        seen.push(init);
        return inner(input, init);
      }),
    );
    await filingHistoryTool.run({ company_number: "00000001" }, ctx());
    const auth = (seen[0]?.headers as Record<string, string>)["authorization"];
    expect(auth).toBe(`Basic ${btoa("test-key:")}`);
  });
});

describe("get_psc_verification_status", () => {
  it("resolves each verification status and reports uncertainty honestly", async () => {
    installFetchStub();
    const outcome = await pscVerificationTool.run({ company_number: "00000001" }, ctx());
    const value = outcome.value as any;

    expect(value.summary).toMatchObject({
      active_psc_count: 3,
      ceased_psc_count: 1,
      active_individual_count: 2,
      individuals_verified: 1,
      individuals_unverified: 1,
      individuals_verification_not_reported: 0,
      all_active_individuals_verified: false,
    });

    const verified = value.persons_with_significant_control.find((p: any) => p.name === "Ms Verified Holder");
    expect(verified.identity_verification).toMatchObject({
      status: "verified",
      identity_verified_on: "2025-07-16",
      verified_by_acsp: "Example ACSP LLP",
      applies: true,
    });

    const pending = value.persons_with_significant_control.find((p: any) => p.name === "Mr Pending Holder");
    expect(pending.identity_verification.status).toBe("unverified");
    expect(pending.identity_verification.verification_statement_due_on).toBe("2026-01-15");
  });

  it("does not claim an entity PSC is unverified", async () => {
    installFetchStub();
    const value = (await pscVerificationTool.run({ company_number: "00000001" }, ctx())).value as any;
    const entity = value.persons_with_significant_control.find((p: any) => p.name === "Holdco Limited");
    expect(entity.identity_verification).toMatchObject({ status: "not_reported", applies: false });
    expect(entity.is_individual).toBe(false);
  });

  it("excludes ceased PSCs by default but still counts them", async () => {
    installFetchStub();
    const value = (await pscVerificationTool.run({ company_number: "00000001" }, ctx())).value as any;
    expect(value.persons_with_significant_control).toHaveLength(3);
    expect(value.summary.ceased_psc_count).toBe(1);

    const withCeased = (await pscVerificationTool.run({ company_number: "00000001", include_ceased: true }, ctx())).value as any;
    expect(withCeased.persons_with_significant_control).toHaveLength(4);
  });

  it("decomposes natures of control into structured rights", async () => {
    installFetchStub();
    const value = (await pscVerificationTool.run({ company_number: "00000001" }, ctx())).value as any;
    const verified = value.persons_with_significant_control[0];
    expect(verified.natures_of_control).toHaveLength(2);
    expect(verified.natures_of_control[0]).toMatchObject({ right: "shares", band: "75-100" });
    expect(verified.control_summary[0]).toContain("more than 75%");
  });

  it("reads the statements register and labels the statement", async () => {
    installFetchStub();
    const value = (await pscVerificationTool.run({ company_number: "00000001" }, ctx())).value as any;
    expect(value.statements).toHaveLength(1);
    expect(value.statements[0].statement).toBe("psc-exists-but-not-identified");
    expect(value.statements[0].label).toContain("not identified");
    expect(value.summary.active_statement_count).toBe(1);
  });

  it("skips the statements request when the caller does not want it", async () => {
    const recorder = installFetchStub();
    await pscVerificationTool.run({ company_number: "00000001", include_statements: false }, ctx());
    expect(recorder.chCalls.filter((u) => u.includes("statements"))).toHaveLength(0);
  });

  it("treats an empty PSC register as an answer, not an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("persons-with-significant-control-statements")) {
          return new Response(JSON.stringify({ items: [{ statement: "no-individual-or-entity-with-signficant-control" }] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    const outcome = await pscVerificationTool.run({ company_number: "00000001" }, ctx());
    expect(outcome.billable).toBe(true);
    const value = outcome.value as any;
    expect(value.summary.active_psc_count).toBe(0);
    expect(value.summary.all_active_individuals_verified).toBeNull();
    expect(value.statements[0].label).toContain("no person with significant control");
  });

  it("reports a super-secure record as protected rather than unverified", () => {
    const view = readVerification(pscSuperSecureFixture.items[0] as never);
    expect(view).toMatchObject({ status: "protected", applies: false });
  });

  it("reports missing verification data as not_reported, never as unverified", () => {
    expect(readVerification({ kind: "individual-person-with-significant-control" }).status).toBe("not_reported");
  });

  it("does not throw when the verification object changes shape upstream", () => {
    const view = readVerification({
      kind: "individual-person-with-significant-control",
      identity_verification_details: { some_future_field: { nested: true } } as never,
    });
    expect(view.status).toBe("unverified");
    expect(view.raw).toEqual({ some_future_field: { nested: true } });
  });

  it("marks a ceased PSC's verification status as ceased", () => {
    expect(readVerification({ kind: "individual-person-with-significant-control", ceased_on: "2020-01-01" }).status).toBe("ceased");
  });

  it("carries the caveats that stop a caller over-reading the data", async () => {
    installFetchStub();
    const value = (await pscVerificationTool.run({ company_number: "00000001" }, ctx())).value as any;
    expect(value.caveats.join(" ")).toContain("not evidence that the person is unverified");
  });
});

describe("Companies House client", () => {
  it("counts only the requests it actually issued", async () => {
    installFetchStub();
    const client = createChClient(testEnv());
    await client.get("/company/00000001/filing-history");
    await client.get("/company/00000001/persons-with-significant-control");
    expect(client.requestCount).toBe(2);
  });

  it("classifies a rejected key as a configuration fault, not a caller fault", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const client = createChClient(testEnv());
    await expect(client.get("/company/00000001")).rejects.toMatchObject({ code: "unauthorised", billable: false });
  });

  it("wraps a network failure rather than leaking it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const client = createChClient(testEnv());
    await expect(client.get("/company/00000001")).rejects.toBeInstanceOf(CompaniesHouseError);
  });
});
