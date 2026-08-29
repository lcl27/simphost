#!/usr/bin/env node
/**
 * Runs the tools against a deployed endpoint and real company numbers, then
 * checks that the parsers coped with live Companies House data.
 *
 * This is the check the build environment could not run: its egress proxy
 * blocks api.company-information.service.gov.uk, so every parser in this
 * repository has only ever seen fixtures. Run this once against a free
 * deployment before enabling payments.
 *
 *   node scripts/verify-live.mjs --url https://uk-corporate-mcp.example.workers.dev
 *   node scripts/verify-live.mjs --url ... --companies 00445790,SC090312,OC301540
 *
 * Exits non-zero if anything failed, so it can sit in CI or a quarterly cron.
 */

import { checkCapitalStructure, checkFilingHistory, checkPscVerification, summariseFindings } from "./lib/checks.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  if (key) args.set(key, process.argv[i + 1]);
}

const base = (args.get("url") ?? process.env.MCP_URL ?? "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: verify-live.mjs --url <origin> [--companies 00445790,SC090312]");
  console.error("\nPick company numbers you know. Variety is the point: a long-established");
  console.error("company, a Scottish one (SC), an LLP (OC), one that has been struck off.");
  process.exit(2);
}

// Sample numbers only — replace them with companies you actually know, so that
// you can tell a parsing failure from an unfamiliar company.
const companies = (args.get("companies") ?? "00445790,00000006").split(",").map((c) => c.trim()).filter(Boolean);

let nextId = 1;
async function rpc(method, params) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${await response.text()}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function callTool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) {
    const challenge = result.structuredContent;
    if (challenge?.x402Version) {
      console.error(
        `\nThis deployment requires payment (${challenge.accepts?.[0]?.amount ?? "?"} atomic units).\n` +
          "Run this check against a deployment with X402_PAY_TO unset, which serves the tools free.\n",
      );
      process.exit(3);
    }
    throw new Error(`${name}: ${JSON.stringify(challenge).slice(0, 300)}`);
  }
  return result.structuredContent;
}

console.log(`Verifying ${base} against live Companies House data.\n`);

const health = await fetch(`${base}/health`).then((r) => r.json());
if (!health.companies_house_key_configured) {
  console.error("The deployment has no Companies House API key set. Nothing to verify.");
  process.exit(2);
}

const tools = await rpc("tools/list", {});
console.log(`tools/list returned: ${tools.tools.map((t) => t.name).join(", ")}\n`);

const findings = [];
const unclassified = new Set();
const driftFields = new Set();
const driftCodes = new Set();
const capitalCodes = new Set();

for (const company of companies) {
  const filings = await callTool("get_company_filing_history", { company_number: company, fetch_all: true });
  const filingResult = checkFilingHistory(filings, company);
  findings.push(...filingResult.findings);
  filingResult.unclassified.forEach((c) => unclassified.add(c));

  const psc = await callTool("get_psc_verification_status", { company_number: company, include_ceased: true });
  const pscResult = checkPscVerification(psc, company);
  findings.push(...pscResult.findings);
  pscResult.unknownFields.forEach((f) => driftFields.add(f));
  pscResult.unknownControlCodes.forEach((c) => driftCodes.add(c));

  const capital = await callTool("get_capital_structure", { company_number: company, format: "json" });
  const capitalResult = checkCapitalStructure(capital, company);
  findings.push(...capitalResult.findings);
  capitalResult.unclassifiedCapitalCodes.forEach((c) => capitalCodes.add(c));
}

const { failures, warnings, notes } = summariseFindings(findings);

for (const note of notes) console.log(`  ·  ${note.message}`);
if (warnings.length > 0) {
  console.log("\nWarnings:");
  for (const warning of warnings) console.log(`  !  ${warning.message}`);
}
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  X  ${failure.message}`);
}

if (unclassified.size > 0 || driftFields.size > 0 || driftCodes.size > 0 || capitalCodes.size > 0) {
  console.log("\nTaxonomy work this run identified:");
  if (unclassified.size > 0) console.log(`  filing codes to classify: ${[...unclassified].sort().join(", ")}`);
  if (capitalCodes.size > 0) console.log(`  capital codes to classify: ${[...capitalCodes].sort().join(", ")}`);
  if (driftCodes.size > 0) console.log(`  control codes to decompose: ${[...driftCodes].sort().join(", ")}`);
  if (driftFields.size > 0) console.log(`  verification fields to read: ${[...driftFields].sort().join(", ")}`);
}

console.log(
  `\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} failure(s), ${warnings.length} warning(s), ` +
    `${companies.length} compan${companies.length === 1 ? "y" : "ies"} checked.`,
);
process.exit(failures.length === 0 ? 0 : 1);
