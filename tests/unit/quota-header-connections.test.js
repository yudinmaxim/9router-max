import { describe, it, expect } from "vitest";
import { chooseHeaderConnections, selectHeaderChips, shortAccountLabel } from "@/shared/utils/quota";

// One provider normally contributes one chip to the header strip. A pinned
// connection is the operator's own choice, so it always contributes its own
// chip — and the provider then contributes no automatic one, or the operator
// would see the account they did not ask for next to the one they did.
describe("Which connections earn a chip", () => {
  const conn = (id, provider, isActive = true) => ({ id, provider, isActive });

  it("gives one chip per provider when nothing is pinned", () => {
    const chosen = chooseHeaderConnections(
      [conn("a", "codex"), conn("b", "codex"), conn("c", "cursor")],
      [],
    );
    expect(chosen.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("shows the pinned account instead of the automatic one", () => {
    const chosen = chooseHeaderConnections([conn("a", "codex"), conn("b", "codex")], ["b"]);
    expect(chosen.map((c) => c.id)).toEqual(["b"]);
  });

  it("shows both accounts when both are pinned", () => {
    const chosen = chooseHeaderConnections([conn("a", "codex"), conn("b", "codex")], ["a", "b"]);
    expect(chosen.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("keeps other providers on their automatic chip", () => {
    const chosen = chooseHeaderConnections(
      [conn("a", "codex"), conn("b", "codex"), conn("c", "cursor")],
      ["b"],
    );
    expect(chosen.map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("skips a disabled connection unless it was pinned on purpose", () => {
    const chosen = chooseHeaderConnections(
      [conn("a", "codex", false), conn("b", "codex")],
      [],
    );
    expect(chosen.map((c) => c.id)).toEqual(["b"]);
  });

  it("still lets a pinned chip through the strip's cap", () => {
    const chips = [
      { id: "p1", pinned: true, quota: { remaining: 90 } },
      { id: "p2", pinned: true, quota: { remaining: 91 } },
      { id: "a", pinned: false, quota: { remaining: 10 } },
    ];
    const { shown } = selectHeaderChips(chips, 1);
    expect(shown.filter((c) => c.pinned)).toHaveLength(2);
  });
});

// Two accounts of one provider are two different chips, so the chip has to say
// whose it is. Connection names arrive as "[Екатерина] sigma.mipt@outlook.com"
// — the bracketed part identifies the person, which is the part worth showing.
describe("Naming the account behind a chip", () => {
  it("takes the bracketed name when there is one", () => {
    expect(shortAccountLabel({ name: "[Екатерина] sigma.mipt@outlook.com" })).toBe("Екатерина");
  });

  it("falls back to the mail name", () => {
    expect(shortAccountLabel({ name: "sigma.mipt@outlook.com" })).toBe("sigma.mipt");
    expect(shortAccountLabel({ name: "", email: "someone@example.com" })).toBe("someone");
  });

  it("falls back to the provider when there is nothing else", () => {
    expect(shortAccountLabel({ provider: "codex-acp" })).toBe("Codex Acp");
    expect(shortAccountLabel({})).toBe("");
  });
});
