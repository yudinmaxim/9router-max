// The in-container half of hostrunner: it must write queue files, never run
// commands, and tolerate the argument envelope codex-acp sends over MCP.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeToolName,
  unwrapToolArgs,
  buildRequest,
  handleRpc,
  submitRequest,
  jobStatus,
  tailLog,
} from "../../host-runner/plugin.mjs";

let root;
let env;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "9r-hostrunner-"));
  fs.mkdirSync(path.join(root, "in"), { recursive: true });
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  env = {
    ...process.env,
    HOST_RUNNER_IN_DIR: path.join(root, "in"),
    HOST_RUNNER_OUT_DIR: path.join(root, "out"),
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("hostrunner MCP protocol", () => {
  it("normalizes agent tool-name prefixes", () => {
    expect(normalizeToolName("hostrunner_run")).toBe("hostrunner_run");
    expect(normalizeToolName("run")).toBe("hostrunner_run");
    expect(normalizeToolName("mcp__hostrunner__status")).toBe("hostrunner_status");
    expect(normalizeToolName("mcp9r__hostrunner__tail")).toBe("hostrunner_tail");
    expect(normalizeToolName("nope")).toBeNull();
  });

  it("unwraps the codex-acp argument envelope", () => {
    expect(
      unwrapToolArgs({
        server: "hostrunner",
        tool: "run",
        arguments: { tool: "php_lint", cwd: "/tmp" },
      })
    ).toEqual({ tool: "php_lint", cwd: "/tmp" });
    expect(unwrapToolArgs({ tool: "php_lint", cwd: "/tmp" })).toEqual({
      tool: "php_lint",
      cwd: "/tmp",
    });
  });

  it("answers initialize and tools/list without touching the queue", async () => {
    const init = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { env });
    expect(init.result.serverInfo.name).toBe("hostrunner");
    expect(init.result.capabilities.tools).toBeDefined();

    const list = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { env });
    expect(list.result.tools.map((t) => t.name)).toEqual([
      "hostrunner_run",
      "hostrunner_status",
      "hostrunner_cancel",
      "hostrunner_tail",
    ]);
    expect(fs.readdirSync(path.join(root, "in"))).toEqual([]);
  });

  it("does not answer notifications", async () => {
    expect(
      await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { env })
    ).toBeNull();
  });

  it("builds a validated queue request", () => {
    const { request, waitMs } = buildRequest(
      { tool: "php_lint", cwd: root, args: ["artisan"], waitMs: 0, requester: "test" },
      env
    );
    expect(request.tool).toBe("php_lint");
    expect(request.cwd).toBe(root);
    expect(request.args).toEqual(["artisan"]);
    expect(request.timeoutMs).toBeGreaterThanOrEqual(1000);
    expect(waitMs).toBe(0);
    expect(() => buildRequest({ tool: "php_lint", cwd: "relative/path" }, env)).toThrow(
      /absolute path/
    );
  });

  it("writes a request file and returns a job id when waitMs is 0", async () => {
    const result = await submitRequest(
      { tool: "php_lint", cwd: root, args: ["artisan"], waitMs: 0 },
      { env, pollMs: 5 }
    );
    expect(result.status).toBe("queued");
    expect(result.id).toMatch(/^hr_/);
    const files = fs.readdirSync(path.join(root, "in")).filter((f) => f.endsWith(".request.json"));
    expect(files).toEqual([`${result.id}.request.json`]);
    const queued = JSON.parse(fs.readFileSync(path.join(root, "in", files[0]), "utf8"));
    expect(queued.tool).toBe("php_lint");
    expect(queued.submittedAt).toBeTruthy();
  });

  it("reads a tool call wrapped by codex-acp and returns the job result", async () => {
    const response = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "mcp__hostrunner__run",
          arguments: {
            server: "hostrunner",
            tool: "run",
            arguments: { tool: "php_lint", cwd: root, args: ["artisan"], waitMs: 0 },
          },
        },
      },
      { env, pollMs: 5 }
    );
    expect(response.id).toBe(42);
    expect(response.result.isError).toBe(false);
    const payload = JSON.parse(response.result.content[0].text);
    expect(payload.status).toBe("queued");
  });

  it("reports status and tails a published log", async () => {
    const id = "hr_test_status";
    fs.writeFileSync(
      path.join(root, "out", `${id}.json`),
      JSON.stringify({ id, status: "failed", exitCode: 1, stderrTail: "boom" })
    );
    fs.writeFileSync(path.join(root, "out", `${id}.log`), "line one\nline two\nline three\n");

    expect((await jobStatus(id, { env })).status).toBe("failed");
    const tail = await tailLog(id, { env, lines: 2 });
    expect(tail.log).toBe("line two\nline three\n");
  });

  it("prefers the live state marker over the claim dir while a job runs", async () => {
    const id = "hr_test_running";
    fs.mkdirSync(path.join(root, "in", ".processing"), { recursive: true });
    // The daemon renames the claim keeping its `.request.json` name — the old
    // status probe looked for `<id>.json` and answered "unknown" here.
    fs.writeFileSync(
      path.join(root, "in", ".processing", `${id}.request.json`),
      JSON.stringify({ id, tool: "php_test" })
    );
    fs.writeFileSync(
      path.join(root, "out", `${id}.state.json`),
      JSON.stringify({ id, status: "running", tool: "php_test", startedAt: "2026-11-24T00:00:00Z" })
    );
    fs.writeFileSync(path.join(root, "out", `${id}.log`), "started\n");

    const status = await jobStatus(id, { env });
    expect(status.status).toBe("running");
    expect(status.tool).toBe("php_test");
    expect(status.logAvailable).toBe(true);

    // Without the state file the claim dir still answers "running".
    fs.rmSync(path.join(root, "out", `${id}.state.json`));
    expect((await jobStatus(id, { env })).status).toBe("running");
  });

  it("reports a job sitting in in/ as queued, never unknown", async () => {
    const id = "hr_test_queued";
    fs.writeFileSync(
      path.join(root, "in", `${id}.request.json`),
      JSON.stringify({ id, tool: "php_test" })
    );
    const status = await jobStatus(id, { env });
    expect(status.status).toBe("queued");
    expect(status.logAvailable).toBe(false);
  });

  it("explains a missing log through the live state", async () => {
    const id = "hr_test_nolog";
    fs.writeFileSync(
      path.join(root, "out", `${id}.state.json`),
      JSON.stringify({ id, status: "running" })
    );
    const tail = await tailLog(id, { env });
    expect(tail.log).toBe("");
    expect(tail.note).toMatch(/running/);
  });

  it("rejects unknown tools as an MCP error", async () => {
    const response = await handleRpc(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "rm_rf", arguments: {} } },
      { env }
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toMatch(/unknown tool/);
  });
});
