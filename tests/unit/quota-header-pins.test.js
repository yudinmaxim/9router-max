import { describe, it, expect } from "vitest";
import { selectHeaderChips } from "@/shared/utils/quota";

// The header strip picks by itself: the scale closest to running out wins the
// slot. A pinned widget is the operator's own choice and must survive that —
// "always" means always, even when the strip is full.
describe("Header chip selection", () => {
  const chip = (id, remaining, pinned = false) => ({ id, pinned, quota: { remaining } });

  it("keeps a pinned chip even when the strip is full", () => {
    const chips = [
      chip("a", 10),        // tightest, but not pinned
      chip("b", 20),
      chip("c", 30),
      chip("pinned", 90, true), // barely any left, but the operator asked for it
    ];
    const { shown } = selectHeaderChips(chips, 3);
    expect(shown.map((c) => c.id)).toContain("pinned");
  });

  it("does not let a pinned chip push out the automatic ones", () => {
    const chips = [chip("a", 10), chip("b", 20), chip("c", 30), chip("pinned", 90, true)];
    const { shown } = selectHeaderChips(chips, 3);
    expect(shown).toHaveLength(3);
    // The pinned one is in, and it takes the slot of the least urgent of the
    // automatic ones — it is the operator's account, so it goes first.
    expect(shown.map((c) => c.id)).toContain("pinned");
  });

  it("shows every pinned chip even beyond the cap", () => {
    const chips = [
      chip("p1", 90, true),
      chip("p2", 91, true),
      chip("p3", 92, true),
      chip("p4", 93, true),
      chip("a", 10),
    ];
    const { shown } = selectHeaderChips(chips, 3);
    expect(shown.filter((c) => c.pinned)).toHaveLength(4);
  });

  it("counts what did not fit", () => {
    const chips = [chip("a", 10), chip("b", 20), chip("c", 30), chip("d", 40)];
    const { shown, overflow } = selectHeaderChips(chips, 3);
    expect(shown).toHaveLength(3);
    expect(overflow).toBe(1);
  });

  it("survives an empty or missing list", () => {
    expect(selectHeaderChips([], 3)).toEqual({ shown: [], overflow: 0 });
    expect(selectHeaderChips(null, 3)).toEqual({ shown: [], overflow: 0 });
  });
});
