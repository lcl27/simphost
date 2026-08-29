import { describe, expect, it, vi } from "vitest";
import { record, summarise, type CallEvent } from "../src/metering/ledger.js";
import { testEnv } from "./helpers.js";

/** Enough of the KV surface for the ledger: put, get, list with a cursor. */
function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async list({ prefix = "", limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number.parseInt(cursor, 10) : 0;
      const page = all.slice(start, start + limit);
      const next = start + page.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: next >= all.length,
        cursor: next >= all.length ? undefined : String(next),
      };
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function event(overrides: Partial<CallEvent> = {}): CallEvent {
  return {
    ts: new Date().toISOString(),
    transport: "mcp",
    tool: "get_company_filing_history",
    outcome: "paid",
    duration_ms: 42,
    upstream_requests: 1,
    charged: "2000",
    payer: "0xPayer",
    subject: "00000001",
    client: "probe/1.0",
    ...overrides,
  };
}

describe("usage ledger", () => {
  it("records a call and aggregates it back", async () => {
    const METER = memoryKv();
    const env = testEnv({ METER });

    await record(env, event({ ts: "2026-08-01T10:00:00.000Z" }));
    await record(env, event({ ts: "2026-08-01T11:00:00.000Z", outcome: "payment_required", charged: undefined }));
    await record(env, event({ ts: "2026-08-02T09:00:00.000Z", tool: "get_psc_verification_status", payer: "0xOther", subject: "SC090312" }));

    const summary = await summarise(env);
    expect(summary.scanned).toBe(3);
    expect(summary.by_outcome).toEqual({ paid: 2, payment_required: 1 });
    expect(summary.by_tool).toEqual({ get_company_filing_history: 2, get_psc_verification_status: 1 });
    expect(summary.by_day).toEqual({ "2026-08-01": 2, "2026-08-02": 1 });
    expect(summary.by_client).toEqual({ "probe/1.0": 3 });
    expect(summary.distinct_payers).toBe(2);
    expect(summary.distinct_subjects).toBe(2);
    expect(summary.total_charged_atomic).toBe("4000");
    expect(summary.window).toEqual({ from: "2026-08-01T10:00:00.000Z", to: "2026-08-02T09:00:00.000Z" });
    expect(summary.recent[0]?.ts).toBe("2026-08-02T09:00:00.000Z");
  });

  it("expires entries rather than keeping them for ever", async () => {
    const METER = memoryKv();
    const put = vi.spyOn(METER, "put");
    await record(testEnv({ METER }), event());
    expect(put.mock.calls[0]?.[2]).toMatchObject({ expirationTtl: 90 * 24 * 60 * 60 });
  });

  it("fails open when the ledger is unavailable", async () => {
    const broken = { put: async () => { throw new Error("KV down"); } } as unknown as KVNamespace;
    await expect(record(testEnv({ METER: broken }), event())).resolves.toBeUndefined();
  });

  it("returns an empty summary when no ledger is bound", async () => {
    const summary = await summarise(testEnv({ METER: undefined }));
    expect(summary.scanned).toBe(0);
    expect(summary.total_charged_atomic).toBe("0");
  });

  it("skips an unparseable entry instead of failing the whole report", async () => {
    const METER = memoryKv();
    const env = testEnv({ METER });
    await record(env, event({ ts: "2026-08-01T10:00:00.000Z" }));
    await METER.put("evt:2026-08-01:corrupt", "{not json");
    const summary = await summarise(env);
    expect(summary.scanned).toBe(1);
  });

  it("pages through a ledger larger than one KV list page", async () => {
    const METER = memoryKv();
    const env = testEnv({ METER });
    for (let i = 0; i < 12; i += 1) {
      await record(env, event({ ts: `2026-08-01T10:${String(i).padStart(2, "0")}:00.000Z` }));
    }
    const summary = await summarise(env, 5);
    expect(summary.scanned).toBe(5);
  });
});
