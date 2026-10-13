import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  classifyAction,
  rememberToolKind,
  targetPaths,
  insideWorkspace,
  normalizePolicy,
  parsePolicyInput,
  mergePolicies,
  decidePermission,
  chooseOption,
} = await import("open-sse/executors/lib/acpPermissions.js");
const { DEFAULT_ACP_PERMISSIONS, ACP_PERMISSION_ACTIONS } = await import("open-sse/config/runtimeConfig.js");

let tmp;
let workdir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-perm-"));
  workdir = path.join(tmp, "project");
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, "a.txt"), "x");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The permission request reports kind "other" for both reads and writes —
// these payloads are the real shapes captured from `opencode acp`.
const READ_REQUEST = {
  toolCallId: "call_1",
  kind: "other",
  locations: [{ path: "/etc/hosts" }, { path: "/etc" }],
  rawInput: { filepath: "/etc/hosts", parentDir: "/etc" },
};
const WRITE_REQUEST = {
  toolCallId: "call_2",
  kind: "other",
  locations: [{ path: "/tmp/out.txt" }, { path: "/tmp" }],
  rawInput: { filepath: "/tmp/out.txt", content: "hello" },
};

describe("classifyAction", () => {
  it("uses the kind from the tool_call notification, not the request's 'other'", () => {
    const seen = new Map();
    rememberToolKind(seen, { toolCallId: "call_2", kind: "edit" });
    expect(classifyAction(WRITE_REQUEST, seen)).toBe("edit");
  });

  it("does not let a later 'other' overwrite a known kind", () => {
    const seen = new Map();
    rememberToolKind(seen, { toolCallId: "call_1", kind: "read" });
    rememberToolKind(seen, { toolCallId: "call_1", kind: "other" });
    expect(classifyAction(READ_REQUEST, seen)).toBe("read");
  });

  it("falls back to rawInput: content means a write", () => {
    expect(classifyAction(WRITE_REQUEST, new Map())).toBe("edit");
  });

  it("treats an unclassifiable call as 'other', not as a harmless read", () => {
    expect(classifyAction({ toolCallId: "x", kind: "other" }, new Map())).toBe("other");
    expect(classifyAction({}, new Map())).toBe("other");
  });
});

describe("targetPaths", () => {
  it("collects declared locations and rawInput aliases without duplicates", () => {
    expect(targetPaths(WRITE_REQUEST)).toEqual(["/tmp/out.txt", "/tmp"]);
  });

  it("returns an empty list for a call with no paths", () => {
    expect(targetPaths({ toolCallId: "x" })).toEqual([]);
  });
});

describe("insideWorkspace", () => {
  it("accepts a path inside the working directory", () => {
    expect(insideWorkspace([path.join(workdir, "a.txt")], workdir)).toBe(true);
  });

  it("accepts a path that does not exist yet inside the directory", () => {
    expect(insideWorkspace([path.join(workdir, "new.txt")], workdir)).toBe(true);
  });

  it("rejects a path outside", () => {
    expect(insideWorkspace(["/etc/hosts"], workdir)).toBe(false);
  });

  it("resolves '..' so a traversal cannot pass as inside", () => {
    expect(insideWorkspace([path.join(workdir, "..", "..", "etc", "passwd")], workdir)).toBe(false);
  });

  it("follows a symlink that escapes the directory", () => {
    const outside = path.join(tmp, "outside.txt");
    fs.writeFileSync(outside, "secret");
    const link = path.join(workdir, "link.txt");
    fs.symlinkSync(outside, link);
    expect(insideWorkspace([link], workdir)).toBe(false);
  });

  it("requires every path to be inside, not just one", () => {
    expect(insideWorkspace([path.join(workdir, "a.txt"), "/etc/hosts"], workdir)).toBe(false);
  });

  it("is false when there is no working directory or no paths", () => {
    expect(insideWorkspace([], workdir)).toBe(false);
    expect(insideWorkspace([path.join(workdir, "a.txt")], undefined)).toBe(false);
  });
});

describe("normalizePolicy", () => {
  it("keeps only known actions and values", () => {
    expect(normalizePolicy({ execute: { inside: "deny", outside: "once" } })).toEqual({
      execute: { inside: "deny", outside: "once" },
    });
  });

  it("drops unknown values rather than treating them as permissive", () => {
    const out = normalizePolicy({ execute: { inside: "definitely-not-a-value" } });
    expect(out.execute).toBeUndefined();
  });

  it("drops unknown actions", () => {
    expect(normalizePolicy({ rmDashRf: { inside: "deny" } })).toEqual({});
  });

  it("keeps a single scope without inventing the other", () => {
    expect(normalizePolicy({ read: { outside: "deny" } })).toEqual({ read: { outside: "deny" } });
  });
});

describe("parsePolicyInput", () => {
  it("parses the compact header syntax", () => {
    expect(parsePolicyInput("execute=deny,read=once")).toEqual({
      execute: { inside: "deny", outside: "deny" },
      read: { inside: "once", outside: "once" },
    });
  });

  it("treats a bare action as allow-once", () => {
    expect(parsePolicyInput("read")).toEqual({ read: { inside: "once", outside: "once" } });
  });

  it("ignores unknown actions and values", () => {
    expect(parsePolicyInput("nonsense=deny,read=maybe")).toBeNull();
  });

  it("is null for empty input", () => {
    expect(parsePolicyInput("")).toBeNull();
    expect(parsePolicyInput(undefined)).toBeNull();
  });
});

describe("mergePolicies", () => {
  it("defaults every action to always", () => {
    const merged = mergePolicies();
    for (const a of ACP_PERMISSION_ACTIONS) expect(merged[a]).toEqual({ inside: "always", outside: "always" });
  });

  it("applies layers in order, later winning", () => {
    const merged = mergePolicies(
      { execute: { inside: "deny" } },
      { execute: { inside: "once", outside: "deny" } }
    );
    expect(merged.execute).toEqual({ inside: "once", outside: "deny" });
  });

  it("does not mutate the shared defaults", () => {
    mergePolicies({ read: { inside: "deny" } });
    expect(DEFAULT_ACP_PERMISSIONS.read).toEqual({ inside: "always", outside: "always" });
  });

  it("a junk layer contributes nothing rather than erasing below it", () => {
    const merged = mergePolicies({ execute: { inside: "deny" } }, { execute: { inside: "bogus" } });
    expect(merged.execute.inside).toBe("deny");
  });
});

describe("decidePermission", () => {
  it("uses the inside rule for a path in the working directory", () => {
    const policy = mergePolicies({ edit: { inside: "once", outside: "deny" } });
    const d = decidePermission({
      action: "edit",
      paths: [path.join(workdir, "a.txt")],
      policy,
      workspaceCwd: workdir,
    });
    expect(d.value).toBe("once");
    expect(d.inside).toBe(true);
  });

  it("uses the outside rule for a path beyond it", () => {
    const policy = mergePolicies({ edit: { inside: "once", outside: "deny" } });
    const d = decidePermission({ action: "edit", paths: ["/etc/hosts"], policy, workspaceCwd: workdir });
    expect(d.value).toBe("deny");
    expect(d.inside).toBe(false);
  });

  it("denies by default rather than falling back to allow on a malformed policy", () => {
    const d = decidePermission({ action: "execute", paths: [], policy: { execute: { inside: "???" } }, workspaceCwd: workdir });
    expect(d.value).toBe("deny");
  });
});

describe("chooseOption", () => {
  const options = [
    { optionId: "once", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ];

  it("picks the option matching the decision", () => {
    expect(chooseOption(options, "always").optionId).toBe("always");
    expect(chooseOption(options, "once").optionId).toBe("once");
    expect(chooseOption(options, "deny").optionId).toBe("reject");
  });

  it("returns null when the agent offers nothing", () => {
    expect(chooseOption([], "always")).toBeNull();
    expect(chooseOption(undefined, "deny")).toBeNull();
  });
});