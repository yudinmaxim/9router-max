// The pure half of the server-side MCP tool loop.
//
// Everything here is what the loop does to a message once the model has asked
// for a tool, so the cases that matter are the ones a live provider triggers and
// a unit test can pin: arguments that arrive as broken JSON, a tool that fails,
// and a stream whose tool call is split across deltas.

import { describe, it, expect } from "vitest";
import {
  addUsage,
  patchUsageInBody,
  messageFromDeltas,
  pickOwnedToolCalls,
  parseToolArguments,
  appendToolResults,
  readResponseMessage,
  rebuildResponse,
} from "open-sse/utils/mcpToolLoop.js";

describe("reading a provider response", () => {
  it("reads a plain JSON body", async () => {
    const res = new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "hi" } }],
    }), { headers: { "content-type": "application/json" } });
    const read = await readResponseMessage(res);
    expect(read.wasSse).toBe(false);
    expect(read.message.content).toBe("hi");
  });

  it("rebuilds a tool call that arrived split across SSE deltas", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"calling"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"mcp9r__probe__","arguments":"{\\"q\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}',
      "data: [DONE]",
    ].join("\n\n");
    const res = new Response(frames, { headers: { "content-type": "text/event-stream" } });
    const read = await readResponseMessage(res);
    expect(read.wasSse).toBe(true);
    expect(read.message.content).toBe("calling");
    expect(read.message.tool_calls).toHaveLength(1);
    // The name and the arguments arrive in separate frames and must be joined,
    // not taken from whichever frame happened to carry them.
    expect(read.message.tool_calls[0].function.name).toBe("mcp9r__probe__");
    expect(parseToolArguments(read.message.tool_calls[0].function.arguments)).toEqual({ q: "x" });
  });

  it("returns a readable body again after the loop consumed it", async () => {
    const original = new Response("payload", { status: 200, headers: { "content-type": "application/json" } });
    const read = await readResponseMessage(original);
    const rebuilt = rebuildResponse(original, read.text, read.wasSse);
    expect(rebuilt.status).toBe(200);
    // The whole reason rebuildResponse exists: without it every handler
    // downstream would read an already-consumed body.
    expect(await rebuilt.text()).toBe("payload");
  });
});

describe("deciding which calls are ours", () => {
  const message = {
    role: "assistant",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "mcp9r__probe__search", arguments: "{}" } },
      { id: "call_2", type: "function", function: { name: "get_weather", arguments: "{}" } },
      { id: "call_3", type: "function", function: { name: "mcp__exa__web_search_exa", arguments: "{}" } },
    ],
  };
  const owned = new Set(["mcp9r__probe__search"]);

  it("takes only the registry tools", () => {
    const picked = pickOwnedToolCalls(message, (n) => owned.has(n));
    expect(picked.map((c) => c.id)).toEqual(["call_1"]);
  });

  it("takes nothing from a message with no tool calls", () => {
    expect(pickOwnedToolCalls({ role: "assistant", content: "no tools" }, () => true)).toEqual([]);
    expect(pickOwnedToolCalls(undefined, () => true)).toEqual([]);
  });
});

describe("tool arguments", () => {
  it("treats absent or empty arguments as an empty object", () => {
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("   ")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
  });

  it("keeps broken JSON as raw text instead of throwing away the call", () => {
    // A model that emits `{"q": ` has still made a call. Dropping it would
    // leave the provider with a tool_call that never gets a result.
    expect(parseToolArguments('{"q": ')).toEqual({ _raw: '{"q":' });
  });
});

describe("folding results back into the history", () => {
  const calls = [
    { id: "call_1", type: "function", function: { name: "mcp9r__probe__search", arguments: "{}" } },
    { id: "call_2", type: "function", function: { name: "mcp9r__probe__search", arguments: "{}" } },
  ];

  it("adds an assistant turn plus one tool result per call", () => {
    const messages = appendToolResults(
      [{ role: "user", content: "find it" }],
      { role: "assistant", content: "looking" },
      calls,
      [{ text: "first" }, { text: "second" }]
    );
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", content: "find it" });
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].tool_calls).toHaveLength(2);
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "first" });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_2", content: "second" });
  });

  it("still answers a call whose result is missing", () => {
    // An assistant tool_calls message followed by fewer tool results than calls
    // is an orphaned call, which providers reject with a 400. A failure has to
    // arrive as content.
    const messages = appendToolResults([], { role: "assistant" }, calls, [{ text: "ok" }, undefined]);
    expect(messages).toHaveLength(3);
    expect(messages[2].content).toBe("(no result)");
  });
});
describe("accounting for rounds the client never sees", () => {
  // The loop makes one upstream call per round, the client asked for one answer,
  // and only the last round survives to become a statistics row. A live check
  // found three of four calls missing from the usage table; these are the sums
  // that stop that.
  it("reads usage out of a JSON body and a trailing SSE frame", async () => {
    const json = await readResponseMessage(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }), { headers: { "content-type": "application/json" } }));
    expect(json.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });

    const sse = await readResponseMessage(new Response([
      "data: {\"choices\":[{\"delta\":{}}]}",
      "data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}",
      "data: [DONE]",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    expect(sse.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3 });
  });

  it("adds rounds together", () => {
    const total = [1, 2, 3].reduce((acc, n) => addUsage(acc, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }), null);
    expect(total).toEqual({ prompt_tokens: 300, completion_tokens: 150, total_tokens: 450 });
  });

  it("ignores a field a round does not carry instead of zeroing it", () => {
    const total = addUsage({ prompt_tokens: 100 }, { prompt_tokens: 50, cached_tokens: 8 });
    expect(total).toEqual({ prompt_tokens: 150, cached_tokens: 8 });
  });

  it("adds the discarded rounds into the body the client gets", () => {
    const body = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "done" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    const patched = JSON.parse(patchUsageInBody(body, { prompt_tokens: 300, completion_tokens: 150, total_tokens: 450 }));
    // Four rounds at 100/50 each.
    expect(patched.usage).toEqual({ prompt_tokens: 400, completion_tokens: 200, total_tokens: 600 });
    expect(patched.choices[0].message.content).toBe("done");
  });

  it("leaves a body it cannot account for alone rather than rewriting it blind", () => {
    expect(patchUsageInBody("not json", { prompt_tokens: 5 })).toBe("not json");
    expect(patchUsageInBody("[1,2]", { prompt_tokens: 5 })).toBe("[1,2]");
    expect(patchUsageInBody("{}", null)).toBe("{}");
  });
});
