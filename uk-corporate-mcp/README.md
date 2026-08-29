# uk-corporate-mcp

A metered MCP endpoint over open UK corporate reference data, priced per call in
x402 so that an AI agent can discover it, pay for it and use it without anyone
being sold anything.

Two tools, both read-only, both over the free Companies House public data API:

| Tool | What it answers |
| --- | --- |
| `get_company_filing_history` | Every filing classified into one of thirteen groups with a significance rating, plus a derived chronology: first and last filing, filings per year, the latest accounts and confirmation statement, and every material event — charges, insolvency, strike-off, capital reductions, restorations. |
| `get_psc_verification_status` | Persons with significant control, each with Companies House identity-verification status resolved to `verified` / `unverified` / `not_reported` / `protected` / `ceased`, and each nature of control decomposed into right, percentage band, how it is held and scope. Includes the PSC statements register. |

Runs on Cloudflare Workers. Free tier is sufficient.

## The honest framing

This is an option on a market that may not arrive, not an income line. Treat
present revenue as approximately zero and the modal outcome as nil.

What justifies building it is the near-zero cost of holding the option after two
platform changes in August 2026 — Bedrock AgentCore Payments reaching GA with the
x402 `upto` scheme, and agent identity reaching production — not evidence of
paying demand. Sub-dollar x402 volume was reported as falling through Q1 2026,
and micropayment demand as "just not there yet". The asset being built is a
clean, licensed dataset with a live endpoint and a usage history, which retains
standalone value to a RegTech buyer if no agent ever pays for a call.

The one question the first month answers is whether anything calls it at all.
Everything in `src/metering` exists to make sure that question is answerable, and
thirty days of zeros is a complete answer.

## What makes it worth paying for

Companies House already gives the raw data away. The value added here is the part
that is tedious to assemble and easy to get wrong:

- **Filing histories arrive as a flat, paginated list of form codes.** The
  question being asked of them is almost always "when did this company last do
  anything that matters", which is a chronology, not a list. `chronology` answers
  it directly.
- **Nature-of-control codes are decomposed, not translated.** Every Companies
  House PSC code is systematically constructed, so
  `voting-rights-50-to-75-percent-as-trust` parses to
  `{ right: "voting-rights", band: "50-75", held_via: "trust" }`. A caller can
  filter on "more than 25% of voting rights, however held" without
  pattern-matching English.
- **Verification status distinguishes "unverified" from "not reported".**
  Companies House publishes identity-verification data progressively. Absence of
  a verification date is not evidence that a person is unverified, and a
  compliance caller that treats it as such will be wrong about a real person.
  The summary returns `null` for "not determinable" rather than resolving
  uncertainty to a convenient default.

## Billing, and what is deliberately not charged for

- **Discovery is free.** `initialize`, `tools/list` and `ping` never require
  payment, so an agent can read the schemas and the prices before it spends
  anything. Prices are advertised in `tools/list` under `_meta["x402/price"]`.
- **Settlement happens after the tool succeeds.** A caller is never charged for a
  response it did not receive.
- **Bad arguments, unknown company numbers, rate limits and upstream faults are
  not charged for.** Agents that get billed for 404s stop calling.
- **`exact`** settles a flat US$0.002. **`upto`** authorises a US$0.01 ceiling and
  settles US$0.002 plus US$0.001 per additional upstream request — so paging a
  long filing history costs more than a single lookup, and a cheap call stays
  cheap.

Both schemes are advertised, and anything the configured facilitator cannot
settle is dropped from `accepts` rather than offered. A client never sees a
payment requirement it cannot satisfy.

## Layout

```
src/
  index.ts                    routing, CORS, admin
  landing.ts                  the page a person gets at /
  discovery.ts                service card and the x402 resource listing
  http-api.ts                 REST mirror using the x402 HTTP transport
  env.ts                      configuration, and the rule that a half-configured
                              deployment serves free rather than un-payably
  mcp/server.ts               JSON-RPC: initialize, tools/list, tools/call
  x402/
    types.ts                  v2 wire types
    pricing.ts                integer micro-dollar arithmetic, no floats
    requirements.ts           builds `accepts`; matches a client's choice back to
                              *our* requirements, never the client's
    facilitator.ts            /verify, /settle, /supported
    gate.ts                   the paywall, transport-agnostic
  companies-house/
    client.ts                 auth, edge cache, error classification, company
                              number normalisation
    taxonomy.ts               filing classification (original — see LICENSING)
    psc-taxonomy.ts           structural parsing of PSC vocabulary
  tools/                      the two tool definitions
  metering/ledger.ts          per-call instrumentation, fails open
```

## Security note

The payment payload is attacker-controlled. Nothing from it is forwarded to the
facilitator: `selectRequirements` matches the client's stated choice back to the
server's own advertised requirements by scheme and network, checks that asset,
`payTo` and amount agree, and then verifies and settles against the server's
object. A client cannot name its own price, redirect settlement, or substitute
the asset. This is covered by tests in `test/x402.test.ts`.

## Getting it live

```bash
npm install
npm run setup     # KV, secrets, deploy, then verify against live data
```

`scripts/setup.sh` does the mechanical half of first deployment and is safe to
re-run. It cannot create your Cloudflare or Companies House accounts, and it
will not stand up a wallet — it prints what remains yours to do and stops.

Then, before enabling payments:

```bash
npm run verify -- --url https://<your-worker>.workers.dev
```

This is the check that could not be run when the code was written. It calls both
tools against real company numbers and reports whether the parsers coped:
filing codes that fell through to `other`, nature-of-control codes it could not
decompose, and any field in `identity_verification_details` it does not read.
Non-zero exit on failure, so it can sit in a quarterly cron — which is exactly
the upstream-drift task that otherwise needs remembering.

## Development

```bash
npm install
npm test          # 138 tests, no network
npm run typecheck
npm run dev       # wrangler dev
```

Tests stub both upstreams — Companies House and the facilitator — so the suite is
hermetic. Fixtures in `test/fixtures` follow the shape of Companies House
responses; the values are invented.

## Documentation

- [`docs/LICENSING.md`](docs/LICENSING.md) — **read first.** What is used, what is
  deliberately not, why the Companies House enumeration files are not vendored,
  and the four open items that need a human.
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — Companies House key, KV, secrets, going
  from free to paid, testnet to mainnet.
- [`docs/DISCOVERY.md`](docs/DISCOVERY.md) — where to list it, and what in the
  usage data would count as a signal.

## Limits

- Verified against the published Companies House API schema and hermetic
  fixtures, **not** against the live API — the build environment could not reach
  `api.company-information.service.gov.uk`. Run `npm run verify` against the
  first deployment before enabling payments; it exists precisely to close this
  gap. The PSC identity-verification fields in particular have changed shape more
  than once since the ECCTA provisions commenced; the parser is deliberately
  tolerant and degrades to `not_reported`, but it has not seen live data.
- `fetch_all` pages to 500 filings. Beyond that the chronology is flagged
  `derived_from_complete_history: false` rather than silently truncated.
- The KV free tier allows 1,000 writes/day and the ledger writes once per call.
  Ledger writes fail open.
- Quarterly schema maintenance is the standing human task: Companies House
  changes field shapes, and upstream drift is what will break this first.
  `npm run verify` is the instrument for it — it names the codes and fields that
  have drifted rather than just failing.

## Licence

Code: see the repository. Data: Companies House, under the Open Government
Licence v3.0 — attribution is carried in every response. This service reports
what the public register says. It is not a regulated KYC or sanctions check, and
it is not advice.
