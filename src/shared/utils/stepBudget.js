// Step budget: pure decision helpers, no DB and no imports from the app.
//
// Everything that can be decided without touching the database lives here, so
// the rules (window expiry, what counts, what a refusal does) are testable
// without a server — and so the same rules are used by the repo, the API route
// and the gate instead of being restated in each of them.
//
// A budget is OFF unless a limit is declared. An unset budget must not change
// behaviour at all: a fuse that is wired but not set has to be indistinguishable
// from a fuse that does not exist.
import {
  STEP_BUDGET_SCOPE_GLOBAL,
  STEP_BUDGET_SCOPE_KEY,
  STEP_BUDGET_SCOPE_PROVIDER,
  STEP_BUDGET_DEFAULT_WINDOW_MS,
  STEP_BUDGET_MAX_LIMIT,
  STEP_BUDGET_MAX_WINDOW_MS,
  STEP_BUDGET_MIN_LIMIT,
  STEP_BUDGET_MIN_WINDOW_MS,
} from "../constants/stepBudget.js";

const lower = (s) => String(s ?? "").toLowerCase();

/**
 * Canonical scope string for a caller, or null when it has no identity worth
 * limiting (e.g. no key id and no provider — routing nowhere).
 *
 * One function builds every scope string. Reading a scope off one field in one
 * place and another field somewhere else is exactly how the agent indicator
 * silently died once already.
 */
export function buildStepScope({ keyId, providerId } = {}) {
  const key = lower(keyId).trim();
  if (key) return `${STEP_BUDGET_SCOPE_KEY}:${key}`;
  const provider = lower(providerId).trim();
  if (provider) return `${STEP_BUDGET_SCOPE_PROVIDER}:${provider}`;
  return STEP_BUDGET_SCOPE_GLOBAL;
}

/** Split a scope back into `{kind, id}`. `global` has no id. */
export function parseStepScope(scope) {
  const raw = lower(scope).trim();
  const idx = raw.indexOf(":");
  if (idx === -1) return raw === STEP_BUDGET_SCOPE_GLOBAL ? { kind: STEP_BUDGET_SCOPE_GLOBAL, id: "" } : null;
  const kind = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!id) return null;
  if (kind !== STEP_BUDGET_SCOPE_KEY && kind !== STEP_BUDGET_SCOPE_PROVIDER) return null;
  return { kind, id };
}

/**
 * Most specific scope that applies, from the ones that are actually declared.
 * key beats provider beats global: the key is the external agent's identity,
 * the provider is our own agent, and global is the router as a whole.
 *
 * `declared` is a lookup over configured scopes, so this stays pure.
 */
export function resolveStepScope({ keyId, providerId, has }) {
  const lookup = typeof has === "function" ? has : () => false;
  const key = lower(keyId).trim();
  if (key && lookup(`${STEP_BUDGET_SCOPE_KEY}:${key}`)) return `${STEP_BUDGET_SCOPE_KEY}:${key}`;
  const provider = lower(providerId).trim();
  if (provider && lookup(`${STEP_BUDGET_SCOPE_PROVIDER}:${provider}`)) return `${STEP_BUDGET_SCOPE_PROVIDER}:${provider}`;
  if (lookup(STEP_BUDGET_SCOPE_GLOBAL)) return STEP_BUDGET_SCOPE_GLOBAL;
  return null;
}

/**
 * Validate a declared budget. Returns `{limitSteps, windowMs}` or null when the
 * budget is off (`limitSteps` absent/0), or `{error}` when the input is
 * malformed — a bad declaration must be reported, never quietly clamped, so a
 * typo cannot silently become a different limit.
 */
export function normalizeStepBudget(raw) {
  if (raw == null) return null;
  const limit = Number(raw.limitSteps ?? raw.limit ?? 0);
  if (!Number.isFinite(limit) || limit < 0) return { error: "limitSteps must be a non-negative number" };
  if (limit === 0) return null; // explicitly off
  if (limit < STEP_BUDGET_MIN_LIMIT) return { error: `limitSteps must be at least ${STEP_BUDGET_MIN_LIMIT}` };
  if (limit > STEP_BUDGET_MAX_LIMIT) return { error: `limitSteps must be at most ${STEP_BUDGET_MAX_LIMIT}` };

  const windowRaw = raw.windowMs ?? raw.windowMsOverride;
  let windowMs = STEP_BUDGET_DEFAULT_WINDOW_MS;
  if (windowRaw != null && windowRaw !== "") {
    windowMs = Number(windowRaw);
    if (!Number.isFinite(windowMs)) return { error: "windowMs must be a number" };
    if (windowMs < STEP_BUDGET_MIN_WINDOW_MS) return { error: `windowMs must be at least ${STEP_BUDGET_MIN_WINDOW_MS}` };
    if (windowMs > STEP_BUDGET_MAX_WINDOW_MS) return { error: `windowMs must be at most ${STEP_BUDGET_MAX_WINDOW_MS}` };
  }
  return { limitSteps: Math.floor(limit), windowMs: Math.floor(windowMs) };
}

/**
 * Decide whether one step fits, given the persisted counter.
 *
 * Window semantics: a FIXED window anchored at the first step after expiry, not
 * a sliding one. Sliding windows never let a burst through and under a busy
 * caller effectively never reset; a fixed window gives the caller a Retry-After
 * that actually ends, which is what an agent can act on.
 *
 * Refusals are NOT counted (owner's choice, 2026-10-18). Counting them would
 * hand the agent a way to spend its own budget by retrying a request it was
 * already refused — the refusal would drain the budget it is protecting, and
 * every retry would land further from the next window.
 *
 * @returns {{allowed: boolean, used: number, resetAt: number, retryAfterSeconds: number}}
 */
export function evaluateStep({ limitSteps, windowMs }, state, now) {
  const limit = Number(limitSteps);
  const window = Number(windowMs) > 0 ? Number(windowMs) : STEP_BUDGET_DEFAULT_WINDOW_MS;
  const resetAt = Number(state?.resetAt) || 0;
  const priorUsed = Number(state?.usedSteps) || 0;

  // No window open, or the open one expired: start a fresh one. The counter
  // restarts at zero, so this step is the FIRST of the new window — the old
  // total is spent and must not be carried over into it.
  if (!resetAt || now >= resetAt) {
    const freshResetAt = now + window;
    if (limit <= 0) {
      return { allowed: false, used: 0, resetAt: freshResetAt, retryAfterSeconds: Math.ceil(window / 1000) };
    }
    return { allowed: true, used: 1, resetAt: freshResetAt, retryAfterSeconds: 0 };
  }

  if (priorUsed + 1 > limit) {
    return {
      allowed: false,
      used: priorUsed,
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }
  return { allowed: true, used: priorUsed + 1, resetAt, retryAfterSeconds: 0 };
}

/** Seconds to put in `Retry-After`; 0 when there is nothing to wait for. */
export function retryAfterSeconds(retryAfter) {
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 0;
}