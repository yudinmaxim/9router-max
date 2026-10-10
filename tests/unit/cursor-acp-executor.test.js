import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";

// `vi.hoisted` runs before the mocked module is evaluated, so the factory can
// safely reference the mock fn.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

const { default: CursorAcpExecutor, resolveCursorModelId, cursorModelName } =
  await import("open-sse/executors/cursor-acp.js");

// Catalog shape returned by cursor-agent in the session/new response. The
// bracketed option list is part of the id and an empty `[]` is still required.
const CATALOG = {
  currentModelId: "default[]",
  availableModels: [
    { modelId: "default[]" },
    { modelId: "composer-2.5[fast=true]" },
    { modelId: "gpt-5.3-codex[reasoning=medium,fast=false]" },
    { modelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]" },
    { modelId: "gpt-5.4-mini[reasoning=medium]" },
    { modelId: "claude-opus-5-5[context=300k,effort=medium,fast=false]" },
  ],
};

/**
 * Fake cursor-agent ACP subprocess. Mirrors the real CLI's validation: a missing
 * or non-array `mcpServers` is rejected with -32602, and a model id outside the
 * catalog with -32602 "Invalid model value".
 */
function makeFakeChild({ catalog = CATALOG, promptUpdates = null, stopReason = "end_turn", promptError = null } = {}) {
  const child = new EventEmitter();
  child.writes = [];
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.write = (data) => {
    child.writes.push(String(data));
    try {
      handle(JSON.parse(String(data).trim()));
    } catch {
      /* ignore */
    }
    return true;
  };
  child.stdin.end = () => {
    child.stdin.destroyed = true;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };

  const send = (obj) => child.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  const notify = (sessionUpdate, extra = {}) =>
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: { sessionUpdate, content: { type: "text", text: "" }, ...extra },
      },
    });

  function handle(msg) {
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true, sse: true },
            promptCapabilities: { image: true },
          },
        },
      });
    } else if (msg.method === "session/new") {
      if (!Array.isArray(msg.params?.mcpServers)) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid params", data: [{ path: ["mcpServers"], message: "expected array" }] },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { sessionId: "fake-session", models: catalog },
      });
    } else if (msg.method === "session/set_model") {
      const known = (catalog.availableModels || []).some((m) => m.modelId === msg.params.modelId);
      if (!known) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid model value" },
        });
        return;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "session/prompt") {
      if (!Array.isArray(msg.params?.prompt)) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid params" },
        });
        return;
      }
      if (promptError) {
        send({ jsonrpc: "2.0", id: msg.id, error: promptError });
        return;
      }
      const updates = promptUpdates || [
        ["agent_thought_chunk", "(thinking)"],
        ["agent_message_chunk", "hello world"],
      ];
      for (const [kind, text] of updates) notify(kind, { content: { type: "text", text } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason } });
    }
  }

  return child;
}

async function runExecute(opts = {}) {
  const child = makeFakeChild(opts);
  spawnMock.mockImplementation((bin, args, spawnOpts) => {
    child.bin = bin;
    child.args = args;
    child.opts = spawnOpts;
    return child;
  });
  const exec = new CursorAcpExecutor();
  const { response, url, transformedBody } = await exec.execute({
    model: "gpt-5.3-codex",
    body: { messages: [{ role: "user", content: "hi" }] },
    credentials: {},
    log: { info() {}, debug() {} },
    ...opts.execute,
  });
  const reader = response.body.getReader();
  let acc = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
  }
  return { acc, child, url, transformedBody };
}

const sseFrames = (acc) =>
  acc
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice(6)));

beforeEach(() => {
  spawnMock.mockReset();
});

describe("CursorAcpExecutor handshake", () => {
  it("spawns `cursor-agent acp` and initializes with protocolVersion 1", async () => {
    const { child } = await runExecute();
    expect(child.args).toEqual(["acp"]);
    const init = child.writes.map((w) => JSON.parse(w.trim())).find((m) => m.method === "initialize");
    expect(init.params.protocolVersion).toBe(1);
  });

  it("opens a session with mcpServers as an array", async () => {
    const { child } = await runExecute();
    const newMsg = child.writes.map((w) => JSON.parse(w.trim())).find((m) => m.method === "session/new");
    expect(newMsg).toBeTruthy();
    expect(Array.isArray(newMsg.params.mcpServers)).toBe(true);
  });

  it("defaults the session cwd to os.tmpdir() when the request has none", async () => {
    const { child } = await runExecute();
    const newMsg = child.writes.map((w) => JSON.parse(w.trim())).find((m) => m.method === "session/new");
    expect(newMsg.params.cwd).toBe(os.tmpdir());
  });

  it("adopts a client workspace cwd from <cwd> env context for both spawn and session/new", async () => {
    const workspace = os.tmpdir();
    const { child } = await runExecute({
      execute: {
        body: {
          messages: [
            { role: "user", content: `<environment_context>\n  <cwd>${workspace}</cwd>\n</environment_context>\nhi` },
          ],
        },
      },
    });
    const newMsg = child.writes.map((w) => JSON.parse(w.trim())).find((m) => m.method === "session/new");
    expect(newMsg.params.cwd).toBe(workspace);
    expect(child.opts.cwd).toBe(workspace);
  });

  it("inherits the parent env so the CLI keeps its stored login", async () => {
    const { child } = await runExecute();
    expect(child.opts.env.PATH).toBe(process.env.PATH);
    expect(child.opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });
});

describe("CursorAcpExecutor model selection", () => {
  it("calls session/set_model with the exact catalog id when the client asks for another model", async () => {
    const { child } = await runExecute();
    const setModel = child.writes.map((w) => JSON.parse(w.trim())).find((m) => m.method === "session/set_model");
    expect(setModel).toBeTruthy();
    expect(setModel.params.modelId).toBe("gpt-5.3-codex[reasoning=medium,fast=false]");
    expect(setModel.params.sessionId).toBe("fake-session");
  });

  it("skips session/set_model when the requested model is already current", async () => {
    const { child } = await runExecute({ execute: { model: "default" } });
    const methods = child.writes.map((w) => JSON.parse(w.trim())).map((m) => m.method);
    expect(methods).not.toContain("session/set_model");
    expect(methods.indexOf("session/prompt")).toBeGreaterThan(methods.indexOf("session/new"));
  });

  it("falls back to Auto for an unknown model instead of erroring", async () => {
    // Catalog whose current model is NOT Auto, so the degraded request has to be
    // switched to `default[]` rather than silently running on the current model.
    const catalog = { currentModelId: "composer-2.5[fast=true]", availableModels: CATALOG.availableModels };
    const { child, acc } = await runExecute({ execute: { model: "totally-unknown" }, catalog });
    const setModel = child.writes.map((w) => JSON.parse(w.trim())).find((m) => m.method === "session/set_model");
    expect(setModel.params.modelId).toBe("default[]");
    expect(acc).not.toContain('"error"');
    const frames = sseFrames(acc);
    expect(frames[frames.length - 1].choices[0].finish_reason).toBe("stop");
  });

  it("skips set_model when an unknown model degrades to the already-current Auto", async () => {
    const { child, acc } = await runExecute({ execute: { model: "totally-unknown" } });
    const methods = child.writes.map((w) => JSON.parse(w.trim())).map((m) => m.method);
    expect(methods).not.toContain("session/set_model");
    expect(acc).not.toContain('"error"');
  });
});

describe("CursorAcpExecutor streaming", () => {
  it("streams message chunks as content deltas and closes with finish_reason", async () => {
    const { acc } = await runExecute();
    const frames = sseFrames(acc);
    expect(frames[0].choices[0].delta.role).toBe("assistant");
    const content = frames
      .map((f) => f.choices[0].delta.content || "")
      .join("");
    expect(content).toBe("hello world");
    const last = frames[frames.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage.estimated).toBe(true);
    expect(acc.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("routes thought chunks to reasoning_content, not content", async () => {
    const { acc } = await runExecute();
    const frames = sseFrames(acc);
    const reasoning = frames
      .map((f) => f.choices[0].delta.reasoning_content || "")
      .join("");
    expect(reasoning).toBe("(thinking)");
    const content = frames
      .map((f) => f.choices[0].delta.content || "")
      .join("");
    expect(content).toBe("hello world");
  });

  it("never re-emits cursor's own tool calls as OpenAI tool_calls", async () => {
    const { acc } = await runExecute({
      promptUpdates: [
        ["agent_message_chunk", "working"],
        ["tool_call", ""],
        ["tool_call_update", ""],
        ["agent_message_chunk", "done"],
      ],
      execute: {
        body: {
          messages: [{ role: "user", content: "run a shell command" }],
          tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
        },
      },
    });
    const frames = sseFrames(acc);
    expect(frames.some((f) => f.choices[0].delta.tool_calls)).toBe(false);
    expect(frames.every((f) => f.choices[0].finish_reason !== "tool_calls")).toBe(true);
    const content = frames.map((f) => f.choices[0].delta.content || "").join("");
    expect(content).toBe("workingdone");
  });

  it("maps max_tokens to finish_reason length", async () => {
    const { acc } = await runExecute({ stopReason: "max_tokens" });
    const frames = sseFrames(acc);
    expect(frames[frames.length - 1].choices[0].finish_reason).toBe("length");
  });

  it("emits a single finish frame and one [DONE]", async () => {
    const { acc } = await runExecute();
    const frames = sseFrames(acc);
    const finishes = frames.filter((f) => f.choices[0].finish_reason !== null);
    expect(finishes).toHaveLength(1);
    expect(acc.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});

describe("CursorAcpExecutor failures", () => {
  it("surfaces a JSON-RPC error from the prompt turn as an SSE error frame", async () => {
    const { acc } = await runExecute({ promptError: { code: -32603, message: "Internal error" } });
    const frames = sseFrames(acc);
    expect(frames).toHaveLength(1);
    expect(frames[0].error.message).toMatch(/Cursor ACP error -32603: Internal error/);
    expect(frames[0].error.type).toBe("cursor_acp_error");
    expect(acc.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("reports a helpful error when the binary is missing", async () => {
    // A child that never answers the handshake, so the spawn error is what
    // actually ends the turn.
    const child = makeFakeChild();
    child.stdin.write = () => true;
    spawnMock.mockImplementation(() => {
      setImmediate(() =>
        child.emit("error", Object.assign(new Error("spawn cursor-agent ENOENT"), { code: "ENOENT" }))
      );
      return child;
    });
    const exec = new CursorAcpExecutor();
    const { response } = await exec.execute({
      model: "default",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: {},
      log: { info() {}, debug() {} },
    });
    let acc = "";
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += new TextDecoder().decode(value);
    }
    const frames = sseFrames(acc);
    expect(frames[0].error.message).toMatch(/Cursor Agent CLI not found/);
    expect(frames[0].error.code).toBe("spawn_failed");
    expect(acc).toContain("data: [DONE]");
  });

  it("reports an error when session/new yields no sessionId", async () => {
    const child = makeFakeChild();
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data) => {
      const text = String(data);
      child.writes.push(text);
      try {
        const msg = JSON.parse(text.trim());
        if (msg.method === "initialize") {
          child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n"));
        } else if (msg.method === "session/new") {
          child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n"));
        }
      } catch {
        /* ignore */
      }
      return true;
    };
    spawnMock.mockImplementation(() => child);
    const exec = new CursorAcpExecutor();
    const { response } = await exec.execute({
      model: "default",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: {},
      log: { info() {}, debug() {} },
    });
    let acc = "";
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += new TextDecoder().decode(value);
    }
    expect(sseFrames(acc)[0].error.message).toMatch(/no sessionId/);
  });

  it("kills the subprocess when the caller aborts", async () => {
    const child = makeFakeChild({ stopReason: null });
    spawnMock.mockImplementation(() => child);
    const controller = new AbortController();
    const exec = new CursorAcpExecutor();
    const { response } = await exec.execute({
      model: "default",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: {},
      signal: controller.signal,
      log: { info() {}, debug() {} },
    });
    controller.abort();
    expect(child.killed).toBe(true);
    // Drain so the stream controller closes cleanly.
    const reader = response.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
});

describe("resolveCursorModelId", () => {
  const ids = CATALOG.availableModels.map((m) => m.modelId);

  it("strips the bracketed option list from a cursor model id", () => {
    expect(cursorModelName("gpt-5.4[context=272k]")).toBe("gpt-5.4");
    expect(cursorModelName("default[]")).toBe("default");
  });

  it("passes an exact catalog id through unchanged", () => {
    expect(resolveCursorModelId("gpt-5.4[context=272k,reasoning=medium,fast=false]", ids)).toBe(
      "gpt-5.4[context=272k,reasoning=medium,fast=false]"
    );
  });

  it("re-attaches the option list for a bracket-free client id", () => {
    expect(resolveCursorModelId("gpt-5.3-codex", ids)).toBe("gpt-5.3-codex[reasoning=medium,fast=false]");
    expect(resolveCursorModelId("composer-2.5", ids)).toBe("composer-2.5[fast=true]");
  });

  it("prefers the exact name over a longer prefixed variant", () => {
    expect(resolveCursorModelId("gpt-5.4", ids)).toBe("gpt-5.4[context=272k,reasoning=medium,fast=false]");
    expect(resolveCursorModelId("gpt-5.4-mini", ids)).toBe("gpt-5.4-mini[reasoning=medium]");
  });

  it("matches across dash/dot version separators", () => {
    expect(resolveCursorModelId("claude-opus-5.5", ids)).toBe("claude-opus-5-5[context=300k,effort=medium,fast=false]");
    expect(resolveCursorModelId("claude-opus-5-5", ids)).toBe("claude-opus-5-5[context=300k,effort=medium,fast=false]");
  });

  it("resolves `default` to the Auto model", () => {
    expect(resolveCursorModelId("default", ids)).toBe("default[]");
    expect(resolveCursorModelId("", ids)).toBe("default[]");
  });

  it("degrades an unknown id to Auto", () => {
    expect(resolveCursorModelId("no-such-model", ids)).toBe("default[]");
  });

  it("forwards the request untouched when the CLI reports no catalog", () => {
    expect(resolveCursorModelId("gpt-5.3-codex", [])).toBe("gpt-5.3-codex");
  });
});