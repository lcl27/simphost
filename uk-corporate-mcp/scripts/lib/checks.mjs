/**
 * Checks run against live Companies House responses.
 *
 * The build environment could not reach api.company-information.service.gov.uk,
 * so the parsers in this repository have only ever seen fixtures. These checks
 * are what closes that gap: they assert the shape held, and — more usefully —
 * they report the codes and fields the parsers did *not* recognise, which is the
 * quarterly upstream-drift task made mechanical.
 */

export function checkFilingHistory(payload, companyNumber) {
  const findings = [];
  const fail = (message) => findings.push({ level: "fail", message });
  const warn = (message) => findings.push({ level: "warn", message });
  const note = (message) => findings.push({ level: "note", message });

  if (payload?.error) {
    return { findings: [{ level: "fail", message: `${companyNumber}: ${payload.error} — ${payload.message ?? ""}` }], unclassified: [] };
  }

  const items = payload?.items ?? [];
  if (items.length === 0) {
    warn(`${companyNumber}: no filings returned. Real, but unhelpful for checking the taxonomy — try a company with history.`);
    return { findings, unclassified: [] };
  }

  note(`${companyNumber}: ${items.length} filings, ${payload.paging?.total_count ?? "?"} total.`);

  // Every filing must carry a classification. A missing group means the
  // normaliser broke, not that the taxonomy is thin.
  const ungrouped = items.filter((i) => !i.group || !i.significance);
  if (ungrouped.length > 0) fail(`${companyNumber}: ${ungrouped.length} filings came back with no group or significance.`);

  // Landing in `other` is the taxonomy being incomplete, which is expected at
  // the edges and worth reporting rather than failing on.
  const unclassified = [...new Set(items.filter((i) => i.group === "other").map((i) => i.description_code).filter(Boolean))];
  const share = items.filter((i) => i.group === "other").length / items.length;
  if (share > 0.25) {
    fail(`${companyNumber}: ${Math.round(share * 100)}% of filings fell through to "other". The taxonomy is not matching live codes.`);
  } else if (unclassified.length > 0) {
    warn(`${companyNumber}: ${unclassified.length} description code(s) unclassified: ${unclassified.join(", ")}`);
  }

  const chronology = payload?.chronology;
  if (!chronology) {
    fail(`${companyNumber}: no chronology was derived.`);
    return { findings, unclassified };
  }
  if (!chronology.first_filing_date || !chronology.last_filing_date) {
    fail(`${companyNumber}: chronology is missing its first or last filing date.`);
  } else if (chronology.first_filing_date > chronology.last_filing_date) {
    fail(`${companyNumber}: chronology dates are inverted (${chronology.first_filing_date} > ${chronology.last_filing_date}).`);
  } else {
    note(`${companyNumber}: filings span ${chronology.first_filing_date} to ${chronology.last_filing_date}.`);
  }

  const events = chronology.material_events ?? [];
  const ordered = events.every((e, i) => i === 0 || (events[i - 1].date ?? "") >= (e.date ?? ""));
  if (!ordered) fail(`${companyNumber}: material events are not in newest-first order.`);

  const groups = Object.keys(chronology.counts_by_group ?? {});
  if (groups.length === 0) fail(`${companyNumber}: counts_by_group is empty.`);
  else note(`${companyNumber}: groups seen — ${groups.sort().join(", ")}.`);

  return { findings, unclassified };
}

/** Verification fields the parser knows how to read. Anything else is drift. */
const KNOWN_VERIFICATION_FIELDS = new Set([
  "identity_verified_on",
  "identity_verification_date",
  "verified_on",
  "appointment_verification_statement_date",
  "verification_statement_date",
  "appointment_verification_statement_due_on",
  "appointment_verification_end_on",
  "appointment_verification_start_on",
  "authorised_corporate_service_provider_name",
  "acsp_name",
  "anti_money_laundering_supervisory_body",
  "anti_money_laundering_supervisory_bodies",
]);

const KNOWN_STATUSES = new Set(["verified", "unverified", "not_reported", "protected", "ceased"]);

export function checkPscVerification(payload, companyNumber) {
  const findings = [];
  const fail = (message) => findings.push({ level: "fail", message });
  const warn = (message) => findings.push({ level: "warn", message });
  const note = (message) => findings.push({ level: "note", message });

  if (payload?.error) {
    return { findings: [{ level: "fail", message: `${companyNumber}: ${payload.error} — ${payload.message ?? ""}` }], unknownFields: [], unknownControlCodes: [] };
  }

  const pscs = payload?.persons_with_significant_control ?? [];
  const summary = payload?.summary;
  if (!summary) {
    fail(`${companyNumber}: no summary was produced.`);
    return { findings, unknownFields: [], unknownControlCodes: [] };
  }

  note(`${companyNumber}: ${summary.assessment}`);

  const unknownFields = new Set();
  const unknownControlCodes = new Set();

  for (const psc of pscs) {
    const status = psc?.identity_verification?.status;
    if (!KNOWN_STATUSES.has(status)) fail(`${companyNumber}: unrecognised verification status "${status}".`);

    // The ECCTA verification object has changed shape more than once. A field we
    // do not read is not a failure, but it is the thing to look at next.
    for (const key of Object.keys(psc?.identity_verification?.raw ?? {})) {
      if (!KNOWN_VERIFICATION_FIELDS.has(key)) unknownFields.add(key);
    }

    for (const nature of psc?.natures_of_control ?? []) {
      if (nature.right === "unknown") unknownControlCodes.add(nature.code);
    }
  }

  if (unknownFields.size > 0) {
    warn(
      `${companyNumber}: identity_verification_details carried field(s) the parser does not read: ` +
        `${[...unknownFields].join(", ")}. Check whether they change the status.`,
    );
  }
  if (unknownControlCodes.size > 0) {
    warn(`${companyNumber}: nature-of-control code(s) not decomposed: ${[...unknownControlCodes].join(", ")}`);
  }

  // The distinction the whole tool turns on: absence of data must not read as
  // a negative finding.
  if (summary.active_individual_count > 0 && summary.individuals_verification_not_reported > 0) {
    if (summary.all_active_individuals_verified !== null) {
      fail(`${companyNumber}: verification data is missing for some individuals but all_active_individuals_verified is not null.`);
    } else {
      note(`${companyNumber}: verification correctly reported as undetermined for ${summary.individuals_verification_not_reported} individual(s).`);
    }
  }

  if (payload.statements === undefined) warn(`${companyNumber}: the statements register was not read.`);

  return { findings, unknownFields: [...unknownFields], unknownControlCodes: [...unknownControlCodes] };
}

export function summariseFindings(all) {
  return {
    failures: all.filter((f) => f.level === "fail"),
    warnings: all.filter((f) => f.level === "warn"),
    notes: all.filter((f) => f.level === "note"),
  };
}
