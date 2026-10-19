import { describe, expect, it } from "vitest";
import { stripHistoryForContext } from "../../open-sse/services/capacityAdapter.js";

describe("ACP context guard", () => {
  it("keeps system, initial context, and current turn while dropping middle history", () => {
    const body = { messages: [
      { role: "system", content: "rules" },
      ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(100) })),
      { role: "user", content: "current" },
    ] };
    const trimmed = stripHistoryForContext(body, 100);
    expect(trimmed.messages.at(0).role).toBe("system");
    expect(trimmed.messages.at(-1).content).toBe("current");
    expect(trimmed.messages.length).toBeLessThan(body.messages.length);
  });

  it("does not mutate or trim already fitting history", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    expect(stripHistoryForContext(body, 100)).toBe(body);
  });
});
