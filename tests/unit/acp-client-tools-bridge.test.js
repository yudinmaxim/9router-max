// The client-tool bridge inside the shared ACP executor.
//
// `acpClientTools.test.js` covers the pure functions. This covers the wiring
// that actually decides whether a client tool works:
//
//   1. `body.tools` are registered in `session/new` as a stdio MCP server.
//      Agents ignore OpenAI function schemas in the body — verified live — so
//      this registration is the only path by which a client tool can reach the
//      agent at all. Sending `[]` unconditionally is the old behaviour and
//      silently drops every client tool.
//   2. When the agent calls a bridged tool, the turn ends with an OpenAI
//      `tool_calls` finish instead of running the call to completion and
//      answering with prose.
//   3. The agent's own tools stay inside the agent. A notification naming a
//      tool we never declared must not produce a client-side tool_call, or the
//      client would re-run a sandboxed read on its own.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import fs from "node:fs";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

const { OpenCodeAcpExecutor } = await import("open-sse/executors/opencode-acp.js");

const PERM_OPTS = [
  { optionId: "cancel", name: "Reject", kind: "reject_once" },
  { optionId: "allow", name: "Allow", kind: "allow_always" },
];

const READ_FILE = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file from disk",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

/**
 * Fake opencode ACP subprocess. Answers everything the executor sends, and
 * replays a scripted list of raw `session/update` payloads on `session/prompt`
 * so a test can reproduce the exact event order a real agent produces.
 */
function makeFakeChild({ updates = [], stopReason = "end_turn" } = {}) {
  const child = new EventEmitter();
  child.writes = [];
  child.permissionAnswers = [];
  child.sessionNewParams = null;
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
  const notify = (update) =>
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "fake-session", update },
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
            promptCapabilities: { image: false },
          },
        },
      });
    } else if (msg.method === "session/new") {
      child.sessionNewParams = msg.params;
      if (!Array.isArray(msg.params?.mcpServers)) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid params", data: [{ path: ["mcpServers"], message: "expected array" }] },
        });
        return;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session", configOptions: [] } });
    } else if (msg.method === "session/set_config_option") {
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    } else if (msg.method === "session/prompt") {
      for (const u of updates) notify(u);
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason } });
    }
  }

  return child;
}

async function runExecute({ updates, stopReason, body } = {}) {
  const child = makeFakeChild({ updates, stopReason });
  spawnMock.mockImplementation(() => child);
  const exec = new OpenCodeAcpExecutor();
  const { response } = await exec.execute({
    model: "space-bunny-free",
    body: { messages: [{ role: "user", content: "read the file" }], ...body },
    credentials: {},
    log: { info() {}, debug() {} },
  });
  const reader = response.body.getReader();
  let acc = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
  }
  return { acc, child };
}

const frames = (acc) =>
  acc
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice(6)));

const bridgeOf = (child) => {
  const servers = child.sessionNewParams?.mcpServers || [];
  return servers.find((s) => s?.name === "clientTools") || null;
};

const toolCallFrames = (acc) =>
  frames(acc)
    .map((f) => f.choices?.[0]?.delta?.tool_calls)
    .filter(Array.isArray)
    .flat()
    .map((tc) => tc.function);

beforeEach(() => {
  spawnMock.mockReset();
});

describe("ACP client-tool bridge: registration", () => {
  it("registers nothing when the caller sent no tools", async () => {
    const { child } = await runExecute();
    expect(child.sessionNewParams.mcpServers).toEqual([]);
  });

  it("registers body.tools as a stdio MCP server in session/new", async () => {
    const { child } = await runExecute({ body: { tools: [READ_FILE] } });
    const bridge = bridgeOf(child);
    expect(bridge).toBeTruthy();
    expect(bridge.command).toBe(process.execPath);
    expect(Array.isArray(bridge.args) && bridge.args.length).toBe(1);
    // The script must exist by the time the agent is told to spawn it.
    expect(fs.existsSync(bridge.args[0])).toBe(true);
    expect(bridge.env.ACP_CLIENT_TOOLS).toBeTruthy();
  });

  it("declares the client's tools with MCP names, not OpenAI names", async () => {
    const { child } = await runExecute({ body: { tools: [READ_FILE] } });
    const declared = JSON.parse(bridgeOf(child).env.ACP_CLIENT_TOOLS);
    expect(declared).toHaveLength(1);
    expect(declared[0].name).toBe("read_file");
    expect(declared[0].description).toBe("Read a file from disk");
    expect(declared[0].inputSchema.properties.path.type).toBe("string");
  });

  it("seeds prior tool results so a repeat call gets real data", async () => {
    const { child } = await runExecute({
      body: {
        tools: [READ_FILE],
        messages: [
          { role: "user", content: "read the file" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "hello from disk" },
        ],
      },
    });
    const bridge = bridgeOf(child);
    expect(JSON.parse(bridge.env.ACP_CLIENT_TOOL_RESULTS)).toEqual({ read_file: "hello from disk" });
  });
});

describe("ACP client-tool bridge: call routing", () => {
  // A real agent announces the call first (name in the title), asks permission,
  // then reports the arguments in a follow-up update.
  const announceAndRun = [
    { sessionUpdate: "tool_call", toolCallId: "call_1", kind: "read", status: "pending", title: "Calling read_file from clientTools" },
    { sessionUpdate: "tool_call_update", toolCallId: "call_1", kind: "read", status: "in_progress", title: "Calling read_file from clientTools", rawInput: { path: "/tmp/a.txt" } },
  ];

  it("turns a bridged call into an OpenAI tool_call and ends the turn", async () => {
    const { acc } = await runExecute({
      updates: announceAndRun,
      body: { tools: [READ_FILE] },
    });
    const calls = toolCallFrames(acc);
    expect(calls).toHaveLength(1);
    // Reported under the name the caller declared, not the MCP-wrapped one.
    expect(calls[0].name).toBe("read_file");
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: "/tmp/a.txt" });
    const last = frames(acc).at(-1);
    expect(last.choices[0].finish_reason).toBe("tool_calls");
  });

  it("joins the announcement and the arguments when they arrive separately", async () => {
    const { acc } = await runExecute({
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "call_1", status: "pending", title: "Calling read_file from clientTools" },
        { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress", rawInput: { path: "/tmp/b.txt" } },
      ],
      body: { tools: [READ_FILE] },
    });
    const calls = toolCallFrames(acc);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: "/tmp/b.txt" });
  });

  it("leaves the agent's own tools inside the agent", async () => {
    // The agent reads a file with its own Read tool. Forwarding this would make
    // the client re-run a sandboxed read and answer a request it was never asked.
    const { acc } = await runExecute({
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "call_9", kind: "read", status: "pending", title: "Read /tmp/secret" },
        { sessionUpdate: "tool_call_update", toolCallId: "call_9", status: "completed", rawInput: { path: "/tmp/secret" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
      ],
      body: { tools: [READ_FILE] },
    });
    expect(toolCallFrames(acc)).toEqual([]);
    expect(acc).toContain("done");
  });

  it("does not forward a bridged call the agent abandoned", async () => {
    // Permission denied upstream: the agent gives up. Handing the client a
    // tool_call it will never use just strands the conversation.
    const { acc } = await runExecute({
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "call_1", status: "pending", title: "Calling read_file from clientTools" },
        { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "failed", rawInput: { path: "/tmp/a.txt" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cannot read that" } },
      ],
      body: { tools: [READ_FILE] },
    });
    expect(toolCallFrames(acc)).toEqual([]);
    expect(acc).toContain("cannot read that");
  });

  it("still completes normally when the caller sent an unusable tool entry", async () => {
    const { acc, child } = await runExecute({
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }],
      body: { tools: [{ type: "function" }, null, { type: "function", function: {} }] },
    });
    expect(child.sessionNewParams.mcpServers).toEqual([]);
    expect(frames(acc).at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("registers one server no matter how many tools the caller sent", async () => {
    const { child } = await runExecute({
      body: { tools: [READ_FILE, { type: "function", function: { name: "list_dir", parameters: { type: "object" } } }] },
    });
    const bridge = bridgeOf(child);
    expect(child.sessionNewParams.mcpServers).toHaveLength(1);
    expect(JSON.parse(bridge.env.ACP_CLIENT_TOOLS).map((t) => t.name)).toEqual(["read_file", "list_dir"]);
  });

  it("keeps the session cwd independent of the bridge", async () => {
    const { child } = await runExecute({ body: { tools: [READ_FILE] } });
    expect(child.sessionNewParams.cwd).toBe(os.tmpdir());
  });
});