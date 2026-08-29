/**
 * Structural parsing of Companies House PSC vocabulary.
 *
 * As with the filing taxonomy, the Companies House `api-enumerations` prose is
 * not reproduced. Natures of control are instead decomposed from the code itself
 * — every code is systematically constructed — which yields something more
 * useful than a lookup: a caller can filter on "holds more than 25% of voting
 * rights, however held" without pattern-matching English.
 */

export type ControlRight =
  | "shares"
  | "voting-rights"
  | "appoint-remove-directors"
  | "appoint-remove-members"
  | "surplus-assets"
  | "significant-influence-or-control"
  | "unknown";

export type HeldVia = "direct" | "trust" | "firm" | "control-over-trust" | "control-over-firm";
export type ControlScope = "company" | "limited-liability-partnership" | "registered-overseas-entity";

export interface NatureOfControl {
  code: string;
  right: ControlRight;
  /** "25-50", "50-75", "75-100", "over-25", or null where the right is not banded. */
  band: string | null;
  held_via: HeldVia;
  scope: ControlScope;
  /** Partial rights appear on LLP surplus-asset codes. */
  partial: boolean;
  label: string;
}

const RIGHT_PREFIXES: Array<[string, ControlRight]> = [
  ["ownership-of-shares", "shares"],
  ["voting-rights", "voting-rights"],
  ["right-to-appoint-and-remove-directors", "appoint-remove-directors"],
  ["right-to-appoint-and-remove-members", "appoint-remove-members"],
  ["right-to-appoint-and-remove-person", "appoint-remove-directors"],
  ["right-to-share-surplus-assets", "surplus-assets"],
  ["significant-influence-or-control", "significant-influence-or-control"],
];

const RIGHT_LABELS: Record<ControlRight, string> = {
  shares: "shares",
  "voting-rights": "voting rights",
  "appoint-remove-directors": "the right to appoint and remove directors",
  "appoint-remove-members": "the right to appoint and remove members",
  "surplus-assets": "rights over surplus assets",
  "significant-influence-or-control": "significant influence or control",
  unknown: "an unrecognised form of control",
};

const VIA_LABELS: Record<HeldVia, string> = {
  direct: "",
  trust: " held through a trust",
  firm: " held through a firm without legal personality",
  "control-over-trust": " by controlling a trust that holds them",
  "control-over-firm": " by controlling a firm that holds them",
};

function bandLabel(band: string | null): string {
  if (!band) return "";
  if (band === "over-25") return "more than 25% of ";
  const [low, high] = band.split("-");
  if (high === "100") return `more than ${low}% of `;
  return `more than ${low}% but not more than ${high}% of `;
}

export function parseNatureOfControl(rawCode: string): NatureOfControl {
  let code = String(rawCode ?? "").toLowerCase().trim();
  const original = code;

  let scope: ControlScope = "company";
  if (code.endsWith("-registered-overseas-entity")) {
    scope = "registered-overseas-entity";
    code = code.slice(0, -"-registered-overseas-entity".length);
  } else if (code.endsWith("-limited-liability-partnership") || code.endsWith("-llp")) {
    scope = "limited-liability-partnership";
    code = code.replace(/-(limited-liability-partnership|llp)$/, "");
  }

  let heldVia: HeldVia = "direct";
  if (code.endsWith("-as-control-over-trust")) {
    heldVia = "control-over-trust";
    code = code.slice(0, -"-as-control-over-trust".length);
  } else if (code.endsWith("-as-control-over-firm")) {
    heldVia = "control-over-firm";
    code = code.slice(0, -"-as-control-over-firm".length);
  } else if (code.endsWith("-as-trust")) {
    heldVia = "trust";
    code = code.slice(0, -"-as-trust".length);
  } else if (code.endsWith("-as-firm")) {
    heldVia = "firm";
    code = code.slice(0, -"-as-firm".length);
  }

  let band: string | null = null;
  const rangeMatch = /-(\d{2})-to-(\d{2,3})-percent$/.exec(code);
  if (rangeMatch) {
    band = `${rangeMatch[1]}-${rangeMatch[2]}`;
    code = code.slice(0, rangeMatch.index);
  } else if (code.endsWith("-more-than-25-percent")) {
    band = "over-25";
    code = code.slice(0, -"-more-than-25-percent".length);
  }

  const partial = code.startsWith("part-");
  if (partial) code = code.slice("part-".length);

  let right: ControlRight = "unknown";
  for (const [prefix, value] of RIGHT_PREFIXES) {
    if (code === prefix || code.startsWith(`${prefix}-`)) {
      right = value;
      break;
    }
  }

  const subject = RIGHT_LABELS[right];
  const scopeSuffix =
    scope === "registered-overseas-entity"
      ? " in the overseas entity"
      : scope === "limited-liability-partnership"
        ? " in the LLP"
        : band || right === "shares" || right === "voting-rights"
          ? " in the company"
          : " over the company";

  const label = band
    ? `Holds ${partial ? "a part of " : ""}${bandLabel(band)}${subject}${scopeSuffix}${VIA_LABELS[heldVia]}.`
    : `Has ${subject}${scopeSuffix}${VIA_LABELS[heldVia]}.`;

  return { code: original, right, band, held_via: heldVia, scope, partial, label };
}

/**
 * Short labels for PSC statements. Written for this service; the wording is
 * deliberately plain and does not track Companies House's own prose.
 */
const STATEMENT_LABELS: Record<string, string> = {
  "no-individual-or-entity-with-signficant-control": "The company says it has no person with significant control.",
  "no-individual-or-entity-with-significant-control": "The company says it has no person with significant control.",
  "steps-to-find-psc-not-yet-completed": "The company has not finished its search for a person with significant control.",
  "psc-exists-but-not-identified": "The company believes a person with significant control exists but has not identified them.",
  "psc-identified-but-details-not-confirmed": "A person with significant control has been identified but their details are unconfirmed.",
  "psc-details-not-confirmed": "The identified person's details have not been confirmed.",
  "psc-contacted-but-no-response": "The company contacted the person with significant control and received no reply.",
  "restrictions-notice-issued-to-psc": "The company has issued a restrictions notice against the person with significant control.",
  "psc-has-failed-to-confirm-changed-details": "The person with significant control has not confirmed changed details.",
  "psc-details-not-confirmed-by-company": "The company has not confirmed the person's details.",
  "at-least-one-psc-has-not-provided-required-information":
    "At least one person with significant control has not provided the required information.",
  "steps-to-find-psc-not-yet-completed-registered-overseas-entity":
    "The overseas entity has not finished its search for a registrable beneficial owner.",
  "no-individual-or-entity-with-signficant-control-registered-overseas-entity":
    "The overseas entity says it has no registrable beneficial owner.",
};

export function describeStatement(statement: string): string {
  const key = String(statement ?? "").toLowerCase().trim();
  const known = STATEMENT_LABELS[key];
  if (known) return known;
  const words = key.split("-").filter(Boolean).join(" ");
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}.` : "Unrecognised statement.";
}

/** Whether Companies House individual identity verification is expected of this PSC kind. */
export function kindIsIndividual(kind: string | undefined): boolean {
  const value = String(kind ?? "").toLowerCase();
  return value.includes("individual") && !value.includes("super-secure");
}

export function kindIsSuperSecure(kind: string | undefined): boolean {
  return String(kind ?? "").toLowerCase().includes("super-secure");
}
