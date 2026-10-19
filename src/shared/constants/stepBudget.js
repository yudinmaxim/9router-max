// Per-caller step budget: shared constants.
//
// A step is ONE client request to /v1. Not an upstream call: a combo expands to
// several, an account failure retries the next, and the MCP loop makes one call
// per round — none of which the agent asked for. Counting upstreams would make
// "15 steps" mean a different number depending on which provider happened to be
// selected, and a limit that means different things is not a limit.
//
// The caller is identified by a SCOPE, never by a header. User-Agent is
// spoofable, so a limit keyed off it is not a limit at all.

/** Scope kinds. A scope is `kind:id`, or bare `global`. */
export const STEP_BUDGET_SCOPE_KEY = "key";
export const STEP_BUDGET_SCOPE_PROVIDER = "provider";
export const STEP_BUDGET_SCOPE_GLOBAL = "global";

/**
 * The window mode the owner picked (2026-10-18): a time window, one hour.
 * A hard sum ("15 ever") would need a manual reset and punishes a long task;
 * 15 heavy steps and 5 trivial ones cost the agent very differently and a plain
 * count cannot tell them apart. A window caps both steps and spend predictably,
 * and recovers on its own.
 */
export const STEP_BUDGET_DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/** Bounds for a declared limit, rejected beyond these rather than clamped. */
export const STEP_BUDGET_MIN_LIMIT = 1;
export const STEP_BUDGET_MAX_LIMIT = 100000;
export const STEP_BUDGET_MIN_WINDOW_MS = 1000;
export const STEP_BUDGET_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Client-facing 429 message. Deliberately says nothing about how many steps
 * remain, which scope was hit, or which provider is behind it: a shared or
 * guessed key must not learn the state of someone else's budget. The agent is
 * told the step did not happen and that repeating it is pointless — otherwise it
 * retries and burns nothing but wall clock.
 */
export function stepBudgetDeniedMessage(retryAfterSeconds) {
  const wait = retryAfterSeconds > 0 ? ` Retry after ${retryAfterSeconds}s.` : "";
  return `Step not taken: this caller's step budget is exhausted, and refused steps are not counted.${wait}`;
}

/** Log-side wording. Never sent to a client. */
export function stepBudgetDeniedLog(scope, limitSteps, windowMs) {
  return `step-budget: "${scope}" exhausted (${limitSteps} steps / ${Math.round(windowMs / 60000)}min)`;
}