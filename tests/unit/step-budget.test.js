import { describe, it, expect } from "vitest";
import {
  buildStepScope,
  evaluateStep,
  normalizeStepBudget,
  parseStepScope,
  resolveStepScope,
  retryAfterSeconds,
} from "../../src/shared/utils/stepBudget.js";
import {
  STEP_BUDGET_DEFAULT_WINDOW_MS,
  STEP_BUDGET_MAX_LIMIT,
  STEP_BUDGET_MAX_WINDOW_MS,
  STEP_BUDGET_MIN_WINDOW_MS,
  stepBudgetDeniedMessage,
} from "../../src/shared/constants/stepBudget.js";

const HOUR = 60 * 60 * 1000;
const budget = { limitSteps: 3, windowMs: HOUR };

describe("buildStepScope", () => {
  it("prefers the key, then the provider, then global", () => {
    expect(buildStepScope({ keyId: "k1", providerId: "ca" })).toBe("key:k1");
    expect(buildStepScope({ providerId: "ca" })).toBe("provider:ca");
    expect(buildStepScope({})).toBe("global");
  });

  it("normalizes case and whitespace so one caller cannot get two budgets", () => {
    expect(buildStepScope({ keyId: "  K1 " })).toBe("key:k1");
    expect(buildStepScope({ providerId: "CA" })).toBe("provider:ca");
  });

  it("ignores empty ids rather than minting 'key:'", () => {
    expect(buildStepScope({ keyId: "", providerId: "ca" })).toBe("provider:ca");
    expect(buildStepScope({ keyId: null, providerId: null })).toBe("global");
  });
});

describe("parseStepScope", () => {
  it("round-trips the three kinds", () => {
    expect(parseStepScope("key:K1")).toEqual({ kind: "key", id: "k1" });
    expect(parseStepScope("provider:CA")).toEqual({ kind: "provider", id: "ca" });
    expect(parseStepScope("global")).toEqual({ kind: "global", id: "" });
  });

  it("rejects malformed scopes instead of guessing", () => {
    expect(parseStepScope("")).toBeNull();
    expect(parseStepScope("key:")).toBeNull();
    expect(parseStepScope("user-agent:bot")).toBeNull();
    expect(parseStepScope("whatever")).toBeNull();
  });
});

describe("resolveStepScope", () => {
  const only = (...scopes) => {
    const set = new Set(scopes);
    return (s) => set.has(s);
  };

  it("takes the most specific declared scope: key, then provider, then global", () => {
    expect(resolveStepScope({ keyId: "k1", providerId: "ca", has: only("key:k1", "provider:ca", "global") })).toBe("key:k1");
    expect(resolveStepScope({ keyId: "k1", providerId: "ca", has: only("provider:ca", "global") })).toBe("provider:ca");
    expect(resolveStepScope({ keyId: "k1", providerId: "ca", has: only("global") })).toBe("global");
  });

  it("returns null when nothing is declared, so behaviour is unchanged", () => {
    expect(resolveStepScope({ keyId: "k1", providerId: "ca", has: () => false })).toBeNull();
  });

  it("covers a no-key agent through its provider scope", () => {
    expect(resolveStepScope({ keyId: null, providerId: "ca", has: only("provider:ca") })).toBe("provider:ca");
  });

  it("falls back to global when a combo has no provider of its own", () => {
    expect(resolveStepScope({ keyId: null, providerId: null, has: only("global") })).toBe("global");
  });
});

describe("normalizeStepBudget", () => {
  it("treats an unset or zero limit as no budget at all", () => {
    expect(normalizeStepBudget(null)).toBeNull();
    expect(normalizeStepBudget({})).toBeNull();
    expect(normalizeStepBudget({ limitSteps: 0 })).toBeNull();
  });

  it("defaults the window to one hour — the owner's chosen mode", () => {
    expect(normalizeStepBudget({ limitSteps: 15 })).toEqual({ limitSteps: 15, windowMs: STEP_BUDGET_DEFAULT_WINDOW_MS });
    expect(STEP_BUDGET_DEFAULT_WINDOW_MS).toBe(HOUR);
  });

  it("rejects malformed input rather than clamping it", () => {
    expect(normalizeStepBudget({ limitSteps: -1 }).error).toBeTruthy();
    expect(normalizeStepBudget({ limitSteps: "fifteen" }).error).toBeTruthy();
    expect(normalizeStepBudget({ limitSteps: 15, windowMs: 10 }).error).toBeTruthy();
    expect(normalizeStepBudget({ limitSteps: 15, windowMs: STEP_BUDGET_MAX_WINDOW_MS + 1 }).error).toBeTruthy();
    expect(normalizeStepBudget({ limitSteps: STEP_BUDGET_MAX_LIMIT + 1 }).error).toBeTruthy();
  });

  it("accepts the documented bounds", () => {
    expect(normalizeStepBudget({ limitSteps: 1, windowMs: STEP_BUDGET_MIN_WINDOW_MS }).limitSteps).toBe(1);
    expect(normalizeStepBudget({ limitSteps: STEP_BUDGET_MAX_LIMIT, windowMs: STEP_BUDGET_MAX_WINDOW_MS }).windowMs).toBe(STEP_BUDGET_MAX_WINDOW_MS);
  });
});

describe("evaluateStep", () => {
  const t0 = 1_700_000_000_000;

  it("allows exactly the limit, then refuses the next one", () => {
    let state = { usedSteps: 0, resetAt: 0 };
    for (let i = 1; i <= 3; i++) {
      const d = evaluateStep(budget, state, t0);
      expect(d.allowed).toBe(true);
      expect(d.used).toBe(i);
      state = { usedSteps: d.used, resetAt: d.resetAt };
    }
    const refused = evaluateStep(budget, state, t0 + 1000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("opens a window anchored at the first step", () => {
    const d = evaluateStep(budget, { usedSteps: 0, resetAt: 0 }, t0);
    expect(d.resetAt).toBe(t0 + HOUR);
  });

  it("restores the budget by itself once the window expires", () => {
    const spent = { usedSteps: 3, resetAt: t0 + HOUR };
    const during = evaluateStep(budget, spent, t0 + HOUR - 1);
    expect(during.allowed).toBe(false);

    const after = evaluateStep(budget, spent, t0 + HOUR);
    expect(after.allowed).toBe(true);
    expect(after.used).toBe(1);
    expect(after.resetAt).toBe(t0 + HOUR + HOUR);
  });

  it("does not count refusals, so a refused caller cannot drain its own budget", () => {
    const spent = { usedSteps: 3, resetAt: t0 + HOUR };
    for (let i = 0; i < 5; i++) {
      const d = evaluateStep(budget, spent, t0 + 1000 + i);
      expect(d.allowed).toBe(false);
      expect(d.used).toBe(3);
    }
  });

  it("keeps the open window's remaining time in Retry-After, and shrinks it", () => {
    const spent = { usedSteps: 3, resetAt: t0 + HOUR };
    expect(evaluateStep(budget, spent, t0).retryAfterSeconds).toBe(HOUR / 1000);
    expect(evaluateStep(budget, spent, t0 + HOUR - 5000).retryAfterSeconds).toBe(5);
  });

  it("never reports a non-positive wait while the window is still open", () => {
    const spent = { usedSteps: 3, resetAt: t0 + HOUR };
    expect(evaluateStep(budget, spent, t0 + HOUR).allowed).toBe(true);
    expect(retryAfterSeconds(0)).toBe(0);
    expect(retryAfterSeconds(-3)).toBe(0);
  });

  it("survives a missing or corrupt counter row", () => {
    expect(evaluateStep(budget, null, t0).allowed).toBe(true);
    expect(evaluateStep(budget, { usedSteps: "x", resetAt: null }, t0).allowed).toBe(true);
  });

  it("falls back to the default window if the stored one is nonsense", () => {
    const d = evaluateStep({ limitSteps: 1, windowMs: 0 }, { usedSteps: 1, resetAt: 0 }, t0);
    expect(d.resetAt).toBe(t0 + STEP_BUDGET_DEFAULT_WINDOW_MS);
  });
});

describe("stepBudgetDeniedMessage", () => {
  it("tells the agent the step did not happen and not to keep trying", () => {
    const msg = stepBudgetDeniedMessage(60);
    expect(msg).toMatch(/not taken/i);
    expect(msg).toMatch(/not counted/i);
    expect(msg).toContain("60s");
  });

  it("leaks neither the limit, the remaining count nor the scope", () => {
    const msg = stepBudgetDeniedMessage(60);
    expect(msg).not.toMatch(/\b15\b/);
    expect(msg).not.toMatch(/key:|provider:|ca\b|noauth/i);
    expect(msg).not.toMatch(/remaining|left/i);
  });

  it("omits the wait when there is nothing to wait for", () => {
    expect(stepBudgetDeniedMessage(0)).not.toMatch(/Retry after/);
  });
});