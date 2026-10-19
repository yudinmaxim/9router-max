import { describe, it, expect } from "vitest";
import { pickHeaderQuotas, chooseHeaderConnections } from "@/shared/utils/quota";

// The header used to carry a global switch and decide for itself which
// provider to show. Both are gone: the checkbox on the widget card is the only
// control, and the chip states its number as spent over what is left.
describe("Header widgets", () => {
  it("shows only the widgets the operator ticked", () => {
    const connections = [
      { id: "a", provider: "codex" },
      { id: "b", provider: "codex" },
      { id: "c", provider: "cursor" },
    ];
    expect(chooseHeaderConnections(connections, []).map((c) => c.id)).toEqual([]);
    expect(chooseHeaderConnections(connections, ["b"]).map((c) => c.id)).toEqual(["b"]);
    expect(chooseHeaderConnections(connections, ["a", "b"]).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("states a counted quota as spent over what is left", () => {
    const [chip] = pickHeaderQuotas(
      { quotas: { session: { used: 45, total: 100, remaining: 55, resetAt: null } } },
      "codex",
    );
    expect(chip.spent).toBe(45);
    expect(chip.remaining).toBe(55);
  });

  it("states Cursor's cycle as spent over what is left", () => {
    const [chip] = pickHeaderQuotas(
      { plan: "Pro", spendBars: { total: { amount: 64.57, limitAmount: 20, pct: 14 } } },
      "cursor",
    );
    expect(chip.spent).toBe(14);
    expect(chip.remaining).toBe(86);
  });

  it("keeps both Cursor scales apart", () => {
    const chips = pickHeaderQuotas(
      {
        spendBars: {
          cursorModels: { pct: 13.99, amount: null },
          otherModels: { pct: 14.22, amount: null },
        },
      },
      "cursor",
    );
    // Two allowances, two scales: collapsing them into one number would mean
    // a figure belonging to neither.
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.label)).toEqual(["Cursor models", "Other models"]);
  });
});
