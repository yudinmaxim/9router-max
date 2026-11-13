// The shadow transcript feeds session/load replay and is persisted to
// SQLite on a throttle — it must stay bounded or long agent sessions
// (token chunks + terminal_output_delta streams) grow it until the
// router process OOMs. Pins the entry/char caps and fromJSON trimming.

import { describe, it, expect } from "vitest";
import { createShadowTranscript } from "../../open-sse/acp/transcript.js";

describe("shadow transcript bounds", () => {
  it("evicts oldest entries beyond the entry cap", () => {
    const t = createShadowTranscript();
    for (let i = 0; i < 500; i++) t.add({ sessionUpdate: "agent_message_chunk", i });
    const all = t.getAll();
    expect(all.length).toBeLessThanOrEqual(400);
    expect(all.at(-1).i).toBe(499);
    expect(all[0].i).toBe(500 - all.length);
  });

  it("evicts oldest entries beyond the char budget", () => {
    const t = createShadowTranscript();
    const big = "x".repeat(100 * 1024);
    for (let i = 0; i < 20; i++) t.add({ sessionUpdate: "tool_call_update", blob: big + i });
    const all = t.getAll();
    const total = all.reduce((n, e) => n + JSON.stringify(e).length, 0);
    expect(total).toBeLessThanOrEqual(512 * 1024 + 100 * 1024); // last oversized entry may exceed alone
    expect(all.at(-1).blob.endsWith("19")).toBe(true);
  });

  it("fromJSON re-applies the caps to stored transcripts", () => {
    const t = createShadowTranscript();
    const stored = Array.from({ length: 1000 }, (_, i) => ({ sessionUpdate: "agent_message_chunk", i }));
    t.fromJSON(JSON.stringify(stored));
    const all = t.getAll();
    expect(all.length).toBeLessThanOrEqual(400);
    expect(all.at(-1).i).toBe(999);
  });

  it("clear resets entries and budgets", () => {
    const t = createShadowTranscript();
    t.add({ a: 1 });
    t.clear();
    expect(t.getAll()).toEqual([]);
    t.add({ b: 2 });
    expect(t.getAll()).toEqual([{ b: 2 }]);
  });
});
