// Regression: two ACP catalog bugs that made every opencode model unreachable.
//
//   1. `collectModelCatalog` read only `modelId`/`id` off catalog options, but
//      opencode and omp send `{value, name}`. Every option was dropped, the
//      catalog came back empty, and the resolver passed the bare requested name
//      to the agent → `-32602 model not found`.
//   2. Matching compared the full id, so a provider-qualified id
//      (`opencode/space-bunny-free`) could never match a bare request
//      (`space-bunny-free`). The fallback then returned the CLI's *current*
//      model — which for opencode is `nine-router/oc/space-bunny-free`, a
//      self-routed id that sends the agent straight back into this gateway.
//
// The payloads below are the real `session/new` shapes captured from
// `opencode acp` and `omp acp`.

import { describe, it, expect } from "vitest";
import {
  collectModelCatalog,
  resolveAgentModelId,
  usableAgentModels,
  isSelfRouted,
} from "open-sse/executors/lib/acpBase.js";

const OPENCODE_SESSION_NEW = {
  sessionId: "ses_test",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "nine-router/oc/space-bunny-free",
      options: [
        { value: "opencode/big-pickle", name: "OpenCode/Big Pickle" },
        { value: "opencode/space-bunny-free", name: "OpenCode/Space Bunny Free" },
        { value: "nine-router/oc/space-bunny-free", name: "9Router/space-bunny-free (oc)" },
      ],
    },
  ],
};

const OMP_SESSION_NEW = {
  sessionId: "ses_omp",
  configOptions: [
    {
      id: "mode",
      type: "select",
      category: "mode",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }],
    },
    {
      id: "model",
      type: "select",
      category: "model",
      currentValue: "nine-router/oc-robust",
      options: [{ value: "nine-router/oc-robust", name: "OC Robust (9router fallback combo)" }],
    },
  ],
};

// cursor uses a different shape entirely.
const CURSOR_SESSION_NEW = {
  sessionId: "ses_cursor",
  models: {
    currentModelId: "default[]",
    availableModels: [
      { modelId: "default[]" },
      { modelId: "composer-2.5[fast=true]" },
      { modelId: "gpt-5.3-codex[reasoning=medium]" },
    ],
  },
};

describe("collectModelCatalog", () => {
  it("reads opencode/omp `{value}` options", () => {
    const catalog = collectModelCatalog(OPENCODE_SESSION_NEW);
    expect(catalog).toContain("opencode/space-bunny-free");
    expect(catalog).toContain("opencode/big-pickle");
  });

  it("still reads cursor `{modelId}` options", () => {
    const catalog = collectModelCatalog(CURSOR_SESSION_NEW);
    expect(catalog).toEqual(["default[]", "composer-2.5[fast=true]", "gpt-5.3-codex[reasoning=medium]"]);
  });

  it("finds the model option by id, not position (omp lists mode first)", () => {
    expect(collectModelCatalog(OMP_SESSION_NEW)).toContain("nine-router/oc-robust");
  });

  it("tolerates a result with no catalog at all", () => {
    expect(collectModelCatalog({})).toEqual([]);
    expect(collectModelCatalog(undefined)).toEqual([]);
  });
});

describe("resolveAgentModelId", () => {
  it("matches a bare request against a provider-qualified id", () => {
    const catalog = collectModelCatalog(OPENCODE_SESSION_NEW);
    const resolved = resolveAgentModelId("space-bunny-free", catalog, "nine-router/oc/space-bunny-free");
    expect(resolved).toBe("opencode/space-bunny-free");
  });

  it("never returns a self-routed id, so the agent cannot call back into 9router", () => {
    const catalog = collectModelCatalog(OPENCODE_SESSION_NEW);
    // Nothing matches, and the CLI's current model points back at the gateway.
    const resolved = resolveAgentModelId("totally-unknown-model", catalog, "nine-router/oc/space-bunny-free");
    expect(resolved).not.toMatch(/nine-?router/i);
    expect(isSelfRouted(resolved)).toBe(false);
  });

  it("echoes the request rather than a self-routed id when nothing is usable", () => {
    const catalog = collectModelCatalog(OMP_SESSION_NEW);
    const resolved = resolveAgentModelId("anything", catalog, "nine-router/oc-robust");
    // omp exposes only a 9router combo, so there is nothing safe to select.
    // Returning the requested name gets a clear "-32602 model not found" from
    // the agent; returning the combo would call back into this gateway.
    expect(resolved).toBe("anything");
    expect(isSelfRouted(resolved)).toBe(false);
  });

  it("knows when a catalog has nothing safe to select", () => {
    // The whole catalog pointing at this gateway is the dangerous shape: a bare
    // request like `space-bunny-free` resolves to something that does not look
    // self-routed, so the pick-level check cannot see the loop coming.
    const onlySelfRouted = ["nine-router/oacp/space-bunny-free", "nine-router/ca/composer-2.5"];
    expect(usableAgentModels(onlySelfRouted)).toEqual([]);
    expect(isSelfRouted(resolveAgentModelId("space-bunny-free", onlySelfRouted, ""))).toBe(false);

    const mixed = [...onlySelfRouted, "opencode/big-pickle"];
    expect(usableAgentModels(mixed)).toEqual(["opencode/big-pickle"]);
  });

  it("treats an empty catalog as no opinion, not as a refusal", () => {
    expect(usableAgentModels([])).toEqual([]);
    expect(usableAgentModels(undefined)).toEqual([]);
    // An older CLI with no catalog still gets its request forwarded.
    expect(resolveAgentModelId("anything", [], "")).toBe("anything");
  });

  it("keeps cursor's bracket-suffixed ids and explicit default", () => {
    const catalog = collectModelCatalog(CURSOR_SESSION_NEW);
    expect(resolveAgentModelId("composer-2.5", catalog, "default[]")).toBe("composer-2.5[fast=true]");
    expect(resolveAgentModelId("gpt-5.3-codex", catalog, "default[]")).toBe("gpt-5.3-codex[reasoning=medium]");
    expect(resolveAgentModelId("unknown", catalog, "default[]")).toBe("default[]");
  });
});