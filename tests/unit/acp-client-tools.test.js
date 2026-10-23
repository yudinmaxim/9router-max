import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLIENT_TOOLS_SERVER_NAME,
  buildClientToolsMcp,
  clientToolDeclarations,
  detectClientToolName,
  extractClientToolResults,
  fromMcpToolName,
  toMcpToolName,
  unwrapClientToolArgs,
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