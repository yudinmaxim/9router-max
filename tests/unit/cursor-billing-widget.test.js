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
