import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

let repo;
let db;

const HOUR = 60 * 60 * 1000;

// ONE temp dir and ONE adapter for the whole file, then wipe the table between
// tests. Opening an adapter per test is wrong twice over: the adapter is cached
// on `global` (driver.js) and vitest reuses the worker across test files, so
// each new one leaks listeners, and closing it mid-file yanks the handle out
// from under whatever runs next — which is what made the full suite hang.
//
// Wiping the rows gives this file the isolation it needs. The global handle is
// still released at the end, because a later file that sets its own DATA_DIR
// would otherwise inherit THIS database and assert against the wrong data.
const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  // An isolated copy, never the only data there is: this test writes counters,
  // and a fuse that resets on restart is not a fuse.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-step-budget-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/stepBudgetsRepo.js");
});

beforeEach(async () => {
  const adapter = await import("@/lib/db/driver.js");
  const handle = await adapter.getAdapter();
  handle.run("DELETE FROM stepBudgets");
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("stepBudgetsRepo", () => {
  it("spends exactly the limit and then refuses", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 3, windowMs: HOUR });
    for (let i = 1; i <= 3; i++) {
      const d = await repo.consumeStep("key:k1");
      expect(d.allowed).toBe(true);
      expect(d.usedSteps).toBe(i);
    }
    expect((await repo.consumeStep("key:k1")).allowed).toBe(false);
  });

  it("refuses without spending, so refusals stay free", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 1, windowMs: HOUR });
    await repo.consumeStep("key:k1");
    for (let i = 0; i < 4; i++) await repo.consumeStep("key:k1");
    const row = await repo.getStepBudget("key:k1");
    expect(row.usedSteps).toBe(1);
  });

  it("does not let parallel requests pass the ceiling together", async () => {
    // Agents run their loops in parallel, so this is the normal case, not an
    // edge case. Without a transaction every racer reads used=0 and every racer
    // writes 1, and a limit of 5 admits all 25.
    await repo.upsertStepBudget("key:k1", { limitSteps: 5, windowMs: HOUR });
    const decisions = await Promise.all(
      Array.from({ length: 25 }, () => repo.consumeStep("key:k1"))
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
    expect((await repo.getStepBudget("key:k1")).usedSteps).toBe(5);
  });

  it("keeps two callers' counters apart", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 1, windowMs: HOUR });
    await repo.upsertStepBudget("key:k2", { limitSteps: 1, windowMs: HOUR });
    expect((await repo.consumeStep("key:k1")).allowed).toBe(true);
    expect((await repo.consumeStep("key:k1")).allowed).toBe(false);
    expect((await repo.consumeStep("key:k2")).allowed).toBe(true);
  });

  it("allows everything when no budget is declared", async () => {
    for (let i = 0; i < 50; i++) {
      expect((await repo.consumeStep("key:undeclared")).allowed).toBe(true);
    }
  });

  it("recovers on its own when the window expires", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 2, windowMs: HOUR });
    const past = Date.now() - 2 * HOUR;
    expect((await repo.consumeStep("key:k1", past)).allowed).toBe(true);
    expect((await repo.consumeStep("key:k1", past)).allowed).toBe(true);
    expect((await repo.consumeStep("key:k1", past)).allowed).toBe(false);
    // Two hours on, the window is long gone.
    expect((await repo.consumeStep("key:k1")).allowed).toBe(true);
  });

  it("survives a restart, because a fuse that restarts is not a fuse", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 2, windowMs: HOUR });
    await repo.consumeStep("key:k1");
    const fresh = await import("@/lib/db/repos/stepBudgetsRepo.js");
    expect((await fresh.getStepBudget("key:k1")).usedSteps).toBe(1);
    expect((await fresh.consumeStep("key:k1")).allowed).toBe(true);
    expect((await fresh.consumeStep("key:k1")).allowed).toBe(false);
  });

  it("drops a counter that was measured against a different limit", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 2, windowMs: HOUR });
    await repo.consumeStep("key:k1");
    // Raising the ceiling starts clean rather than inheriting a count that no
    // longer means anything.
    await repo.upsertStepBudget("key:k1", { limitSteps: 10, windowMs: HOUR });
    expect((await repo.getStepBudget("key:k1")).usedSteps).toBe(0);
  });

  it("reopens the window when the window length changes", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 5, windowMs: HOUR });
    await repo.consumeStep("key:k1");
    await repo.upsertStepBudget("key:k1", { limitSteps: 5, windowMs: 2 * HOUR });
    const d = await repo.consumeStep("key:k1");
    expect(d.usedSteps).toBe(1);
  });

  it("keeps the counter when nothing changed", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 5, windowMs: HOUR });
    await repo.consumeStep("key:k1");
    await repo.upsertStepBudget("key:k1", { limitSteps: 5, windowMs: HOUR });
    expect((await repo.getStepBudget("key:k1")).usedSteps).toBe(1);
  });

  it("removes a budget", async () => {
    await repo.upsertStepBudget("global", { limitSteps: 1, windowMs: HOUR });
    await repo.deleteStepBudget("global");
    expect(await repo.getStepBudget("global")).toBeNull();
    expect((await repo.consumeStep("global")).allowed).toBe(true);
  });

  it("lists declared scopes for scope resolution", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 1, windowMs: HOUR });
    await repo.upsertStepBudget("global", { limitSteps: 1, windowMs: HOUR });
    const declared = await repo.declaredStepScopes();
    expect([...declared].sort()).toEqual(["global", "key:k1"]);
  });

  it("describes live state for the dashboard", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 5, windowMs: HOUR });
    await repo.consumeStep("key:k1");
    const [row] = await repo.describeStepBudgets();
    expect(row).toMatchObject({ scope: "key:k1", kind: "key", id: "k1", limitSteps: 5, usedSteps: 1, remaining: 4 });
    expect(row.expired).toBe(false);
    expect(row.msUntilReset).toBeGreaterThan(0);
  });

  it("reports an expired window as expired", async () => {
    await repo.upsertStepBudget("key:k1", { limitSteps: 5, windowMs: HOUR });
    const [row] = await repo.describeStepBudgets();
    expect(row.expired).toBe(true);
    expect(row.msUntilReset).toBe(0);
  });
});