import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLIENT_TOOLS_SERVER_NAME,
  buildClientToolsMcp,
  cleanupClientToolState,
  clientToolDeclarations,
  createClientToolState,
  detectClientToolName,
  extractClientToolResults,
  fromMcpToolName,
  hasToolArgs,
  toMcpToolName,
  unwrapClientToolArgs,
  writeClientToolResults,
} from "../../open-sse/executors/lib/acpClientTools.js";

describe("client tool declarations", () => {
  it("maps OpenAI function schemas to MCP declarations", () => {
    const out = clientToolDeclarations([
      { type: "function", function: { name: "read_file", description: "d", parameters: { type: "object" } } },
      { type: "function", function: { name: "no_params" } },
      null,
      { function: {} },
    ]);
    expect(out).toEqual([
      { name: "read_file", description: "d", inputSchema: { type: "object" } },
      { name: "no_params", description: "", inputSchema: { type: "object", properties: {} } },
    ]);
  });

  it("applies the prefix only when the agent forces one", () => {
    expect(toMcpToolName("read_file")).toBe("read_file");
    expect(toMcpToolName("read_file", "mcp_")).toBe("mcp_read_file");
    expect(toMcpToolName("mcp_read_file", "mcp_")).toBe("mcp_read_file");
    expect(fromMcpToolName("mcp_read_file", "mcp_")).toBe("read_file");
    expect(fromMcpToolName("read_file", "")).toBe("read_file");
  });
});

// ACP stdio servers carry env as an array of {name, value} — cursor validates
// the stdio variant of the mcpServers union and rejects an object env.
const envObj = (env) =>
  Object.fromEntries((env || []).map((e) => [e.name, e.value]));

describe("buildClientToolsMcp", () => {
  it("returns null when the caller sent no tools", () => {
    expect(buildClientToolsMcp([], {})).toBeNull();
    expect(buildClientToolsMcp(undefined, {})).toBeNull();
    expect(buildClientToolsMcp([{ function: {} }], {})).toBeNull();
  });

  it("returns an ACP stdio server entry carrying the tools", () => {
    const server = buildClientToolsMcp([{ function: { name: "ping" } }], {});
    expect(server.name).toBe(CLIENT_TOOLS_SERVER_NAME);
    expect(server.command).toBe(process.execPath);
    expect(server.args).toHaveLength(1);
    expect(JSON.parse(envObj(server.env).ACP_CLIENT_TOOLS)[0].name).toBe("ping");
    expect(envObj(server.env).ACP_CLIENT_TOOL_RESULTS).toBeUndefined();
  });

  it("seeds prior results, and only when there are any", () => {
    const seeded = buildClientToolsMcp([{ function: { name: "ping" } }], { ping: "pong" });
    expect(JSON.parse(envObj(seeded.env).ACP_CLIENT_TOOL_RESULTS)).toEqual({ ping: "pong" });
    const empty = buildClientToolsMcp([{ function: { name: "ping" } }], {});
    expect(envObj(empty.env).ACP_CLIENT_TOOL_RESULTS).toBeUndefined();
  });

  it("hands the results file to the bridge alongside the sink", () => {
    const server = buildClientToolsMcp([{ function: { name: "read_file" } }], { read_file: "x" }, {
      sink: "/tmp/state/calls.jsonl",
      resultsFile: "/tmp/state/results.json",
    });
    const env = envObj(server.env);
    expect(env.ACP_CLIENT_TOOL_RESULTS_FILE).toBe("/tmp/state/results.json");
    // The env map stays as the spawn-time snapshot for a freshly spawned
    // bridge — and for devin, which spawns per turn and never pools.
    expect(JSON.parse(env.ACP_CLIENT_TOOL_RESULTS)).toEqual({ read_file: "x" });
    const plain = buildClientToolsMcp([{ function: { name: "read_file" } }], {});
    expect(envObj(plain.env).ACP_CLIENT_TOOL_RESULTS_FILE).toBeUndefined();
  });
});

describe("per-session client tool state", () => {
  it("keeps sink and results file in one seeded directory, removable as a unit", () => {
    const state = createClientToolState({ read_file: "prior" });
    expect(fs.existsSync(state.dir)).toBe(true);
    expect(path.dirname(state.sink)).toBe(state.dir);
    expect(path.dirname(state.resultsFile)).toBe(state.dir);
    expect(JSON.parse(fs.readFileSync(state.resultsFile, "utf8"))).toEqual({ read_file: "prior" });
    cleanupClientToolState(state);
    expect(fs.existsSync(state.dir)).toBe(false);
    cleanupClientToolState(state); // idempotent — teardown may run twice
    cleanupClientToolState(null);
  });

  it("replaces results with every write, so a repeat call answers from the latest history", () => {
    const state = createClientToolState({ a: "one" });
    try {
      writeClientToolResults(state.resultsFile, { a: "two" });
      expect(JSON.parse(fs.readFileSync(state.resultsFile, "utf8"))).toEqual({ a: "two" });
      writeClientToolResults(state.resultsFile, {});
      expect(JSON.parse(fs.readFileSync(state.resultsFile, "utf8"))).toEqual({});
      writeClientToolResults("", {}); // no file — a no-op, never a throw
    } finally {
      cleanupClientToolState(state);
    }
  });
});

describe("unwrapClientToolArgs", () => {
  // codex-acp reports a bridged MCP call as its internal envelope
  // {server, tool, arguments}. Forwarded verbatim, the client hands the
  // wrapper to the real tool and its validator rejects it — verified live:
  // serena answered "1 validation error for applyArguments: substring_pattern
  // Field required [input_value={'server': 'clientTools', ...}]".
  const envelope = {
    server: "clientTools",
    tool: "serena_search_for_pattern",
    arguments: { substring_pattern: "Webinar|CourseSection", relative_path: "core/app" },
  };

  it("unwraps the codex-acp MCP envelope", () => {
    expect(unwrapClientToolArgs(envelope)).toEqual({
      substring_pattern: "Webinar|CourseSection",
      relative_path: "core/app",
    });
  });

  it("unwraps the JSON-string form and re-serializes it", () => {
    expect(JSON.parse(unwrapClientToolArgs(JSON.stringify(envelope)))).toEqual({
      substring_pattern: "Webinar|CourseSection",
      relative_path: "core/app",
    });
  });

  it("passes clean arguments through untouched", () => {
    const clean = { path: "/tmp/a.txt" };
    expect(unwrapClientToolArgs(clean)).toBe(clean);
    const cleanStr = '{"path":"/tmp/a.txt"}';
    expect(unwrapClientToolArgs(cleanStr)).toBe(cleanStr);
  });

  it("never unwraps a non-envelope", () => {
    // A tool whose own schema carries `server`/`tool` but no `arguments` object.
    const notEnvelope = { server: "s", tool: "t" };
    expect(unwrapClientToolArgs(notEnvelope)).toBe(notEnvelope);
    // `arguments` must be an object — an array is legitimate tool input.
    const arrayArgs = { server: "s", tool: "t", arguments: [1, 2] };
    expect(unwrapClientToolArgs(arrayArgs)).toBe(arrayArgs);
    expect(unwrapClientToolArgs("not json")).toBe("not json");
    expect(unwrapClientToolArgs(null)).toBe(null);
  });
});

describe("hasToolArgs", () => {
  // The fallback routing path must not surface a call from a placeholder
  // `rawInput`. Verified live with opencode-acp: the notification naming the
  // bridged tool carried `rawInput: {}`, the bare truthiness test accepted it,
  // and the client's own tool failed schema validation on the empty object
  // ("read … SchemaError Missing key ['filePath']"). The sink holds the real
  // arguments; the fallback has to wait for them.
  it("rejects the placeholder rawInput agents send before the arguments exist", () => {
    expect(hasToolArgs({})).toBe(false);
    expect(hasToolArgs(null)).toBe(false);
    expect(hasToolArgs(undefined)).toBe(false);
    expect(hasToolArgs("")).toBe(false);
    expect(hasToolArgs("  ")).toBe(false);
    expect(hasToolArgs("{}")).toBe(false);
    expect(hasToolArgs("null")).toBe(false);
    // An envelope whose inner arguments are still empty carries no input.
    expect(hasToolArgs({ server: "clientTools", tool: "read_file", arguments: {} })).toBe(false);
  });

  it("accepts real arguments, envelopes, arrays and non-JSON strings", () => {
    expect(hasToolArgs({ path: "/tmp/a.txt" })).toBe(true);
    expect(hasToolArgs({ server: "clientTools", tool: "read_file", arguments: { path: "/a" } })).toBe(true);
    expect(hasToolArgs('{"path":"/tmp/a.txt"}')).toBe(true);
    // An array is legitimate tool input, not a placeholder.
    expect(hasToolArgs([1, 2])).toBe(true);
    // A non-JSON string is real content — forward it rather than drop it.
    expect(hasToolArgs("just text")).toBe(true);
  });
});

describe("extractClientToolResults", () => {
  it("reads OpenAI tool_call / tool_result pairs", () => {
    const results = extractClientToolResults([
      { role: "user", content: "go" },
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "ping" } }] },
      { role: "tool", tool_call_id: "c1", content: "pong" },
    ]);
    expect(results).toEqual({ ping: "pong" });
  });

  it("reads Claude tool_use / tool_result blocks", () => {
    const results = extractClientToolResults([
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "ping" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "pong" }] },
    ]);
    expect(results).toEqual({ ping: "pong" });
  });

  it("keys by the prefixed name when the agent prefixes", () => {
    const results = extractClientToolResults(
      [
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "ping" } }] },
        { role: "tool", tool_call_id: "c1", content: "pong" },
      ],
      { prefix: "mcp_" }
    );
    expect(results).toEqual({ mcp_ping: "pong" });
  });

  it("drops a result whose call id was never announced", () => {
    expect(extractClientToolResults([{ role: "tool", tool_call_id: "orphan", content: "x" }])).toEqual({});
  });
});

describe("detectClientToolName", () => {
  const known = new Set(["mcp_ping"]);

  it("returns null when nothing was bridged", () => {
    expect(detectClientToolName({ title: "Calling mcp_ping from clientTools" }, new Set(), "mcp_")).toBeNull();
  });

  it("reads the name out of a devin-style title", () => {
    const name = detectClientToolName(
      { toolCallId: "c1", title: "Calling mcp_ping from clientTools" },
      known,
      "mcp_"
    );
    expect(name).toBe("ping");
  });

  it("prefers a structured tool name field", () => {
    const name = detectClientToolName({ toolCallId: "c1", toolName: "mcp_ping" }, known, "mcp_");
    expect(name).toBe("ping");
  });

  it("does not match a substring of a longer name", () => {
    expect(detectClientToolName({ title: "Calling mcp_pingpong from clientTools" }, known, "mcp_")).toBeNull();
  });

  it("ignores the agent's own tool notifications", () => {
    expect(detectClientToolName({ title: "Editing src/app.js" }, known, "mcp_")).toBeNull();
  });
});

describe("bridge script tools/call", () => {
  // The script is the one party that sees the real name and arguments, so what
  // it writes to the sink IS what the client will receive. codex-acp sends the
  // MCP envelope {server, tool, arguments} here — verified live — so the script
  // must record the unwrapped arguments.
  it("records unwrapped arguments in the sink and answers with the placeholder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bridge-script-test-"));
    const sink = path.join(dir, "calls.jsonl");
    const server = buildClientToolsMcp([{ function: { name: "read_file" } }], {}, { sink });
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...envObj(server.env) },
    });
    try {
      const replies = [];
      child.stdout.on("data", (d) => replies.push(String(d)));
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "read_file",
            arguments: { server: "clientTools", tool: "read_file", arguments: { path: "/tmp/x" } },
          },
        }) + "\n"
      );

      let raw = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          raw = fs.readFileSync(sink, "utf8");
        } catch {
          /* not created yet */
        }
        if (raw.trim()) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(raw.trim().split("\n").map((l) => JSON.parse(l))).toEqual([
        { name: "read_file", arguments: { path: "/tmp/x" } },
      ]);

      const parsed = replies.join("").trim().split("\n").map((l) => JSON.parse(l));
      const callReply = parsed.find((m) => m.id === 2);
      expect(callReply?.result?.content?.[0]?.text).toBe("(awaiting client tool_result)");
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bridge script results on a pooled process", () => {
  // The mechanism behind repeat MCP calls on a pooled session: the bridge
  // process outlives the turn that spawned it, its env is frozen forever, so
  // fresh results can only arrive through the file the executor rewrites —
  // and the script must re-read that file on EVERY call, not at spawn.
  it("answers from the file rewritten mid-life, and falls back to env when it is gone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bridge-results-test-"));
    const resultsFile = path.join(dir, "results.json");
    fs.writeFileSync(resultsFile, JSON.stringify({}));
    const server = buildClientToolsMcp([{ function: { name: "read_file" } }], { read_file: "env seed" }, {
      resultsFile,
    });
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...envObj(server.env) },
    });
    try {
      const replies = [];
      child.stdout.on("data", (d) => replies.push(String(d)));
      const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
      const call = (id) =>
        send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_file", arguments: {} } });
      // Replies must land strictly in order — each call is asserted before the
      // next mutation, or the file would be rewritten under an unread call.
      const waitFor = async (id) => {
        const deadline = Date.now() + 5000;
        for (;;) {
          const raw = replies.join("").trim();
          const parsed = raw ? raw.split("\n").map((l) => JSON.parse(l)) : [];
          const hit = parsed.find((m) => m.id === id);
          if (hit) return hit;
          if (Date.now() > deadline) throw new Error(`no reply for id ${id}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      const textOf = (reply) => reply?.result?.content?.[0]?.text;

      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      // Turn 1's file is empty and wins over the env seed — the file is the
      // per-turn source of truth, the env map only its spawn-time fallback.
      call(2);
      expect(textOf(await waitFor(2))).toBe("(awaiting client tool_result)");

      // Turn 2's result lands while the process is still alive.
      writeClientToolResults(resultsFile, { read_file: "file result" });
      call(3);
      expect(textOf(await waitFor(3))).toBe("file result");

      // Missing file (dir removed under a stale bridge): env snapshot, not a
      // crash and not a placeholder.
      fs.unlinkSync(resultsFile);
      call(4);
      expect(textOf(await waitFor(4))).toBe("env seed");
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});