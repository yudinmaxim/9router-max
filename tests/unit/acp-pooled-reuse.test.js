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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { spawnMock, toolStates } = vi.hoisted(() => ({ spawnMock: vi.fn(), toolStates: [] }));

vi.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

// The executor's only window into the state dir it hands the pool. The mock
// wraps (never replaces) — the bridge script and every other export stay real,
// the array just records what each turn created and when.
vi.mock("open-sse/executors/lib/acpClientTools.js", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    createClientToolState: (resultMap) => {
      const state = mod.createClientToolState(resultMap);
      toolStates.push(state);
      return state;
    },
  };
});

const { default: CursorAcpExecutor } = await import("open-sse/executors/cursor-acp.js");
const { clearAcpSessions } = await import("open-sse/executors/lib/acpSessionPool.js");
const { buildPromptText } = await import("open-sse/executors/lib/acpCommon.js");

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

// The pool keys on the dialogue, so a turn has to carry one. `x-session-id` is
// the generic header every client may send; the tests reuse one dialogue by
// default and override it where a second, independent dialogue is the subject.
const CREDENTIALS = { connectionId: "conn-1", rawHeaders: { "x-session-id": "conv-1" } };
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
  // A real spawned process always has a pid; the lifecycle trace keys its
  // stream-side lines on it, so the double needs one too.
  child.pid = 424242;
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
  toolStates.length = 0;
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

describe("pooled client-tool state", () => {
  // What this whole fix is about: the bridge process is spawned with the state
  // dir in its env and never re-reads that env — so on reuse the turn must
  // reuse the session's OWN sink/results file, not the per-request pair that
  // dies with the turn. Each test runs with `tools` so a bridge is registered.
  const TOOL = { function: { name: "read_file", description: "r", parameters: { type: "object", properties: {} } } };
  const toolsBody = (messages) => ({ body: { messages, tools: [TOOL] } });
  const firstTurnMessages = [{ role: "user", content: "hi" }];
  const historyWithResult = [
    ...firstTurnMessages,
    { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/a"}' } }] },
    { role: "tool", tool_call_id: "t1", content: "REAL RESULT" },
  ];

  it("keeps the session's state dir alive across turns and reseeds it from each turn's history", async () => {
    const child = makeFakeChild();
    const first = await runTurn(child, toolsBody(firstTurnMessages));
    expect(sseFrames(first).at(-1).choices[0].finish_reason).toBe("stop");
    expect(toolStates).toHaveLength(1);
    const session = toolStates[0];
    // finish() must not delete what the still-live bridge writes into.
    expect(fs.existsSync(session.dir)).toBe(true);

    // What the previous turn left in the sink must not resurface as a call.
    fs.appendFileSync(session.sink, JSON.stringify({ name: "read_file", arguments: { stale: true } }) + "\n");

    const second = await runTurn(child, toolsBody(historyWithResult));

    expect(spawnMock).toHaveBeenCalledTimes(1); // one child for both turns
    expect(toolStates).toHaveLength(2); // …each turn built its own pair
    // The turn-2 pair never reached the bridge (no session/new on reuse) and is
    // discarded; the swap moved the turn onto the session's surviving pair.
    expect(fs.existsSync(toolStates[1].dir)).toBe(false);
    expect(fs.existsSync(session.dir)).toBe(true);
    // The file the live bridge re-reads now carries THIS turn's results…
    expect(JSON.parse(fs.readFileSync(session.resultsFile, "utf8"))).toEqual({ read_file: "REAL RESULT" });
    // …and the stale sink was drained before the prompt went out.
    expect(fs.readFileSync(session.sink, "utf8")).toBe("");
    expect(sseFrames(second).at(-1).choices[0].finish_reason).toBe("stop");
    expect(second).not.toContain('"error"');
  });

  it("surfaces a bridged call recorded in the session's own sink during a reused turn", async () => {
    const child = makeFakeChild();
    await runTurn(child, toolsBody(firstTurnMessages));
    expect(toolStates).toHaveLength(1);
    const session = toolStates[0];

    // Stand-in for the live bridge: it records the call into the session's sink
    // while the prompt runs, and the prompt answer comes back late so the 50ms
    // sink poll is what ends the turn — exactly how a real tool call arrives.
    const orig = child.stdin.write;
    child.stdin.write = (data) => {
      const msg = JSON.parse(String(data).trim());
      if (msg.method === "session/prompt") {
        child.writes.push(String(data));
        fs.appendFileSync(session.sink, JSON.stringify({ name: "read_file", arguments: { path: "/tmp/x" } }) + "\n");
        setTimeout(() => {
          child.stdout.emit(
            "data",
            Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\n")
          );
        }, 200);
        return true;
      }
      return orig.call(child.stdin, data);
    };

    const second = await runTurn(child, toolsBody(firstTurnMessages));

    const frames = sseFrames(second);
    expect(frames.at(-1).choices[0].finish_reason).toBe("tool_calls");
    const call = frames.find((f) => f.choices[0].delta.tool_calls)?.choices[0].delta.tool_calls?.[0];
    expect(call?.function?.name).toBe("read_file");
    expect(JSON.parse(call.function.arguments)).toEqual({ path: "/tmp/x" });
    // The turn ended on a tool call — still a live pooled session, dir intact.
    expect(fs.existsSync(session.dir)).toBe(true);
  });

  it("disposes the replaced entry's state when a dead child forces a resume", async () => {
    const first = makeFakeChild();
    await runTurn(first, toolsBody(firstTurnMessages));
    first.exitCode = 1;

    const second = makeFakeChild();
    const acc = await runTurn(second, toolsBody(firstTurnMessages));

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(toolStates).toHaveLength(2);
    // Re-pooling under the same key replaced the entry — the old entry's hook
    // removed its dir; the resumed session's own state stays until disposal.
    expect(fs.existsSync(toolStates[0].dir)).toBe(false);
    expect(fs.existsSync(toolStates[1].dir)).toBe(true);
    expect(acc).not.toContain('"error"');
  });
});

describe("lifecycle trace identity", () => {
  // `start(controller)` runs with the ReadableStream's internal object as
  // `this`, not the executor — so `this.providerId` inside it is undefined and
  // every trace line lost the agent it described. Exactly the field an operator
  // greps for when four pooled children are interleaved in one log.
  it("stamps the provider id on every trace line written from inside start()", async () => {
    const traceFile = fs.mkdtempSync(fs.realpathSync(os.tmpdir()) + "/acp-trace-") + "/trace.ndjson";
    process.env.ACP_DEBUG_LOG = traceFile;
    try {
      const child = makeFakeChild();
      await runTurn(child);

      const lines = fs
        .readFileSync(traceFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l.slice(l.indexOf("{"))));

      // spawn + rpc-send(s) + pooled + finish … — a real turn always traces.
      // Lines carrying a pid are the ones written from inside start(); the
      // pre-fix `this.providerId` was undefined there, and JSON.stringify
      // drops undefined values — so asserting the exact id is what pins the
      // closure capture, not just the presence of a key.
      const fromStream = lines.filter((l) => l.pid !== undefined);
      expect(fromStream.length).toBeGreaterThan(0);
      for (const line of fromStream) expect(line.provider).toBe("cursor-acp");
    } finally {
      delete process.env.ACP_DEBUG_LOG;
      fs.rmSync(path.dirname(traceFile), { recursive: true, force: true });
    }
  });

  // Two dialogues open in the same IDE window (same connection, cwd, model)
  // must NOT share a child.  The conversation key extracted from the client's
  // x-session-id header separates them.
  it("keeps two independent dialogues on separate children", async () => {
    const child1 = makeFakeChild();
    await runTurn(child1, {
      credentials: { connectionId: "conn-1", rawHeaders: { "x-session-id": "conv-a" } },
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const child2 = makeFakeChild();
    const acc2 = await runTurn(child2, {
      credentials: { connectionId: "conn-1", rawHeaders: { "x-session-id": "conv-b" } },
    });
    // A second child must have been spawned — different conversation.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(sseFrames(acc2).at(-1).choices[0].finish_reason).toBe("stop");
  });

  // One dialogue hopping between models must keep ONE child.  The model is
  // re-pinned via `session/set_config_option` on reuse, not a new spawn.
  it("reuses the same child and re-pins the model when the dialogue switches models", async () => {
    const child = makeFakeChild();
    await runTurn(child);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const beforeSecondTurn = child.writes.length;
    const acc2 = await runTurn(child, {
      model: "composer-2.5",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // No re-handshake — the session is alive. Only the model pin moves it onto
    // the newly requested model, which is what keeps the agent-side context.
    const secondMethods = child.writes
      .slice(beforeSecondTurn)
      .map((w) => JSON.parse(w.trim()))
      .map((m) => m.method);
    expect(secondMethods).toEqual(["session/set_config_option", "session/prompt"]);
    const pin = JSON.parse(child.writes[beforeSecondTurn].trim());
    expect(pin.params).toEqual({ sessionId: "fake-session", configId: "model", value: "composer-2.5[fast=true]" });
    expect(sseFrames(acc2).at(-1).choices[0].finish_reason).toBe("stop");
  });

  // Without a conversation key the pool is skipped — a fresh child every time.
  it("spawns fresh when no conversation identity is present", async () => {
    const child1 = makeFakeChild();
    await runTurn(child1, {
      credentials: { connectionId: "conn-1" }, // no rawHeaders → no conversation
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const child2 = makeFakeChild();
    const acc2 = await runTurn(child2, {
      credentials: { connectionId: "conn-1" },
    });
    // No conversation identity means no pooling — a new child every turn.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(sseFrames(acc2).at(-1).choices[0].finish_reason).toBe("stop");
  });
});

describe("buildPromptText with tool definitions", () => {
  it("prepends tool definitions so the model knows required fields", () => {
    const tools = [
      {
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Absolute path" },
            },
            required: ["filePath"],
          },
        },
      },
    ];
    const prompt = buildPromptText([{ role: "user", content: "hi" }], tools);
    expect(prompt).toContain("Tool definitions");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("Required fields: filePath");
  });

  it("includes tool definitions before the conversation", () => {
    const tools = [
      { function: { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    ];
    const prompt = buildPromptText(
      [{ role: "assistant", content: "ok" }],
      tools
    );
    const defIdx = prompt.indexOf("Tool definitions");
    const asstIdx = prompt.indexOf("[Assistant]");
    expect(defIdx).toBeGreaterThan(-1);
    expect(asstIdx).toBeGreaterThan(-1);
    expect(defIdx).toBeLessThan(asstIdx);
  });
});
