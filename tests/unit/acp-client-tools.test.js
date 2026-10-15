import { describe, it, expect } from "vitest";
import {
  CLIENT_TOOLS_SERVER_NAME,
  buildClientToolsMcp,
  clientToolDeclarations,
  detectClientToolName,
  extractClientToolResults,
  fromMcpToolName,
  toMcpToolName,
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
    expect(JSON.parse(server.env.ACP_CLIENT_TOOLS)[0].name).toBe("ping");
    expect(server.env.ACP_CLIENT_TOOL_RESULTS).toBeUndefined();
  });

  it("seeds prior results, and only when there are any", () => {
    const seeded = buildClientToolsMcp([{ function: { name: "ping" } }], { ping: "pong" });
    expect(JSON.parse(seeded.env.ACP_CLIENT_TOOL_RESULTS)).toEqual({ ping: "pong" });
    const empty = buildClientToolsMcp([{ function: { name: "ping" } }], {});
    expect(empty.env.ACP_CLIENT_TOOL_RESULTS).toBeUndefined();
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