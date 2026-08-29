import { describe, expect, it } from "vitest";
import { classifyFiling, humaniseCode } from "../src/companies-house/taxonomy.js";
import { describeStatement, kindIsIndividual, kindIsSuperSecure, parseNatureOfControl } from "../src/companies-house/psc-taxonomy.js";
import { normaliseCompanyNumber, InvalidCompanyNumberError } from "../src/companies-house/client.js";

describe("filing classification", () => {
  const cases: Array<[string, string, string, string]> = [
    ["confirmation-statement-with-no-updates", "confirmation-statement", "confirmation", "routine"],
    ["accounts-with-accounts-type-micro-entity", "accounts", "accounts", "routine"],
    ["create-charge-with-deed", "mortgage", "charges", "material"],
    ["charge-satisfaction-with-date", "mortgage", "charges", "material"],
    ["termination-director-company-with-name", "officers", "officers", "notable"],
    ["appoint-person-director-company-with-name", "officers", "officers", "notable"],
    ["psc-notification-individual", "persons-with-significant-control", "control", "notable"],
    ["capital-allotment-shares", "capital", "capital", "notable"],
    ["capital-reduction-court-order", "capital", "capital", "material"],
    ["gaz1-first-gazette-notice-for-compulsory-strike-off", "gazette", "distress", "material"],
    ["incorporation-company", "incorporation", "formation", "material"],
    ["liquidation-voluntary-appointment-liquidator", "liquidation", "distress", "material"],
    ["insolvency-appointment-of-administrator", "insolvency", "distress", "material"],
    ["change-of-name-certificate", "change-of-name", "registered-details", "notable"],
    ["registered-office-change", "address", "registered-details", "routine"],
    ["resolution-of-alteration-of-articles", "resolution", "governance", "notable"],
  ];

  it.each(cases)("classifies %s", (code, category, group, significance) => {
    const result = classifyFiling(code, category);
    expect(result.group).toBe(group);
    expect(result.significance).toBe(significance);
    expect(result.label.length).toBeGreaterThan(0);
  });

  it("does not read a restoration as a resolution", () => {
    expect(classifyFiling("restoration-application-to-restore-company", "restoration").group).toBe("formation");
  });

  it("falls back to the Companies House category when no rule fires", () => {
    const result = classifyFiling("some-code-we-have-never-seen", "mortgage");
    expect(result.group).toBe("charges");
    expect(result.significance).toBe("material");
  });

  it("degrades to `other` when neither the code nor the category is known", () => {
    expect(classifyFiling("zzz-unknown", "zzz-unknown").group).toBe("other");
  });

  it("survives a missing description code", () => {
    expect(classifyFiling(undefined, "accounts").group).toBe("accounts");
    expect(classifyFiling(undefined, undefined).group).toBe("other");
  });

  it("humanises codes without inventing meaning", () => {
    expect(humaniseCode("psc-notification-individual")).toBe("PSC notification individual");
    expect(humaniseCode("")).toBe("Filing");
  });
});

describe("natures of control", () => {
  it("decomposes a banded shareholding", () => {
    const parsed = parseNatureOfControl("ownership-of-shares-75-to-100-percent");
    expect(parsed).toMatchObject({ right: "shares", band: "75-100", held_via: "direct", scope: "company", partial: false });
    expect(parsed.label).toContain("more than 75%");
  });

  it("decomposes rights held through a trust", () => {
    const parsed = parseNatureOfControl("voting-rights-25-to-50-percent-as-trust");
    expect(parsed).toMatchObject({ right: "voting-rights", band: "25-50", held_via: "trust" });
    expect(parsed.label).toContain("through a trust");
  });

  it("recognises the overseas-entity scope and its open-ended band", () => {
    const parsed = parseNatureOfControl("ownership-of-shares-more-than-25-percent-registered-overseas-entity");
    expect(parsed).toMatchObject({ right: "shares", band: "over-25", scope: "registered-overseas-entity" });
  });

  it("recognises control exercised over a holding firm", () => {
    const parsed = parseNatureOfControl("voting-rights-50-to-75-percent-as-control-over-firm");
    expect(parsed.held_via).toBe("control-over-firm");
  });

  it("handles unbanded rights", () => {
    expect(parseNatureOfControl("right-to-appoint-and-remove-directors")).toMatchObject({
      right: "appoint-remove-directors",
      band: null,
    });
    expect(parseNatureOfControl("significant-influence-or-control")).toMatchObject({
      right: "significant-influence-or-control",
      band: null,
    });
  });

  it("marks partial LLP surplus-asset rights", () => {
    const parsed = parseNatureOfControl("part-right-to-share-surplus-assets-25-to-50-percent-limited-liability-partnership");
    expect(parsed).toMatchObject({ right: "surplus-assets", partial: true, scope: "limited-liability-partnership" });
  });

  it("does not throw on an unrecognised code", () => {
    expect(parseNatureOfControl("something-entirely-new").right).toBe("unknown");
  });
});

describe("PSC statements and kinds", () => {
  it("labels a known statement", () => {
    expect(describeStatement("psc-exists-but-not-identified")).toContain("not identified");
  });

  it("keeps the Companies House spelling of the no-PSC statement working", () => {
    expect(describeStatement("no-individual-or-entity-with-signficant-control")).toContain("no person with significant control");
  });

  it("falls back readably for an unknown statement", () => {
    expect(describeStatement("brand-new-statement")).toBe("Brand new statement.");
  });

  it("identifies individual and super-secure kinds", () => {
    expect(kindIsIndividual("individual-person-with-significant-control")).toBe(true);
    expect(kindIsIndividual("corporate-entity-person-with-significant-control")).toBe(false);
    expect(kindIsIndividual("super-secure-person-with-significant-control")).toBe(false);
    expect(kindIsSuperSecure("super-secure-person-with-significant-control")).toBe(true);
  });
});

describe("company number normalisation", () => {
  it.each([
    ["1234567", "01234567"],
    ["01234567", "01234567"],
    ["SC 090312", "SC090312"],
    ["sc90312", "SC090312"],
    ["oc301540", "OC301540"],
    ["NI-016341", "NI016341"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normaliseCompanyNumber(input)).toBe(expected);
  });

  it.each(["", "   ", "123456789", "SC1234567", "!!!!"])("rejects %s", (input) => {
    expect(() => normaliseCompanyNumber(input)).toThrow(InvalidCompanyNumberError);
  });
});
