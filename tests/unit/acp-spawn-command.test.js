import { describe, it, expect, afterEach } from "vitest";
import { agentSpawnCommand } from "../../open-sse/executors/lib/acpCommon.js";

const realPlatform = process.platform;

function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("agentSpawnCommand", () => {
  it("spawns the binary directly on POSIX, never through a shell", () => {
    setPlatform("darwin");
    const res = agentSpawnCommand("/usr/local/bin/cursor-agent", ["acp"]);
    expect(res.shell).toBe(false);
    expect(res.cmd).toBe("/usr/local/bin/cursor-agent");
    expect(res.args).toEqual(["acp"]);
  });

  it("routes .exe directly on Windows without a shell", () => {
    setPlatform("win32");
    const bin = "C:\\Users\\me\\AppData\\Local\\Programs\\devin\\devin.exe";
    const res = agentSpawnCommand(bin, ["acp"]);
    expect(res.shell).toBe(false);
    expect(res.cmd).toBe(bin);
    expect(res.args).toEqual(["acp"]);
  });

  it("routes a .cmd shim through cmd.exe with the path quoted", () => {
    setPlatform("win32");
    const bin = "C:\\Program Files\\nodejs\\omp.cmd";
    const res = agentSpawnCommand(bin, ["acp", "--flag"]);
    expect(res.shell).toBe(false);
    expect(res.cmd.toLowerCase()).toContain("cmd.exe");
    expect(res.args[0]).toBe("/d");
    expect(res.args[1]).toBe("/s");
    expect(res.args[2]).toBe("/c");
    expect(res.args[3]).toBe(`"${bin}"`);
    expect(res.args.slice(4)).toEqual(["acp", "--flag"]);
  });

  it("uses ComSpec when it is set", () => {
    setPlatform("win32");
    const prior = process.env.ComSpec;
    process.env.ComSpec = "D:\\custom\\cmd.exe";
    try {
      const res = agentSpawnCommand("C:\\tools\\agent.bat", []);
      expect(res.cmd).toBe("D:\\custom\\cmd.exe");
    } finally {
      if (prior === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = prior;
    }
  });

  it("refuses to spawn through cmd.exe when a shim path embeds a quote", () => {
    setPlatform("win32");
    // Must both end in .cmd (to enter the cmd.exe branch) and contain a quote
    // (which would break out of the quoted path). A trailing quote cannot hit
    // this branch at all: the shim regex would not match and spawn stays
    // shell-free, which is why this case puts the quote mid-path.
    const injected = 'C:\\too"l\\agent.cmd';
    expect(() => agentSpawnCommand(injected, ["acp"])).toThrow(/contains a quote/);
  });

  it("keeps a trailing-quote path off the shell entirely", () => {
    setPlatform("win32");
    const notAShim = 'C:\\tools\\a.cmd" & calc.exe & "';
    const res = agentSpawnCommand(notAShim, ["acp"]);
    // Does not end in .cmd, so it never reaches cmd.exe — and cmd.exe is never
    // consulted, so the embedded metacharacters stay inert.
    expect(res.shell).toBe(false);
    expect(res.cmd).toBe(notAShim);
  });

  it("does not let shell metacharacters reach a shell on Windows", () => {
    setPlatform("win32");
    const res = agentSpawnCommand("C:\\tools\\safe.cmd", ["acp"]);
    // The whole command must stay inside argv, never in a shell string.
    expect(res.shell).toBe(false);
    expect(res.args.join(" ")).not.toMatch(/^\/c\s+[^"'"&|]/);
  });
});