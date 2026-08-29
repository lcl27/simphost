/**
 * A classification of Companies House filing-history entries.
 *
 * Companies House returns a terse `description` code (for example
 * `capital-allotment-shares`) and its own `category`. The rendered English for
 * those codes lives in the Companies House `api-enumerations` files, which carry
 * no stated licence, so nothing from them is reproduced here. What follows is an
 * original grouping and set of labels written for this service: coarser than
 * Companies House's own categories, and organised around what a diligence
 * question actually turns on rather than around which form was filed.
 *
 * See docs/LICENSING.md.
 */

export type FilingGroup =
  | "formation"
  | "accounts"
  | "confirmation"
  | "officers"
  | "control"
  | "capital"
  | "charges"
  | "distress"
  | "registered-details"
  | "governance"
  | "notices"
  | "administrative"
  | "other";

/**
 * How much a filing tends to matter when reading a company's history.
 * `routine` filings establish that a company is current; `notable` ones change
 * who runs or owns it; `material` ones change whether it survives or what it is
 * secured against.
 */
export type Significance = "routine" | "notable" | "material";

export interface FilingClassification {
  group: FilingGroup;
  significance: Significance;
  label: string;
}

export const FILING_GROUPS: Record<FilingGroup, string> = {
  formation: "Formation, restoration and re-registration",
  accounts: "Statutory accounts",
  confirmation: "Confirmation statements and annual returns",
  officers: "Directors and secretaries",
  control: "Persons with significant control",
  capital: "Share capital",
  charges: "Charges and security",
  distress: "Insolvency, strike-off and dissolution",
  "registered-details": "Registered office, name and registers",
  governance: "Resolutions, articles and auditors",
  notices: "Gazette notices",
  administrative: "Certificates, corrections and replacements",
  other: "Unclassified",
};

interface Rule {
  group: FilingGroup;
  significance: Significance;
  label: string;
  /** Matched against the lowercased description code. */
  test: (code: string) => boolean;
}

const startsWith = (...prefixes: string[]) => (code: string) => prefixes.some((p) => code.startsWith(p));
const contains = (...needles: string[]) => (code: string) => needles.some((n) => code.includes(n));

/**
 * Ordered: the first rule that matches wins, so narrower tests come before the
 * broad prefix tests they would otherwise be swallowed by.
 */
const RULES: Rule[] = [
  // Distress — checked first, because insolvency filings borrow vocabulary from
  // every other group (an insolvency practitioner's appointment is not an
  // officer appointment, and a liquidator's accounts are not statutory accounts).
  { group: "distress", significance: "material", label: "Strike-off action", test: startsWith("gaz1", "gaz2", "voluntary-dissolution", "dissolution", "strike-off", "gazette-strike") },
  { group: "distress", significance: "material", label: "Administration", test: contains("administration", "administrator") },
  { group: "distress", significance: "material", label: "Receivership", test: contains("receiver") },
  { group: "distress", significance: "material", label: "Liquidation", test: contains("liquidat", "winding-up", "creditors-voluntary", "members-voluntary") },
  { group: "distress", significance: "material", label: "Insolvency proceedings", test: startsWith("insolvency") },
  { group: "distress", significance: "material", label: "Company voluntary arrangement", test: contains("voluntary-arrangement", "moratorium") },

  // Charges.
  { group: "charges", significance: "material", label: "Charge satisfied or released", test: contains("charge-satisf", "satisfaction", "release-of-charge", "ceasing-to-be-subject") },
  { group: "charges", significance: "material", label: "Charge registered", test: startsWith("mortgage", "charge", "create-charge", "legacy-charge") },

  // Share capital.
  { group: "capital", significance: "material", label: "Capital reduction", test: contains("capital-reduction", "reduction-in-capital", "reduction-of-capital", "solvency-statement") },
  { group: "capital", significance: "notable", label: "Share allotment", test: contains("allotment") },
  { group: "capital", significance: "notable", label: "Purchase or redemption of own shares", test: contains("purchase-of-own-shares", "redemption", "treasury", "cancellation-of-shares") },
  { group: "capital", significance: "notable", label: "Share capital change", test: startsWith("capital") },

  // People.
  { group: "control", significance: "notable", label: "Person with significant control", test: startsWith("psc", "persons-with-significant-control") },
  { group: "control", significance: "notable", label: "Person with significant control", test: contains("significant-control", "beneficial-owner") },
  { group: "officers", significance: "notable", label: "Officer ceased", test: contains("termination", "resignation", "cessation", "ceased") },
  { group: "officers", significance: "notable", label: "Officer appointed", test: contains("appoint") },
  { group: "officers", significance: "routine", label: "Officer particulars changed", test: startsWith("officers", "change-person", "director", "secretary") },

  // Periodic filings.
  { group: "confirmation", significance: "routine", label: "Confirmation statement", test: startsWith("confirmation-statement", "annual-return", "ar01") },
  { group: "accounts", significance: "routine", label: "Accounting reference date changed", test: contains("accounting-reference-date", "period-of-accounts") },
  { group: "accounts", significance: "routine", label: "Statutory accounts", test: startsWith("accounts", "aa") },

  // Constitutional and registered details.
  { group: "registered-details", significance: "routine", label: "Registered office changed", test: contains("registered-office", "sail", "single-alternative") },
  { group: "registered-details", significance: "notable", label: "Name changed", test: contains("change-of-name", "change-name", "name-change") },
  { group: "registered-details", significance: "routine", label: "Register location or election", test: contains("register-", "elect-to-keep", "withdrawal-of-election") },
  { group: "registered-details", significance: "routine", label: "Registered email address", test: contains("registered-email") },
  // Formation. Placed before the governance rules so that "restoration" is not
  // swallowed by a resolution test, and after the name-change rule so that a
  // certificate of incorporation on change of name is read as the name change.
  { group: "formation", significance: "material", label: "Restoration to the register", test: contains("restoration", "restore") },
  { group: "formation", significance: "material", label: "Re-registration", test: contains("re-registration", "reregistration") },
  { group: "formation", significance: "material", label: "Incorporation", test: startsWith("incorporation", "newinc", "certificate-of-incorporation") },

  { group: "governance", significance: "notable", label: "Articles amended", test: contains("articles", "memorandum", "constitution") },
  { group: "governance", significance: "notable", label: "Resolution", test: startsWith("resolution") },
  { group: "governance", significance: "notable", label: "Auditor change", test: contains("auditor") },

  // Everything else.
  { group: "notices", significance: "routine", label: "Gazette notice", test: startsWith("gazette", "gaz") },
  { group: "administrative", significance: "routine", label: "Document replaced or corrected", test: contains("replacement", "second-filing", "correction", "voluntary-amendment") },
  { group: "administrative", significance: "routine", label: "Certificate issued", test: contains("certificate") },
];

/** Fall back to the Companies House category when no rule fires. */
const CATEGORY_FALLBACK: Record<string, { group: FilingGroup; significance: Significance }> = {
  accounts: { group: "accounts", significance: "routine" },
  address: { group: "registered-details", significance: "routine" },
  "annual-return": { group: "confirmation", significance: "routine" },
  auditors: { group: "governance", significance: "notable" },
  capital: { group: "capital", significance: "notable" },
  certificate: { group: "administrative", significance: "routine" },
  "change-of-name": { group: "registered-details", significance: "notable" },
  "confirmation-statement": { group: "confirmation", significance: "routine" },
  dissolution: { group: "distress", significance: "material" },
  "document-replacement": { group: "administrative", significance: "routine" },
  gazette: { group: "notices", significance: "routine" },
  historical: { group: "administrative", significance: "routine" },
  incorporation: { group: "formation", significance: "material" },
  insolvency: { group: "distress", significance: "material" },
  liquidation: { group: "distress", significance: "material" },
  miscellaneous: { group: "administrative", significance: "routine" },
  mortgage: { group: "charges", significance: "material" },
  officers: { group: "officers", significance: "notable" },
  "persons-with-significant-control": { group: "control", significance: "notable" },
  "registered-office-address": { group: "registered-details", significance: "routine" },
  resolution: { group: "governance", significance: "notable" },
  restoration: { group: "formation", significance: "material" },
};

const ACRONYMS = new Set(["psc", "sail", "cic", "llp", "uk", "eea", "vat", "ard", "cvl", "mvl", "cva"]);

/** Turn an unmatched code into something readable without inventing meaning. */
export function humaniseCode(code: string): string {
  const words = code.split(/[-_]/).filter(Boolean);
  if (words.length === 0) return "Filing";
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word.toUpperCase();
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      return word;
    })
    .join(" ");
}

export function classifyFiling(descriptionCode: string | undefined, category?: string): FilingClassification {
  const code = (descriptionCode ?? "").toLowerCase().trim();

  if (code) {
    for (const rule of RULES) {
      if (rule.test(code)) return { group: rule.group, significance: rule.significance, label: rule.label };
    }
  }

  const fallback = CATEGORY_FALLBACK[(category ?? "").toLowerCase().trim()];
  if (fallback) {
    return { group: fallback.group, significance: fallback.significance, label: code ? humaniseCode(code) : humaniseCode(category ?? "") };
  }

  return { group: "other", significance: "routine", label: code ? humaniseCode(code) : "Filing" };
}
