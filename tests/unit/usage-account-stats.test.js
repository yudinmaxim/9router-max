// Per-account usage statistics silently lost every request that had no
// connectionId — and every noAuth provider (cursor-acp, opencode-acp, opencode)
// is handed a synthetic connection id with no row behind it, so "Cursor Agent
// (ACP)" had no per-account statistics at all while byProvider still counted it.
//
// usageRepo.js:88 used to be `if (entry.connectionId) { addToCounter(...) }`,
// which dropped them. These tests pin the fixed behaviour: nothing is dropped,
// provider-scoped buckets get a readable name, and the history can be rebuilt.

import { describe, it, expect, beforeEach } from "vitest";

process.env.DATA_DIR = "/tmp/9r-usage-account-test";

const {
  saveRequestUsage,
  getUsageStats,
  backfillDailyAccounts,
  PROVIDER_ACCOUNT_PREFIX,
  isProviderAccountKey,
} = await import("@/lib/usageDb");
const { runMigrationOnce } = await import("@/lib/db/migrate");
const { getAdapter } = await import("@/lib/db/driver");

const today = () => new Date().toISOString();

beforeEach(async () => {
  await runMigrationOnce(await getAdapter());
  const db = await getAdapter();
  db.run("DELETE FROM usageHistory");
  db.run("DELETE FROM usageDaily");
  // Connections decide the bucket label, so a row left behind by one test
  // would make the next test's "exactly one row" assumption false.
  db.run("DELETE FROM providerConnections");
});

const withConnection = (extra = {}) => ({
  timestamp: today(),
  model: "space-bunny-free",
  apiKey: "sk-test",
  endpoint: "/v1/chat/completions",
  tokens: { prompt_tokens: 100, completion_tokens: 10 },
  status: "ok",
  ...extra,
});

describe("account key helpers", () => {
  it("recognises provider-scoped keys", () => {
    expect(PROVIDER_ACCOUNT_PREFIX).toBe("provider:");
    expect(isProviderAccountKey(`provider:cursor-acp`)).toBe(true);
    expect(isProviderAccountKey("a66e4d33-a67a-4b9d-ab47-079319943fbd")).toBe(false);
    expect(isProviderAccountKey(null)).toBe(false);
  });
});

describe("aggregation never drops a request", () => {
  it("keeps a noAuth request with no connectionId", async () => {
    await saveRequestUsage(withConnection({ provider: "cursor-acp", connectionId: undefined }));
    const stats = await getUsageStats("all");
    const buckets = Object.values(stats.byAccount);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].requests).toBe(1);
    expect(buckets[0].provider).toBe("cursor-acp");
  });

  it("keeps one bucket per noAuth provider", async () => {
    await saveRequestUsage(withConnection({ provider: "cursor-acp" }));
    await saveRequestUsage(withConnection({ provider: "opencode-acp" }));
    await saveRequestUsage(withConnection({ provider: "cursor-acp" }));
    const stats = await getUsageStats("all");
    const total = Object.values(stats.byAccount).reduce((n, b) => n + b.requests, 0);
    expect(total).toBe(3);
    const providers = Object.values(stats.byAccount).map((b) => b.provider).sort();
    expect(providers).toEqual(["cursor-acp", "opencode-acp"]);
  });

  it("still keys real connections by their id", async () => {
    await saveRequestUsage(withConnection({ provider: "cursor", connectionId: "conn-123" }));
    const stats = await getUsageStats("all");
    const [bucket] = Object.values(stats.byAccount);
    expect(bucket.connectionId).toBe("conn-123");
    expect(bucket.accountName).toBe("Account conn-123...");
  });

  it("drops only what cannot be attributed at all", async () => {
    await saveRequestUsage(withConnection({ provider: undefined, connectionId: undefined }));
    const stats = await getUsageStats("all");
    expect(Object.values(stats.byAccount)).toHaveLength(0);
    // Pre-existing behaviour, untouched here: totalRequests is summed from
    // byProvider (usageRepo.js:772), and an entry with no provider never lands
    // there, so it is absent from both the buckets and the totals.
    expect(stats.totalRequests).toBe(0);
    expect(Object.keys(stats.byProvider)).toHaveLength(0);
  });

  it("names the bucket after the provider's single connection row", async () => {
    const { createProviderConnection } = await import("@/models");
    await createProviderConnection({ provider: "cursor-acp", name: "Cursor Agent (ACP)", authType: "apikey", apiKey: "x" });
    await saveRequestUsage(withConnection({ provider: "cursor-acp" }));
    const stats = await getUsageStats("all");
    const [bucket] = Object.values(stats.byAccount);
    expect(bucket.accountName).toBe("Cursor Agent (ACP)");
  });

  it("does not pick an arbitrary connection row when the provider has several", async () => {
    const { createProviderConnection } = await import("@/models");
    await createProviderConnection({ provider: "cursor-acp", name: "First", authType: "apikey", apiKey: "a" });
    await createProviderConnection({ provider: "cursor-acp", name: "Second", authType: "apikey", apiKey: "b" });
    await saveRequestUsage(withConnection({ provider: "cursor-acp" }));
    const stats = await getUsageStats("all");
    const [bucket] = Object.values(stats.byAccount);
    // The traffic was never routed through either row specifically, so naming
    // one of them would misattribute it. The provider's own label is used.
    expect(bucket.accountName).not.toBe("First");
    expect(bucket.accountName).not.toBe("Second");
    expect(bucket.accountName.length).toBeGreaterThan(0);
  });
});

describe("backfillDailyAccounts", () => {
  async function seedMixedDay() {
    await saveRequestUsage(withConnection({ provider: "cursor-acp" }));
    await saveRequestUsage(withConnection({ provider: "cursor-acp", model: "other" }));
    await saveRequestUsage(withConnection({ provider: "cursor", connectionId: "conn-9" }));
  }

  it("rebuilds buckets for requests that predate the fix", async () => {
    await seedMixedDay();
    const db = await getAdapter();
    const row = db.get(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey DESC LIMIT 1`);
    const day = JSON.parse(row.data);
    // Simulate the old damage: byAccount wiped, everything else intact.
    day.byAccount = {};
    db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(day), row.dateKey]);

    const result = await backfillDailyAccounts();
    expect(result.added).toBe(3);

    const after = await getUsageStats("all");
    const total = Object.values(after.byAccount).reduce((n, b) => n + b.requests, 0);
    expect(total).toBe(3);
    // byAccount is keyed by "model (provider - account)" for display; the
    // original bucket id is kept on connectionId.
    const keys = Object.values(after.byAccount).map((b) => b.connectionId);
    expect(keys.some(isProviderAccountKey)).toBe(true);
    expect(keys).toContain("conn-9");
  });

  it("is idempotent — a second run does not double the totals", async () => {
    await seedMixedDay();
    await backfillDailyAccounts();
    const first = await getUsageStats("all");
    await backfillDailyAccounts();
    const second = await getUsageStats("all");
    const total = (s) => Object.values(s.byAccount).reduce((n, b) => n + b.requests, 0);
    expect(total(first)).toBe(3);
    expect(total(second)).toBe(3);
  });

  it("leaves the other per-day counters untouched", async () => {
    await seedMixedDay();
    const db = await getAdapter();
    const before = JSON.parse(db.get(`SELECT data FROM usageDaily ORDER BY dateKey DESC LIMIT 1`).data);
    await backfillDailyAccounts();
    const after = JSON.parse(db.get(`SELECT data FROM usageDaily ORDER BY dateKey DESC LIMIT 1`).data);
    expect(after.requests).toBe(before.requests);
    expect(after.promptTokens).toBe(before.promptTokens);
    expect(Object.keys(after.byProvider)).toEqual(Object.keys(before.byProvider));
    expect(Object.keys(after.byModel)).toEqual(Object.keys(before.byModel));
  });

  it("drops buckets that no longer have any history behind them", async () => {
    await seedMixedDay();
    const db = await getAdapter();
    const row = db.get(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey DESC LIMIT 1`);
    const day = JSON.parse(row.data);
    day.byAccount["conn-deleted"] = { requests: 99, promptTokens: 99, completionTokens: 0, cachedTokens: 0, cost: 0 };
    db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(day), row.dateKey]);

    await backfillDailyAccounts();
    const after = await getUsageStats("all");
    const ids = Object.values(after.byAccount).map((b) => b.connectionId);
    // Rebuilding replaces the bucket set: a connection whose requests are gone
    // must not linger with its old totals.
    expect(ids).not.toContain("conn-deleted");
  });

  it("is a no-op on an empty database", async () => {
    expect(await backfillDailyAccounts()).toEqual({ days: 0, added: 0 });
    expect(await backfillDailyAccounts(["1999-01-01"])).toMatchObject({ added: 0 });
  });
});