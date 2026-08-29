#!/usr/bin/env bash
#
# Does the mechanical half of first deployment: KV namespace, secrets, deploy,
# and the live verification run. The half it cannot do — creating accounts,
# accepting terms, holding a wallet — is listed at the end.
#
#   ./scripts/setup.sh
#
# Safe to re-run: each step checks whether it has already been done.

set -euo pipefail

cd "$(dirname "$0")/.."
CONFIG="wrangler.jsonc"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
die()  { printf '\033[31m    %s\033[0m\n' "$1" >&2; exit 1; }

step "Checking prerequisites"
command -v npx >/dev/null || die "npx not found. Install Node 20 or later."
[ -d node_modules ] || { echo "    Installing dependencies..."; npm install --no-audit --no-fund; }

# `wrangler whoami` exits 0 even when unauthenticated, so check what it says
# rather than what it returns.
WHOAMI=$(npx wrangler whoami 2>&1 || true)
if printf '%s' "$WHOAMI" | grep -qi 'not authenticated'; then
  warn "Not authenticated with Cloudflare. Either:"
  warn "  npx wrangler login                 (interactive, opens a browser)"
  warn "  export CLOUDFLARE_API_TOKEN=...    (non-interactive, e.g. in CI)"
  exit 1
fi
printf '%s' "$WHOAMI" | grep -iE 'account (name|id)|associated with the email' || true

step "Usage ledger (KV namespace)"
if grep -q 'REPLACE_WITH_KV_NAMESPACE_ID' "$CONFIG"; then
  echo "    Creating namespace METER..."
  OUTPUT=$(npx wrangler kv namespace create METER 2>&1) || die "Namespace creation failed:
$OUTPUT"
  # Wrangler's output format has changed across versions; a 32-hex id is the
  # stable thing to look for.
  KV_ID=$(printf '%s' "$OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$KV_ID" ] || die "Could not find the namespace id in wrangler's output. Paste it into $CONFIG by hand:
$OUTPUT"
  sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/$KV_ID/" "$CONFIG" && rm -f "$CONFIG.bak"
  echo "    Namespace $KV_ID written to $CONFIG."
else
  echo "    Already configured."
fi

step "Secrets"
echo "    Companies House REST API key — paste it at the prompt."
echo "    Get one free at https://developer.company-information.service.gov.uk/"
npx wrangler secret put CH_API_KEY

if command -v openssl >/dev/null; then
  ADMIN_TOKEN=$(openssl rand -hex 24)
  printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN
  echo "    ADMIN_TOKEN generated. Save it now, it is not recoverable:"
  printf '\n      %s\n\n' "$ADMIN_TOKEN"
else
  warn "openssl not found — set ADMIN_TOKEN yourself:  npx wrangler secret put ADMIN_TOKEN"
fi

step "Deploying (payments off)"
echo "    X402_PAY_TO is empty, so the tools are served free. That is deliberate:"
echo "    prove the Companies House side works before involving money."
DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1) || die "Deploy failed:
$DEPLOY_OUTPUT"
printf '%s\n' "$DEPLOY_OUTPUT" | tail -5

URL=$(printf '%s' "$DEPLOY_OUTPUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$URL" ] || die "Could not read the deployed URL from wrangler's output. Set PUBLIC_BASE_URL in $CONFIG by hand and redeploy."

step "Pinning PUBLIC_BASE_URL to $URL"
# Resource URLs inside payment challenges must be stable, not derived from
# whatever hostname a request happened to arrive on.
if grep -q '"PUBLIC_BASE_URL": ""' "$CONFIG"; then
  sed -i.bak "s|\"PUBLIC_BASE_URL\": \"\"|\"PUBLIC_BASE_URL\": \"$URL\"|" "$CONFIG" && rm -f "$CONFIG.bak"
  npx wrangler deploy >/dev/null 2>&1 || warn "Redeploy failed; run 'npx wrangler deploy' yourself."
  echo "    Set and redeployed."
else
  echo "    Already set."
fi

step "Verifying against live Companies House data"
echo "    This is the check that could not be run when the code was written."
node scripts/verify-live.mjs --url "$URL" || warn "Verification reported problems — read the output above before going further."

cat <<EOF

$(printf '\033[1m')Deployed and serving free:$(printf '\033[0m') $URL
  Service card   $URL/
  MCP endpoint   $URL/mcp
  Discovery      $URL/.well-known/x402
  Usage          npm run usage -- --url $URL --token \$ADMIN_TOKEN

$(printf '\033[1m')What this script cannot do for you:$(printf '\033[0m')

  1. Create a receiving wallet and set X402_PAY_TO in $CONFIG. Nothing
     automated should stand up a wallet that receives real money.
  2. Move to Base mainnet. Change X402_NETWORK and X402_ASSET together, and
     point X402_FACILITATOR_URL at a facilitator that settles on Base.
  3. List the endpoint — MCP registry (server.json is prepared), x402 indexes,
     AgentCore paid-API discovery. All need your accounts.
  4. Settle the compliance question in docs/LICENSING.md before the wallet
     address goes live.
EOF
