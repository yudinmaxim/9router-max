import { describe, it, expect } from "vitest";
import { normalizeQuotaRows, pickHeaderQuotas } from "@/shared/utils/quota";

// Codex sends its quota windows as an object keyed by window name, while
// Cursor and Claude send a list. Code that assumed a list saw nothing for
// Codex — no rows, no table, and the agent card took the place of the windows
// the operator came for.
describe("Quota row shapes", () => {
  it("reads Codex's windows out of the object it sends", () => {
    const rows = normalizeQuotaRows("codex", {
      session: { used: 45, total: 100, remaining: 55, resetAt: "2026-10-26T09:42:39.000Z" },
      weekly: { used: 12, total: 100, remaining: 88, resetAt: null },
      review_session: { used: 0, total: 100, remaining: 100, resetAt: null },
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual(["5h", "Weekly", "Review (5h)"]);
    expect(rows[0].used).toBe(45);
    expect(rows[0].remaining).toBe(55);
    expect(rows[0].resetAt).toBe("2026-10-26T09:42:39.000Z");
  });

  it("marks a Codex window as a percentage of itself", () => {
    // "45" is 45% of the window, not 45 calls out of 100 — the row must not
    // be read as a count.
    const [row] = normalizeQuotaRows("codex", {
      session: { used: 45, total: 100, remaining: 55 },
    });
    expect(row.percentBased).toBe(true);
  });

  it("leaves a list alone", () => {
    const rows = [{ name: "5h", used: 1, total: 2 }];
    expect(normalizeQuotaRows("claude", rows)).toBe(rows);
    expect(normalizeQuotaRows("codex", rows)).toBe(rows);
  });

  it("returns nothing rather than guessing for an unknown shape", () => {
    expect(normalizeQuotaRows("codex", null)).toEqual([]);
    expect(normalizeQuotaRows("codex", undefined)).toEqual([]);
    // A provider whose object shape nobody has read yet: no rows, not junk.
    expect(normalizeQuotaRows("mystery", { a: { used: 1 } })).toEqual([]);
  });
});

describe("Header chips", () => {
  it("gives Codex a chip off its own windows", () => {
    const chips = pickHeaderQuotas(
      { quotas: { session: { used: 95, total: 100, remaining: 5, resetAt: null } } },
      "codex",
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].spent).toBe(95);
    expect(chips[0].remaining).toBe(5);
  });
});
