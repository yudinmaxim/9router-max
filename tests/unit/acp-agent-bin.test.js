// Regression: resolveAgentBin treated `extraDirs` entries as full binary paths.
//
// Every ACP executor passes directories (`~/.local/bin`, nvm's `bin`), and
// `fs.existsSync` happily accepts a directory — so the resolver returned
// `/Users/maxim/.local/bin` and spawn failed with a bare `EACCES` that reads
// like a permissions problem rather than a bad lookup.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { resolveAgentBin } = await import("open-sse/executors/lib/acpBase.js");

// Unique per run: never matches a real binary, so the hardcoded fallback
// candidates (/opt/homebrew/bin, /usr/local/bin, ...) cannot interfere.
const EXE = "definitely-not-installed-9router-test";

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bin-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveAgentBin", () => {
  it("appends the exe to a directory in extraDirs instead of returning the directory", () => {
    const dir = path.join(tmp, "bin");
    fs.mkdirSync(dir);
    const bin = path.join(dir, EXE);
    fs.writeFileSync(bin, "#!/bin/sh\n");

    const resolved = resolveAgentBin({
      envVar: "ACP_TEST_BIN_UNSET",
      exe: EXE,
      extraDirs: [dir],
    });

    expect(resolved).toBe(bin);
    expect(fs.statSync(resolved).isFile()).toBe(true);
  });

  it("accepts an explicit file in extraDirs as-is", () => {
    const bin = path.join(tmp, EXE);
    fs.writeFileSync(bin, "#!/bin/sh\n");

    const resolved = resolveAgentBin({
      envVar: "ACP_TEST_BIN_UNSET",
      exe: EXE,
      extraDirs: [bin],
    });

    expect(resolved).toBe(bin);
  });

  it("skips a directory that holds no such exe and falls through", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    const other = path.join(tmp, "other");
    fs.mkdirSync(other);
    const bin = path.join(other, EXE);
    fs.writeFileSync(bin, "#!/bin/sh\n");

    const resolved = resolveAgentBin({
      envVar: "ACP_TEST_BIN_UNSET",
      exe: EXE,
      extraDirs: [empty, other],
    });

    expect(resolved).toBe(bin);
  });

  it("prefers the env var over every path lookup", () => {
    const dir = path.join(tmp, "bin");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, EXE), "#!/bin/sh\n");
    const override = path.join(tmp, "custom-agent");

    process.env.ACP_TEST_BIN_OVERRIDE = override;
    try {
      const resolved = resolveAgentBin({
        envVar: "ACP_TEST_BIN_OVERRIDE",
        exe: EXE,
        extraDirs: [dir],
      });
      expect(resolved).toBe(override);
    } finally {
      delete process.env.ACP_TEST_BIN_OVERRIDE;
    }
  });

  it("falls back to the bare exe name so PATH can resolve it", () => {
    const resolved = resolveAgentBin({
      envVar: "ACP_TEST_BIN_UNSET",
      exe: EXE,
      extraDirs: [],
    });
    expect(resolved).toBe(EXE);
  });
});