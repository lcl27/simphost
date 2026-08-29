#!/usr/bin/env node
/**
 * Prints the usage ledger as a table.
 *
 * The first month's question is whether anything calls the endpoint at all, and
 * that question is only answerable if the silence is measured rather than
 * assumed.
 *
 *   npm run usage -- --url https://uk-corporate-mcp.example.workers.dev --token "$ADMIN_TOKEN"
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  if (key) args.set(key, process.argv[i + 1]);
}

const base = args.get("url") ?? process.env.MCP_URL;
const token = args.get("token") ?? process.env.ADMIN_TOKEN;
const limit = args.get("limit") ?? "1000";

if (!base || !token) {
  console.error("usage: usage-report.mjs --url <origin> --token <admin token> [--limit 1000]");
  process.exit(2);
}

const response = await fetch(`${base.replace(/\/+$/, "")}/admin/usage?limit=${encodeURIComponent(limit)}`, {
  headers: { authorization: `Bearer ${token}` },
});

if (!response.ok) {
  console.error(`${response.status} ${response.statusText}: ${await response.text()}`);
  process.exit(1);
}

const summary = await response.json();

if (summary.scanned === 0) {
  console.log("No calls recorded. That is a finding, not a failure.");
  process.exit(0);
}

const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`);

console.log(`\nCalls recorded: ${summary.scanned}`);
console.log(`Window: ${summary.window.from ?? "-"} to ${summary.window.to ?? "-"}\n`);

line("Distinct payers", summary.distinct_payers);
line("Distinct companies asked", summary.distinct_subjects);
line("Total settled (atomic)", summary.total_charged_atomic);

const table = (title, record) => {
  const entries = Object.entries(record).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return;
  console.log(`\n${title}`);
  for (const [key, count] of entries) line(`  ${key}`, count);
};

table("By outcome", summary.by_outcome);
table("By tool", summary.by_tool);
table("By client", summary.by_client);
table("By day", summary.by_day);

console.log("\nMost recent:");
for (const event of summary.recent.slice(0, 10)) {
  console.log(
    `  ${event.ts}  ${event.outcome.padEnd(16)} ${event.tool.padEnd(30)} ` +
      `${event.subject ?? "-"}  ${event.charged ?? "-"}  ${event.client ?? "-"}`,
  );
}
console.log();
