// Pooled-session reuse, the part that broke live ACP runs.
//
// Two real bugs are pinned here, both found by tracing a live Codex child:
//
//   1. Every reuse failed with `-32602 Invalid params` three milliseconds
//      after the reused session started. The agent rejects a `session/
//      set_config_option` it does not offer, and the generic error handler
//      answered every `msg.error` with `finish(...)` — so one rejected option
//      cost the whole turn. The comment on `sendNextConfigOption` promised
//      otherwise; the handler did not do it.
//   2. Each reuse *caused* that rejection: the stored pool entry keeps the
//      model catalog as a bare id list, and `currentAgentModel()` over an id
//      list answers `""`. The resolver then believed the session sat on some
//      other model and re-pinned one the agent was already on.
//
// The second bug also shows up as a dead child: a pooled entry can outlive its
// process, and reusing its closed transport hangs the turn until the pool TTL.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

const { default: CursorAcpExecutor } = await import("open-sse/executors/cursor-acp.js");
const { clearAcpSessions } = await import("open-sse/executors/lib/acpSessionPool.js");

// cursor-agent's session/new shape: `models` carries the current id plus the
// catalog, which is what a pooled entry later stores as a bare id list.
const CATALOG = {
  currentModelId: "default[]",
  availableModels: [
    { modelId: "default[]" },
    { modelId: "composer-2.5[fast=true]" },
    { modelId: "gpt-5.3-codex[reasoning=medium,fast=false]" },
  ],
};

const CREDENTIALS = { connectionId: "conn-1" };
const REQUESTED_MODEL = "gpt-5.3-codex";

/**
 * Fake `cursor-agent acp` subprocess with the ACP flows a pooled session walks
 * through: initialize, session/new, session/resume, the model pin, the prompt.
 *
 * `rejectConfigOptions` reproduces Codex answering -32602 for a dashboard
 * option it does not expose — tolerated, the turn continues. `rejectModelPin`
 * reproduces the agent refusing `configId:"model"` itself, which now fails the
 * turn (an agent default may route back into 9router). The two are told apart
 * by configId because the base treats them differently. `exitCode` mirrors a
 * live process (null until it dies) — the reuse guard compares against exactly
 * that field.
 */
function makeFakeChild({ rejectConfigOptions = false, rejectModelPin = false, stopReason = "end_turn" } = {}) {
  const child = new EventEmitter();
  child.writes = [];
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.write = (data) => {
    const text = String(data);
    child.writes.push(text);
    try {
      handle(JSON.parse(text.trim()));
    } catch {
      /* ignore malformed input */
    }
    return true;
  };
  child.stdin.end = () => {
    child.stdin.destroyed = true;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const send = (obj) => child.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  const sessionResult = (id) =>
    send({ jsonrpc: "2.0", id, result: { sessionId: "fake-session", models: CATALOG } });

  function handle(msg) {
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        },
      });
    } else if (msg.method === "session/new" || msg.method === "session/resume") {
      sessionResult(msg.id);
    } else if (msg.method === "session/set_config_option") {
      const isModel = msg.params?.configId === "model";
      if ((isModel && rejectModelPin) || (!isModel && rejectConfigOptions)) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
        return;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    } else if (msg.method === "session/prompt") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello world" } },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason } });
    }
  }

  return child;
}

/** Run one turn and drain the SSE stream to text. */
async function runTurn(child, opts = {}) {
  spawnMock.mockImplementation(() => child);
  const exec = new CursorAcpExecutor();
  const { response } = await exec.execute({
    model: REQUESTED_MODEL,
    body: { messages: [{ role: "user", content: "hi" }] },
    credentials: CREDENTIALS,
    log: { info() {}, debug() {} },
    ...opts,
  });
  const reader = response.body.getReader();
  let acc = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
  }
  return acc;
}

const written = (child) => child.writes.map((w) => JSON.parse(w.trim()));
const methods = (child) => written(child).map((m) => m.method);

const sseFrames = (acc) =>
  acc
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice(6)));

beforeEach(() => {
  spawnMock.mockReset();
  clearAcpSessions();
});

afterEach(() => clearAcpSessions());

describe("rejected config option", () => {
  it("keeps the turn alive and still sends the prompt", async () => {
    const child = makeFakeChild({ rejectConfigOptions: true });
    // A dashboard default (not the model pin) is what gets refused here: the
    // agent does not expose that option, the base logs and continues.
    const acc = await runTurn(child, { acpSessionDefaults: { collaboration_mode: "agent" } });

    // The dashboard default goes out first and is turned down; the model pin
    // that follows is accepted, and the prompt still goes out on the same
    // turn instead of failing it.
    expect(methods(child)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    const configCalls = written(child).filter((m) => m.method === "session/set_config_option");
    expect(configCalls.map((m) => m.params.configId)).toEqual(["collaboration_mode", "model"]);
    expect(acc).not.toContain('"error"');
    const frames = sseFrames(acc);
    expect(frames.at(-1).choices[0].finish_reason).toBe("stop");
    expect(acc.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("fails the turn when the agent refuses the model pin", async () => {
    const child = makeFakeChild({ rejectModelPin: true });
    const acc = await runTurn(child);

    // The pin is the only config option this request sends, and its rejection
    // must end the turn loudly — falling back to the agent's own default model
    // is how a self-referential routing loop starts. So: an error frame naming
    // the refused model, and no prompt.
    expect(methods(child)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
    ]);
    expect(methods(child)).not.toContain("session/prompt");
    const frames = sseFrames(acc);
    expect(frames[0].error.message).toMatch(/Cursor Agent.*refused the model pin/);
    expect(acc.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("still fails the turn for an error that is not a config option", async () => {
    const child = makeFakeChild();
    // Break the prompt instead: a `msg.error` with a prompt id has to end the
    // turn, otherwise a failing agent would hang every caller.
    const orig = child.stdin.write;
    child.stdin.write = (data) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "session/prompt") {
        child.writes.push(String(data));
        child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "boom" } }) + "\n")
        );
        return true;
      }
      return orig.call(child.stdin, data);
    };
    const acc = await runTurn(child);
    const frames = sseFrames(acc);
    expect(frames[0].error.message).toMatch(/Cursor Agent ACP error -32603: boom/);
  });
});

describe("pooled session reuse", () => {
  it("reuses a live child without re-handshaking or re-pinning the model", async () => {
    const child = makeFakeChild();
    const first = await runTurn(child);
    expect(sseFrames(first).at(-1).choices[0].finish_reason).toBe("stop");

    const beforeSecondTurn = child.writes.length;
    const second = await runTurn(child);

    // One child for both turns: no second spawn, no initialize/session/new.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const secondTurnMethods = child.writes
      .slice(beforeSecondTurn)
      .map((w) => JSON.parse(w.trim()))
      .map((m) => m.method);
    // Only the prompt: the session is alive and already sits on the model the
    // first turn pinned, so re-pinning it (the -32602 trigger) must not happen.
    expect(secondTurnMethods).toEqual(["session/prompt"]);
    expect(sseFrames(second).at(-1).choices[0].finish_reason).toBe("stop");
    expect(second).not.toContain('"error"');
  });

  it("spawns fresh and resumes from the prior session when the pooled child died", async () => {
    const first = makeFakeChild();
    await runTurn(first);
    // The child exited while sitting in the pool — the state that used to hang
    // every later turn behind the pool TTL.
    first.exitCode = 1;

    const second = makeFakeChild();
    const acc = await runTurn(second);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    // Fresh process ⇒ full handshake, then session/resume against the pooled
    // session id instead of opening a brand-new one.
    expect(methods(second)[0]).toBe("initialize");
    expect(methods(second)).toContain("session/resume");
    const resume = written(second).find((m) => m.method === "session/resume");
    expect(resume.params.sessionId).toBe("fake-session");
    expect(sseFrames(acc).at(-1).choices[0].finish_reason).toBe("stop");
    expect(acc).not.toContain('"error"');
  });
});
