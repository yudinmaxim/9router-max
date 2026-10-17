// Quota formatting: what a chip shows, and how the colour map resolves.
//
// The colour map existed three times and had already drifted — the table used
// `dark:` text variants, the bar used the plain ones — so the same quota could
// render two different greens. `getQuotaColors` is now the only copy and `dark`
// is its one option; these tests pin that the two historical call sites keep
// producing what they produced before, because "deduplicated" must not also mean
// "the bar changed colour".

import { describe, it, expect } from "vitest";
import {
  pickHeaderQuotas,
  getQuotaColors,
  getStatusColor,
  getStatusEmoji,
  getRemainingPercentage,
  calculatePercentage,
  formatResetTime,
} from "@/shared/utils/quota";

describe("picking what a chip shows", () => {
  it("takes the tightest row, not the first", () => {
    const [picked] = pickHeaderQuotas({
      quotas: [
        { name: "Weekly", remainingPercentage: 80 },
        { name: "Session (5h)", remainingPercentage: 12 },
        { name: "Monthly", remainingPercentage: 55 },
      ],
    });
    expect(picked).toMatchObject({ label: "Session (5h)", remaining: 12 });
    // The complement is on the same allowance, so it costs nothing to show.
    expect(picked.spent).toBe(88);
  });

  it("ignores unlimited rows even when they sort first", () => {
    // An unlimited row can never be the tightest, and reporting "100% left" as
    // the headline would be the one number nobody needs.
    const [picked] = pickHeaderQuotas({
      quotas: [
        { name: "Everything", remainingPercentage: 100, unlimited: true },
        { name: "Weekly", remainingPercentage: 31 },
      ],
    });
    expect(picked.label).toBe("Weekly");
  });

  it("gives Cursor two chips, because it has two scales", () => {
    const picked = pickHeaderQuotas({
      plan: "Cursor",
      spendBars: {
        cursorModels: { pct: 14.05 },
        otherModels: { pct: 14.22 },
        total: { pct: 14.05, amount: 64.82 },
      },
      planLimits: { cycleEnd: "2026-11-15T18:17:57.000Z" },
    });
    // One chip per scale. Collapsing them would produce a number belonging to
    // neither: 14.05 and 14.22 are near-identical only because they are measured
    // against separate allowances.
    expect(picked).toHaveLength(2);
    expect(picked.map((c) => c.label)).toEqual(["Cursor models", "Other models"]);
    expect(picked[0]).toMatchObject({ spent: 14, remaining: 86 });
    expect(picked[1]).toMatchObject({ spent: 14, remaining: 86 });
    expect(picked[0].resetAt).toBe("2026-11-15T18:17:57.000Z");
  });

  it("falls back to the cycle total when there are no per-model bars", () => {
    const picked = pickHeaderQuotas({ plan: "Cursor", spendBars: { total: { pct: 42 } } });
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ label: "Cursor", spent: 42, remaining: 58 });
  });

  it("clamps an over-spent cycle to zero rather than reporting negative headroom", () => {
    const [picked] = pickHeaderQuotas({ spendBars: { total: { pct: 140 } } });
    expect(picked.remaining).toBe(0);
    expect(picked.spent).toBe(100);
  });

  it("returns an empty list when there is nothing worth a chip", () => {
    expect(pickHeaderQuotas(null)).toEqual([]);
    expect(pickHeaderQuotas({})).toEqual([]);
    expect(pickHeaderQuotas({ quotas: [] })).toEqual([]);
    expect(pickHeaderQuotas({ quotas: [{ name: "All", unlimited: true }] })).toEqual([]);
    // A provider that answered with a refusal rather than numbers.
    expect(pickHeaderQuotas({ unsupported: "own-subscription" })).toEqual([]);
  });

  it("carries four fields out and nothing else", () => {
    // This is the whole token-safety argument for the chips. The usage payload is
    // whatever a provider's reader produced, so if this function returned the
    // payload — or spread it — a field called `accessToken` would ride along into
    // a header that renders on every dashboard page. Connections themselves come
    // from /api/providers/client, which has a field whitelist; this is the other
    // half, and it works by omission rather than by filtering.
    const picked = pickHeaderQuotas({
      accessToken: "sk-secret",
      refreshToken: "rt-secret",
      apiKey: "sk-secret",
      connection: { id: "x", apiKey: "sk-secret" },
      quotas: [{ name: "Weekly", remainingPercentage: 12, resetAt: "2026-01-01T00:00:00Z" }],
    });
    expect(Object.keys(picked[0]).sort()).toEqual(["label", "remaining", "resetAt", "spent"]);
    expect(JSON.stringify(picked)).not.toContain("sk-secret");
  });

  it("keeps a zero-valued row: 0% left is the most urgent thing there is", () => {
    const [picked] = pickHeaderQuotas({
      quotas: [{ name: "Weekly", remainingPercentage: 0 }],
    });
    expect(picked.remaining).toBe(0);
    expect(picked.spent).toBe(100);
    expect(getStatusColor(0)).toBe("red");
  });
});

describe("the colour map, in one place", () => {
  it("keeps the thresholds both call sites already used", () => {
    expect(getStatusColor(71)).toBe("green");
    expect(getStatusColor(70)).toBe("yellow");
    expect(getStatusColor(30)).toBe("yellow");
    expect(getStatusColor(29)).toBe("red");
  });

  it("reproduces the table's dark-aware text classes", () => {
    expect(getQuotaColors(80, { dark: true })).toEqual({
      text: "text-green-600 dark:text-green-400",
      bg: "bg-green-500",
      bgLight: "bg-green-500/10",
      emoji: "🟢",
    });
  });

  it("reproduces the bar's plain text classes", () => {
    expect(getQuotaColors(80).text).toBe("text-green-500");
    expect(getQuotaColors(80).bg).toBe("bg-green-500");
    expect(getQuotaColors(10).text).toBe("text-red-500");
    expect(getQuotaColors(10).emoji).toBe("🔴");
  });

  it("agrees with the bare-name helpers on the tone", () => {
    for (const pct of [100, 71, 70, 55, 30, 29, 0]) {
      const tone = getQuotaColors(pct).emoji;
      expect(tone).toBe(getStatusEmoji(pct));
    }
  });
});

describe("percentage helpers", () => {
  it("prefers an explicit remaining value over a recomputed one", () => {
    expect(getRemainingPercentage({ remaining: 42, remainingPercentage: 99 })).toBe(42);
    expect(getRemainingPercentage({ remainingPercentage: 33.4 })).toBe(33);
  });

  it("falls back to used/total", () => {
    expect(getRemainingPercentage({ used: 25, total: 100 })).toBe(75);
    expect(calculatePercentage(100, 100)).toBe(0);
    expect(calculatePercentage(0, 0)).toBe(0);
  });
});

describe("reset countdown", () => {
  it("degrades to a dash rather than throwing on junk", () => {
    expect(formatResetTime(null)).toBe("-");
    expect(formatResetTime("not a date")).toBe("-");
  });

  it("counts down in days and hours for a future date", () => {
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    expect(formatResetTime(future)).toMatch(/^\d+d \d+h/);
  });
});