// The permission policy must actually decide what we answer the agent.
//
// The fake agent reproduces the real exchange, captured from `opencode acp`:
// a `tool_call` notification carrying the true kind, then
// `session/request_permission` whose own `kind` is the useless constant
// "other". If classification regressed to reading the request, every decision
// below would come out "other" and the per-action rules would stop applying.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

const { OpenCodeAcpExecutor } = await import("open-sse/executors/opencode-acp.js");

/**
 * @param toolKind  the kind in the `tool_call` notification ("read", "edit", ...)
 * @param locations paths the agent declares
 */
function makeAgent({ toolKind = "edit", locations = [{ path: "/tmp/x.txt" }] } = {}) {
  const child = new EventEmitter();
  child.answers = [];
  child.writes = [];

  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.write = (data) => {
    const text = String(data);
    child.writes.push(text);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.result?.outcome) {
        child.answers.push(m.result.outcome);
        if (child._finish) child._finish();
      }
    }
    return true;
  };
  child.stdin.end = () => { child.stdin.destroyed = true; };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };

  const send = (o) => child.stdout.emit("data", Buffer.from(JSON.stringify(o) + "\n"));
  const update = (u) =>
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: u } });

  function handle(msg) {
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s", configOptions: [] } });
    } else if (msg.method === "session/set_config_option") {
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    } else if (msg.method === "session/prompt") {
      const toolCallId = "call_1";
      update({
        sessionUpdate: "tool_call",
        toolCallId,
        kind: toolKind,
        status: "pending",
        title: "write",
        locations,
      });
      // The real agent waits for the answer before it can finish. The answer
      // arrives synchronously inside the executor's write handler, so the
      // completion hook has to exist before the request is emitted.
      child._finish = () => {
        child._finish = null;
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      };
      send({
        jsonrpc: "2.0",
        id: "perm-1",
        method: "session/request_permission",
        params: {
          sessionId: "s",
          toolCall: {
            toolCallId,
            kind: "other", // the real request always says "other"
            status: "pending",
            locations,
            rawInput: { filepath: locations[0]?.path, content: "hello" },
          },
          options: [
            { optionId: "once", kind: "allow_once" },
            { optionId: "always", kind: "allow_always" },
            { optionId: "reject", kind: "reject_once" },
          ],
        },
      });
    }
  }

  const orig = child.stdin.write;
  child.stdin.write = (data) => {
    const r = orig(data);
    for (const line of String(data).split("\n")) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.method) handle(m);
    }
    return r;
  };
  return child;
}

async function run(child, opts = {}) {
  spawnMock.mockImplementation(() => child);
  const exec = new OpenCodeAcpExecutor();
  const { response } = await exec.execute({
    model: "space-bunny-free",
    body: { messages: [{ role: "user", content: "do it" }], ...(opts.body || {}) },
    credentials: opts.credentials,
    acpPermissions: opts.acpPermissions,
    log: { info() {}, debug() {}, warn() {} },
  });
  const reader = response.body.getReader();
  let acc = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
  }
  return acc;
}

const chosen = (child) => child.answers[0];

beforeEach(() => spawnMock.mockReset());

describe("ACP permission policy", () => {
  it("defaults to allowing for the session", async () => {
    const child = makeAgent();
    await run(child);
    expect(chosen(child)).toEqual({ outcome: "selected", optionId: "always" });
  });

  it("refuses execute when policy says deny", async () => {
    const child = makeAgent({ toolKind: "execute", locations: [] });
    await run(child, { acpPermissions: { execute: { inside: "deny", outside: "deny" } } });
    expect(chosen(child).optionId).toBe("reject");
  });

  it("refuses a write outside the working directory but allows it inside", async () => {
    const policy = { edit: { inside: "always", outside: "deny" } };

    const outside = makeAgent({ toolKind: "edit", locations: [{ path: "/etc/hosts" }] });
    await run(outside, { acpPermissions: policy });
    expect(chosen(outside).optionId).toBe("reject");

    const inside = makeAgent({ toolKind: "edit", locations: [{ path: process.cwd() + "/file.txt" }] });
    await run(inside, { acpPermissions: policy, body: { cwd: process.cwd() } });
    expect(chosen(inside).optionId).toBe("always");
  });

  it("answers 'once' when the policy asks for a single call", async () => {
    const child = makeAgent();
    await run(child, { acpPermissions: { edit: { inside: "once", outside: "once" } } });
    expect(chosen(child).optionId).toBe("once");
  });

  it("lets the request header override the stored policy", async () => {
    const child = makeAgent({ toolKind: "execute", locations: [] });
    await run(child, {
      acpPermissions: { execute: { inside: "always", outside: "always" } },
      credentials: { rawHeaders: { "x-9router-acp-permissions": "execute=deny" } },
    });
    expect(chosen(child).optionId).toBe("reject");
  });

  it("lets the request body override the stored policy", async () => {
    const child = makeAgent({ toolKind: "execute", locations: [] });
    await run(child, {
      acpPermissions: { execute: { inside: "always", outside: "always" } },
      body: { metadata: { acp_permissions: "execute=deny" } },
    });
    expect(chosen(child).optionId).toBe("reject");
  });

  it("always answers, so the turn still completes when the policy denies", async () => {
    const child = makeAgent({ toolKind: "delete", locations: [] });
    const acc = await run(child, { acpPermissions: { delete: { inside: "deny", outside: "deny" } } });
    // The agent marks the tool failed and finishes the turn normally — refusing
    // must not turn into the hang this handler exists to prevent.
    expect(acc).toContain("data: [DONE]");
  });
});