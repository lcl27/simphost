type ServiceCard = Awaited<ReturnType<typeof import("./discovery.js").serviceCard>>;

function escape(value: unknown): string {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * A person who lands on the root URL should be able to tell in ten seconds what
 * this is, what it costs and whether they are allowed to use the data. Agents
 * get the same content as JSON from the same path.
 */
export function landingPage(card: ServiceCard): string {
  const tools = card.tools
    .map(
      (tool) => `
      <article>
        <h3><code>${escape(tool.name)}</code></h3>
        <p>${escape(tool.description)}</p>
        <p class="price">${escape(tool.price.base_usd)} per call &middot; metered ceiling ${escape(tool.price.ceiling_usd)}</p>
      </article>`,
    )
    .join("");

  const payment =
    "protocol" in card.payment && (card.payment as { enabled?: boolean }).enabled === false
      ? "<p>Payments are not enabled on this deployment; the tools are currently served free.</p>"
      : `<p>Priced in x402 v2 on <code>${escape((card.payment as { network?: string }).network)}</code>, settled in
         ${escape((card.payment as { asset_name?: string }).asset_name)}. Schemes:
         <code>${escape(((card.payment as { schemes?: string[] }).schemes ?? []).join(", "))}</code>.
         <code>initialize</code>, <code>tools/list</code> and <code>ping</code> are free.</p>`;

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(card.service.title)}</title>
<style>
  :root { color-scheme: light dark; --ink: #16181d; --dim: #5b6472; --line: #d9dee6; --bg: #fbfbfc; --accent: #1f4f8b; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e7e9ee; --dim: #9aa4b2; --line: #2a2f38; --bg: #14161a; --accent: #7fb2f0; }
  }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 16px/1.6 ui-serif, Georgia, "Times New Roman", serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  h1 { font-size: 1.7rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  h2 { font-size: 1.05rem; text-transform: uppercase; letter-spacing: .08em; color: var(--dim);
       margin: 2.5rem 0 .75rem; font-family: ui-sans-serif, system-ui, sans-serif; }
  h3 { font-size: 1rem; margin: 0 0 .35rem; }
  p, li { color: var(--ink); }
  .lede { color: var(--dim); margin-top: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em;
         background: color-mix(in srgb, var(--line) 45%, transparent); padding: .1em .35em; border-radius: 3px; }
  article { border-top: 1px solid var(--line); padding: 1rem 0; }
  .price { color: var(--accent); font-family: ui-sans-serif, system-ui, sans-serif; font-size: .9rem; margin-bottom: 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; margin: 0; }
  dt { color: var(--dim); font-family: ui-sans-serif, system-ui, sans-serif; font-size: .85rem; }
  dd { margin: 0; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--dim); font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>${escape(card.service.title)}</h1>
  <p class="lede">${escape(card.summary)}</p>

  <h2>Endpoints</h2>
  <dl>
    <dt>MCP</dt><dd><code>${escape(card.endpoints.mcp)}</code></dd>
    <dt>Discovery</dt><dd><code>${escape(card.endpoints.discovery)}</code></dd>
    <dt>Health</dt><dd><code>${escape(card.endpoints.health)}</code></dd>
  </dl>

  <h2>Tools</h2>
  ${tools}

  <h2>Payment</h2>
  ${payment}
  <ul>${card.billing_policy.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>

  <h2>Data and licensing</h2>
  <p>${escape(card.data.licence)}</p>
  <p>${escape(card.data.scope)}</p>

  <footer>
    <p>This service reports what the public register says. It is not a regulated KYC or sanctions check, and it is not
    advice.</p>
  </footer>
</main>
</body>
</html>`;
}
