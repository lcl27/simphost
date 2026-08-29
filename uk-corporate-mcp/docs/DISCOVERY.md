# Discovery

If the thesis is right, the buyer is not found or pitched — it is discovered and
priced. That puts the whole weight of distribution on being listed and being
machine-readable. This is the checklist.

## What the service already publishes

| Surface | Path | Purpose |
| --- | --- | --- |
| x402 resource listing | `/.well-known/x402` (also `/discovery/resources`) | Bazaar-shaped listing of all four resources — two MCP tools, two HTTP endpoints — with live `accepts` blocks. |
| Service card | `/` | JSON for agents, a page for people, from the same handler. |
| MCP endpoint | `/mcp` | Streamable HTTP. `initialize`, `tools/list` and `ping` are free, so a client can read schemas and prices before spending. |
| Health | `/health` | Configuration state without leaking secrets. |

Prices are advertised inside `tools/list` under `_meta["x402/price"]`, so an
agent can budget before it commits. This is not part of the MCP schema; it is
namespaced under `_meta` as the specification requires, and clients that ignore
it lose nothing.

## Where to list it

Each of these needs an account and a human; none of it can be done from here.

1. **MCP registry.** `server.json` in the repository root is prepared for
   submission — check the `$schema` URL is current at the time you submit, and
   set the deployed URL. The registry is the single highest-value listing,
   because it is what MCP clients enumerate.
2. **x402 Bazaar / indexes.** Point them at `/.well-known/x402`. The document is
   already in the shape section 8 of the x402 v2 specification describes, with
   `resource`, `type`, `accepts`, `lastUpdated` and `metadata` per item.
3. **AWS Bedrock AgentCore paid-API discovery.** The premise of the whole
   exercise. Register both HTTP resources; they carry `accepts` entries for the
   `upto` scheme where the facilitator supports it, which is the scheme AgentCore
   added at GA and the one that fits metered pricing.
4. **Awesome-MCP style lists and the Cloudflare MCP directory.** Low effort,
   non-zero traffic, no downside.

## What to instrument, and what would count as a signal

Every call is recorded — including the ones that stop at a 402 and never come
back, which is the most informative outcome there is. `npm run usage` reports:

- **by_outcome** — `payment_required` far exceeding `paid` means agents are
  finding the endpoint and declining to pay. That is a pricing or trust answer,
  and a much better problem than silence.
- **distinct_payers** — one repeat payer is worth more than fifty one-shot
  testers. The Chainalysis figures behind this brief show tester-to-payer
  conversion improving; this is where you would see it or fail to.
- **by_client** — which agent frameworks arrive at all.
- **distinct_subjects** — whether callers are asking about many companies
  (a real workflow) or the same one repeatedly (someone's smoke test).
- **by_day** — whether a listing produced a step change.

Thirty days of zeros across all of these is a complete and sufficient answer, and
it is worth taking at face value rather than rebuilding the endpoint. The
assembled classification work still stands on its own.
