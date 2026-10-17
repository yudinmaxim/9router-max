import { describe, it, expect } from "vitest";
import { cursorSpendBars } from "open-sse/services/usage/cursor.js";

describe("Cursor billing numbers", () => {
  it("turns Cursor's cents into dollars and keeps its percentages", () => {
    // Shape taken from a live GetCurrentPeriodUsage response.
    const bars = cursorSpendBars({
      totalSpend: 6457,
      includedSpend: 2000,
      bonusSpend: 4457,
      limit: 2000,
      autoPercentUsed: 13.993333333333332,
      apiPercentUsed: 14.222222222222221,
      totalPercentUsed: 13.99891598915989,
    });
    expect(bars.total.amount).toBe(64.57);
    expect(bars.total.includedAmount).toBe(20);
    expect(bars.total.bonusAmount).toBe(44.57);
    expect(bars.total.limitAmount).toBe(20);
    expect(bars.total.pct).toBe(14);
    expect(bars.cursorModels.pct).toBe(13.99);
    expect(bars.otherModels.pct).toBe(14.22);
    // Cursor sends no per-category money, and bonusSpend is not one: it is the
    // cycle's extra credit, not what Cursor's own models cost.
    expect(bars.cursorModels.amount).toBeNull();
    expect(bars.otherModels.amount).toBeNull();
  });

  it("does not pretend the two model percentages share a scale", () => {
    const bars = cursorSpendBars({
      autoPercentUsed: 13.993333333333332,
      apiPercentUsed: 14.222222222222221,
      totalPercentUsed: 13.99891598915989,
    });
    // Each bar sits near 14% and their sum is roughly double the cycle total.
    // That is only possible if they are measured against separate allowances,
    // which is why the widget must not add them up or normalise them.
    expect(bars.cursorModels.pct + bars.otherModels.pct).toBeGreaterThan(bars.total.pct * 2);
    expect(bars.total.denominatorsKnown).toBe(false);
  });

  it("returns nulls rather than NaN when Cursor sends nothing usable", () => {
    const bars = cursorSpendBars(null);
    expect(bars.total.amount).toBeNull();
    expect(bars.total.pct).toBeNull();
    expect(bars.cursorModels.pct).toBeNull();
    expect(bars.otherModels.pct).toBeNull();
  });
});

// The widget markup itself is not asserted here: this repo keeps JSX inside .js
// files, which vite cannot parse in a test, so every sibling component is
// covered the same way — not at all. The numbers it prints come from
// cursorSpendBars, tested above.

describe("Cursor plan limits", () => {
  it("reads the included credit as spent and the bonus as finished", async () => {
    const { cursorPlanLimits } = await import("open-sse/services/usage/cursor.js");
    const limits = cursorPlanLimits(
      {
        totalSpend: 6472,
        includedSpend: 2000,
        bonusSpend: 4472,
        limit: 2000,
        remainingBonus: false,
      },
      {
        planInfo: { planName: "Pro", price: "$20/mo", billingCycleEnd: "1794766677000", includedUsagePeriod: "INCLUDED_USAGE_PERIOD_MONTHLY" },
        nextUpgrade: { name: "Pro+", price: "$60/mo", includedAmountCents: 7000, description: "Unlock 3x more usage" },
      }
    );
    // The single fact worth stating: $20 of $20 included is gone, the rest came
    // out of bonus, and there is no bonus left.
    expect(limits.includedLimit).toBe(20);
    expect(limits.includedUsed).toBe(20);
    expect(limits.includedRemaining).toBe(0);
    expect(limits.bonusUsed).toBe(44.72);
    expect(limits.bonusRemaining).toBe(false);
    expect(limits.totalSpend).toBe(64.72);
    expect(limits.membership).toBe("Pro");
    expect(limits.nextTier.includedAmountCents).toBe(7000);
  });

  it("survives a missing plan answer", async () => {
    const { cursorPlanLimits } = await import("open-sse/services/usage/cursor.js");
    const limits = cursorPlanLimits({ totalSpend: 100 }, null);
    expect(limits.membership).toBeNull();
    expect(limits.includedLimit).toBeNull();
    expect(limits.totalSpend).toBe(1);
  });
});

describe("Cursor Grok pool", () => {
  it("reports the pool Cursor does send", async () => {
    const { cursorGrokPool } = await import("open-sse/services/usage/cursor.js");
    const pool = cursorGrokPool({
      currentPeriodStart: "2026-10-15T00:00:00Z",
      usagePercent: 0,
      hasAvailableUsage: true,
      grokPlanLabel: "Grok Bot Plan",
      cursorPlanName: "Pro",
      onDemandSettings: { visible: true, eligible: true },
    });
    expect(pool.pct).toBe(0);
    expect(pool.hasAvailableUsage).toBe(true);
    expect(pool.label).toBe("Grok Bot Plan");
    expect(pool.includedInPlan).toBe("Pro");
    // The account says "Resets weekly"; the response carries no reset moment,
    // so the widget states the cadence and invents no date.
    expect(pool.resetsWeekly).toBe(true);
    expect(pool).not.toHaveProperty("resetAt");
  });
});

describe("Cursor model classification", () => {
  it("follows Cursor's own list instead of a name pattern", async () => {
    const { classifyByProviderList } = await import("@/lib/quotaTiers");
    const classify = classifyByProviderList(["composer-2.5", "grok-4.5", "vega-high"]);
    expect(classify("composer-2.5")).toBe("cursorModels");
    expect(classify("grok-4.5")).toBe("cursorModels");
    // A Cursor build that does not exist in the list is not Cursor's model, and
    // a third-party model that merely mentions grok is not either.
    expect(classify("composer-99")).not.toBe("cursorModels");
    expect(classify("someone-else-grok")).toBe("otherModels");
  });

  it("falls back to the pattern when the provider sends no list", async () => {
    const { classifyByProviderList } = await import("@/lib/quotaTiers");
    const classify = classifyByProviderList([]);
    expect(classify("composer-2.5")).toBe("cursorModels");
  });
});
