# Deploying

Target: Cloudflare Workers free tier. Cost to stand up is the domain (optional)
and nothing else; the Companies House API key is free.

## The short version

```bash
npm install
npx wrangler login          # or export CLOUDFLARE_API_TOKEN
npm run setup
```

`scripts/setup.sh` creates the KV namespace, sets the secrets, deploys with
payments off, pins `PUBLIC_BASE_URL`, and runs the live verification. It is safe
to re-run and each step checks whether it has already been done. It stops short
of the wallet, deliberately.

The rest of this document is what that script does, and the parts it cannot.

## 1. Companies House API key

Register at <https://developer.company-information.service.gov.uk/>, create an
application, and take a **REST API key** (not a streaming key). The free tier
allows 600 requests per five minutes, which is far more than this endpoint will
plausibly need.

## 2. Install and configure

```bash
cd uk-corporate-mcp
npm install
```

Create the usage ledger and paste the returned id into `wrangler.jsonc`:

```bash
npx wrangler kv namespace create METER
```

## 3. Secrets

Never put these in `wrangler.jsonc`.

```bash
npx wrangler secret put CH_API_KEY            # Companies House REST key
npx wrangler secret put ADMIN_TOKEN           # guards GET /admin/usage
npx wrangler secret put X402_FACILITATOR_TOKEN  # only if your facilitator authenticates
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill it in.
`.dev.vars` is gitignored; keep it that way.

## 4. First deploy — free, to check the plumbing

Leave `X402_PAY_TO` empty. With no receiving wallet the service serves the tools
free rather than emitting a 402 nobody can satisfy, so you can prove the
Companies House side works before involving money.

```bash
npx wrangler deploy
curl https://<your-worker>.workers.dev/health
curl -X POST https://<your-worker>.workers.dev/v1/filing-history \
  -H 'content-type: application/json' \
  -d '{"company_number":"00445790"}'
```

Then set `PUBLIC_BASE_URL` in `wrangler.jsonc` to the deployed origin, so that the
resource URLs inside payment challenges and the discovery document are stable
rather than derived from whatever hostname the request arrived on.

## 5. Turn payments on

Set `X402_PAY_TO` in `wrangler.jsonc` to your receiving address and redeploy.

Stay on Base Sepolia (`eip155:84532`, the default) until a payment has actually
round-tripped. To move to mainnet, change **both** together:

```jsonc
"X402_NETWORK": "eip155:8453",
"X402_ASSET": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  // USDC on Base
```

Changing one without the other will advertise a requirement no client can
satisfy — the asset address is network-specific.

### Facilitator

The default is `https://x402.org/facilitator`, which settles testnet only. For
mainnet you need a facilitator that settles on Base — Coinbase CDP is the
obvious one — and it will require `X402_FACILITATOR_TOKEN`.

The service asks the facilitator what it supports and drops anything it cannot
settle, so a facilitator that does not implement the `upto` scheme simply results
in `exact` being the only advertised option. No configuration change needed.

## 6. Verify the paywall

```bash
curl -i -X POST https://<your-worker>.workers.dev/v1/filing-history \
  -H 'content-type: application/json' \
  -d '{"company_number":"00445790"}'
```

Expect `402`, a `PAYMENT-REQUIRED` header carrying base64 JSON, and the same
object in the body. Decode it:

```bash
curl -sI -X POST ... | grep -i payment-required | cut -d' ' -f2 | base64 -d | jq
```

Then check the MCP side is discoverable without payment:

```bash
curl -X POST https://<your-worker>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

## 7. Verify against live data

Do this before enabling payments. Everything in this repository was written
against the published Companies House schema and hermetic fixtures — the build
environment's egress proxy blocked `api.company-information.service.gov.uk`, so
no parser here has seen a real response.

```bash
npm run verify -- --url https://<your-worker>.workers.dev
npm run verify -- --url https://<your-worker>.workers.dev --companies 00445790,SC090312,OC301540
```

It exercises all three tools, including building the capital workbook.

Pick company numbers you know, and pick variety: a long-established company, a
Scottish one, an LLP, one that has been struck off. The check asserts the shape
held — classifications present, chronology dates ordered, verification statuses
inside the documented set, uncertainty still reported as `null` — and then
reports what the parsers did *not* recognise:

- filing description codes that fell through to `other`
- capital filing codes that did not classify to a specific event
- capital figures that did not parse to a number
- nature-of-control codes it could not decompose
- fields inside `identity_verification_details` it does not read

That last one is the ECCTA drift detector. It exits non-zero on failure, so it
also works as the quarterly maintenance job rather than something to remember.

Run it against a deployment with `X402_PAY_TO` unset; it will tell you plainly
if it hits a paywall instead.

## 8. Watch it

```bash
npm run usage -- --url https://<your-worker>.workers.dev --token "$ADMIN_TOKEN"
```

Thirty days of zeros is a complete answer, and the point of the ledger is that
you can tell zero from "no instrumentation". `wrangler tail` gives live logs
alongside it.

## Free-tier limits worth knowing

- Workers: 100,000 requests/day.
- KV: 1,000 writes/day. The ledger writes once per call, so the ledger is the
  first thing to hit a limit — at which point you have a much better problem than
  a missing log line. Ledger writes fail open and never break a paid call.
- Analytics Engine (optional, Workers Paid): uncomment the binding in
  `wrangler.jsonc` for queryable history alongside KV.
