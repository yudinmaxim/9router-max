// Regression: `opencode acp` blocks the whole turn on session/request_permission.
//
// Verified against the real CLI: with a prompt that touches a tool, the agent
// emits tool_call pending → tool_call_update in_progress → session/request_permission
// (a *request*, carrying an id) → and then waits forever. It does not matter
// whether the client advertised any capabilities; the request arrives anyway.
//
// The bug this pins: acpBase logged `session/request_permission` as an
// unanswered client request and `continue`d past it, so the turn never
// returned and the client saw a hang with no error.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

const { OpenCodeAcpExecutor } = await import("open-sse/executors/opencode-acp.js");

/**
 * Fake agent that behaves like the real one: it asks for permission, then
 * refuses to finish the prompt until the client answers. Mirrors the real
 * exchange — options carry `kind` and `optionId`, and the agent expects
 * `{ outcome: { outcome: "selected", optionId } }`.
 */
function makePermissionGatedChild({ options } = {}) {
  const opts =
    options || [
      { optionId: "cancel", name: "Reject", kind: "reject_once" },
      { optionId: "allow", name: "Allow", kind: "allow_always" },
    ];

  const child = new EventEmitter();
  child.writes = [];
  child.permissionAnswers = [];
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.write = (data) => {
    const text = String(data);
    child.writes.push(text);
    // Record permission answers (allow or cancel) and release the deferred
    // prompt completion.
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.result?.outcome?.outcome) {
        child.permissionAnswers.push(m.result.outcome.optionId ?? m.result.outcome.outcome);
        if (child._resumePrompt) child._resumePrompt();
      }
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
          agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
        },
      });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session", configOptions: [] } });
    } else if (msg.method === "session/set_config_option") {
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    } else if (msg.method === "session/prompt") {
      notify("tool_call", { kind: "edit", status: "pending", toolCallId: "call_1", title: "write" });
      notify("tool_call_update", { kind: "edit", status: "in_progress", toolCallId: "call_1", title: "write" });

      // Ask for permission. The prompt does NOT complete until answered — this
      // is the hang. If the client never replies, neither does `send(... stopReason)`.
      send({
        jsonrpc: "2.0",
        id: "perm-7",
        method: "session/request_permission",
        params: { sessionId: "fake-session", toolCall: { toolCallId: "call_1" }, options: opts },
      });

      // Resume only after the client answered (allow OR cancel). Left
      // unanswered, a real agent blocks here forever — that is the bug.
      const tick = () => {
        if (child.permissionAnswers.length) {
          notify("agent_message_chunk", { content: { type: "text", text: "file written" } });
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          return;
        }
        const t = setInterval(() => {
          if (child.permissionAnswers.length) {
            clearInterval(t);
            notify("agent_message_chunk", { content: { type: "text", text: "file written" } });
            send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          }
        }, 5);
      };
      tick();
    }
  }

  // Bridge the executor's writes into the fake protocol handler.
  const origWrite = child.stdin.write;
  child.stdin.write = (data) => {
    const r = origWrite(data);
    for (const line of String(data).split("\n")) {
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method) handle(m);
    }
    return r;
  };

  return child;
}

async function runWith(child, { onStdinWrite } = {}) {
  spawnMock.mockImplementation((bin, args, spawnOpts) => {
    child.bin = bin;
    child.args = args;
    child.opts = spawnOpts;
    return child;
  });
  const exec = new OpenCodeAcpExecutor();
  const { response } = await exec.execute({
    model: "space-bunny-free",
    body: { messages: [{ role: "user", content: "write the file" }] },
    credentials: {},
    log: { info() {}, debug() {} },
  });
  const reader = response.body.getReader();
  let acc = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
  }
  if (onStdinWrite) onStdinWrite(child);
  return { acc, child };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("ACP permission requests (headless approval)", () => {
  it("answers session/request_permission with the allow option and lets the turn finish", async () => {
    const child = makePermissionGatedChild();
    const { acc } = await runWith(child);

    // The client must have picked the allow-ish option, not the first one.
    expect(child.permissionAnswers).toEqual(["allow"]);

    // And crucially the prompt completed — no hang.
    expect(acc).toContain("file written");
    expect(acc).toContain("data: [DONE]");
  });

  it("does not leave the permission request unanswered", async () => {
    const child = makePermissionGatedChild();
    await runWith(child);
    // The raw request id the agent sent must appear in our writes, answered.
    const answered = child.writes.some((w) => w.includes('"id":"perm-7"') && w.includes("selected"));
    expect(answered).toBe(true);
  });

  it("falls back to the first option when none look like an allow", async () => {
    const child = makePermissionGatedChild({
      options: [{ optionId: "only", name: "Only", kind: "something_else" }],
    });
    await runWith(child);
    expect(child.permissionAnswers).toEqual(["only"]);
  });

  it("cancels rather than stalling when the agent offers no options", async () => {
    const child = makePermissionGatedChild({ options: [] });
    const { acc } = await runWith(child);
    // Nothing grantable, but the turn must still terminate: an unanswered
    // request is what caused the hang.
    expect(child.permissionAnswers).toEqual(["cancelled"]);
    expect(acc).toContain("data: [DONE]");
  });
});