import type { Env } from "../env.js";

/**
 * Per-call instrumentation.
 *
 * The point of this service in its first months is not revenue, it is finding
 * out whether anything calls it at all — so every call is recorded, including
 * the unpaid ones, and especially the ones that ended at a 402 without the
 * caller coming back. Thirty days of silence is a complete answer, but only if
 * the silence is measured.
 */
export interface CallEvent {
  ts: string;
  transport: "mcp" | "http";
  tool: string;
  outcome: "paid" | "free" | "unbilled" | "payment_required" | "error";
  duration_ms: number;
  upstream_requests: number;
  /** Atomic units actually settled. */
  charged?: string;
  scheme?: string;
  network?: string;
  payer?: string;
  transaction?: string;
  /** MCP client name/version from initialize, or the User-Agent for HTTP. */
  client?: string;
  country?: string;
  colo?: string;
  /** The company number asked about — public register data, and the clearest signal of demand. */
  subject?: string;
  error?: string;
}

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

function eventKey(event: CallEvent): string {
  const day = event.ts.slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 10);
  return `evt:${day}:${event.ts}:${suffix}`;
}

/**
 * Fails open. A metering outage must never turn a paid call into an error the
 * caller sees, so every write is best-effort and swallowed.
 */
export async function record(env: Env, event: CallEvent): Promise<void> {
  try {
    if (env.METER) {
      await env.METER.put(eventKey(event), JSON.stringify(event), { expirationTtl: RETENTION_SECONDS });
    }
  } catch {
    // deliberately ignored
  }

  try {
    env.ANALYTICS?.writeDataPoint({
      blobs: [
        event.transport,
        event.tool,
        event.outcome,
        event.scheme ?? "",
        event.payer ?? "",
        event.client ?? "",
        event.country ?? "",
        event.subject ?? "",
      ],
      doubles: [event.duration_ms, event.upstream_requests, Number(event.charged ?? 0)],
      indexes: [event.tool],
    });
  } catch {
    // deliberately ignored
  }
}

export interface UsageSummary {
  scanned: number;
  window: { from?: string; to?: string };
  by_outcome: Record<string, number>;
  by_tool: Record<string, number>;
  by_day: Record<string, number>;
  by_client: Record<string, number>;
  distinct_payers: number;
  distinct_subjects: number;
  total_charged_atomic: string;
  recent: CallEvent[];
}

/**
 * Aggregates on read rather than maintaining counters, which avoids the
 * read-modify-write race KV would otherwise impose. Fine at the volumes this
 * service is realistically going to see; if it stops being fine, that is the
 * good problem.
 */
export async function summarise(env: Env, limit = 1000): Promise<UsageSummary> {
  const summary: UsageSummary = {
    scanned: 0,
    window: {},
    by_outcome: {},
    by_tool: {},
    by_day: {},
    by_client: {},
    distinct_payers: 0,
    distinct_subjects: 0,
    total_charged_atomic: "0",
    recent: [],
  };
  if (!env.METER) return summary;

  const payers = new Set<string>();
  const subjects = new Set<string>();
  let total = 0n;
  const events: CallEvent[] = [];

  let cursor: string | undefined;
  while (events.length < limit) {
    const page = await env.METER.list({ prefix: "evt:", cursor, limit: 1000 });
    for (const key of page.keys) {
      if (events.length >= limit) break;
      const raw = await env.METER.get(key.name);
      if (!raw) continue;
      try {
        events.push(JSON.parse(raw) as CallEvent);
      } catch {
        // skip unparseable entries rather than failing the report
      }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }

  events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  for (const event of events) {
    summary.scanned += 1;
    summary.by_outcome[event.outcome] = (summary.by_outcome[event.outcome] ?? 0) + 1;
    summary.by_tool[event.tool] = (summary.by_tool[event.tool] ?? 0) + 1;
    const day = event.ts.slice(0, 10);
    summary.by_day[day] = (summary.by_day[day] ?? 0) + 1;
    if (event.client) summary.by_client[event.client] = (summary.by_client[event.client] ?? 0) + 1;
    if (event.payer) payers.add(event.payer.toLowerCase());
    if (event.subject) subjects.add(event.subject);
    if (event.charged) {
      try {
        total += BigInt(event.charged);
      } catch {
        // ignore malformed amounts
      }
    }
  }

  summary.window = { from: events[events.length - 1]?.ts, to: events[0]?.ts };
  summary.distinct_payers = payers.size;
  summary.distinct_subjects = subjects.size;
  summary.total_charged_atomic = total.toString();
  summary.recent = events.slice(0, 25);
  return summary;
}
