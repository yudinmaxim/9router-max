// Per-caller step budget: persistent counter.
//
// The counter lives in the DB, not in module memory, on purpose. `open-sse` and
// the route handler can end up with different instances of a module, and an
// in-memory counter would quietly split in half — which is how an empty
// `activeRequests` once made every agent look idle. A fuse that a restart
// resets is not a fuse either, so nothing here is held in RAM.
import { getAdapter } from "../driver.js";
import { evaluateStep, parseStepScope, retryAfterSeconds } from "@/shared/utils/stepBudget.js";

function rowToBudget(row) {
  if (!row) return null;
  return {
    scope: row.scope,
    limitSteps: row.limitSteps,
    windowMs: row.windowMs,
    usedSteps: row.usedSteps,
    resetAt: row.resetAt,
    updatedAt: row.updatedAt,
  };
}

export async function getStepBudget(scope) {
  const db = await getAdapter();
  return rowToBudget(db.get(`SELECT * FROM stepBudgets WHERE scope = ?`, [scope]));
}

export async function listStepBudgets() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM stepBudgets ORDER BY scope ASC`).map(rowToBudget);
}

/** Which of the given scopes are configured. Used to pick the most specific. */
export async function declaredStepScopes() {
  const rows = await listStepBudgets();
  return new Set(rows.map((r) => r.scope));
}

/** Create or replace a budget. Changing the limit applies to the next request. */
export async function upsertStepBudget(scope, { limitSteps, windowMs }) {
  const db = await getAdapter();
  const now = new Date();
  const existing = await getStepBudget(scope);
  // A changed limit must not inherit a counter that was measured against the
  // old one, and a changed window invalidates the open window's anchor.
  const keepCounter = existing && existing.limitSteps === limitSteps && existing.windowMs === windowMs;
  const usedSteps = keepCounter ? existing.usedSteps : 0;
  const resetAt = keepCounter ? existing.resetAt : 0;
  db.run(
    `INSERT INTO stepBudgets(scope, limitSteps, windowMs, usedSteps, resetAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       limitSteps = excluded.limitSteps,
       windowMs = excluded.windowMs,
       usedSteps = excluded.usedSteps,
       resetAt = excluded.resetAt,
       updatedAt = excluded.updatedAt`,
    [scope, limitSteps, windowMs, usedSteps, resetAt, now.toISOString()]
  );
  return getStepBudget(scope);
}

export async function deleteStepBudget(scope) {
  const db = await getAdapter();
  db.run(`DELETE FROM stepBudgets WHERE scope = ?`, [scope]);
}

/**
 * Spend one step, atomically.
 *
 * Read-modify-write inside a transaction: without it, N parallel requests from
 * one agent all read `used = 14` and all write `15`, so a limit of 15 would let
 * 15 of them through at once — the agent runs its loops in parallel, so that is
 * the normal case, not an edge case.
 *
 * Returns the decision WITHOUT spending on refusal, and the caller must treat a
 * refusal as free: see evaluateStep() for why.
 *
 * @returns {Promise<{allowed: boolean, scope: string, limitSteps: number,
 *   windowMs: number, usedSteps: number, resetAt: number,
 *   retryAfterSeconds: number}>}
 */
export async function consumeStep(scope, now = Date.now()) {
  const db = await getAdapter();
  let decision = null;

  db.transaction(() => {
    const row = db.get(`SELECT * FROM stepBudgets WHERE scope = ?`, [scope]);
    if (!row) {
      // No budget declared: behaviour must be exactly as before.
      decision = {
        allowed: true,
        scope,
        limitSteps: 0,
        windowMs: 0,
        usedSteps: 0,
        resetAt: 0,
        retryAfterSeconds: 0,
      };
      return;
    }
    const budget = { limitSteps: row.limitSteps, windowMs: row.windowMs };
    const result = evaluateStep(budget, { usedSteps: row.usedSteps, resetAt: row.resetAt }, now);
    if (result.allowed) {
      db.run(
        `UPDATE stepBudgets SET usedSteps = ?, resetAt = ?, updatedAt = ? WHERE scope = ?`,
        [result.used, result.resetAt, new Date(now).toISOString(), scope]
      );
    }
    decision = {
      allowed: result.allowed,
      scope,
      limitSteps: row.limitSteps,
      windowMs: row.windowMs,
      usedSteps: result.used,
      resetAt: result.resetAt,
      retryAfterSeconds: retryAfterSeconds(result.retryAfterSeconds),
    };
  });

  return decision;
}

/** Live state for the UI: what is declared, spent, and when it frees up. */
export async function describeStepBudgets() {
  const now = Date.now();
  const rows = await listStepBudgets();
  return rows.map((row) => {
    const parsed = parseStepScope(row.scope);
    return {
      scope: row.scope,
      kind: parsed?.kind ?? null,
      id: parsed?.id || null,
      limitSteps: row.limitSteps,
      windowMs: row.windowMs,
      usedSteps: row.usedSteps,
      remaining: Math.max(0, row.limitSteps - row.usedSteps),
      resetAt: row.resetAt || 0,
      expired: !row.resetAt || now >= row.resetAt,
      msUntilReset: row.resetAt > now ? row.resetAt - now : 0,
    };
  });
}