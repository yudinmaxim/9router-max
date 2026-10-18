// pxpipe gates.
//
// These assert on the return value — a new body, or null — because that is the
// only thing left. The function used to also return a summary of chars and
// estimated tokens, and this file asserted on it; that reporting is gone by
// decision, so the tests now say what they can actually vouch for: whether the
// transform ran, and what came back.

import { describe, expect, it, vi } from "vitest";
import { compressWithPxpipe } from "../../open-sse/rtk/pxpipe.js";

const bigText = "x".repeat(30000);
const claudeBody = () => ({
  model: "claude-fable-5",
  max_tokens: 100,
  messages: [{ role: "user", content: bigText }],
});

// A transform double mimicking pxpipe-proxy/transform's contract.
const appliedTransform = (outBody) => async () => ({
  applied: true,
  reason: "applied",
  body: new TextEncoder().encode(JSON.stringify(outBody)),
  info: { compressedChars: 25000, imageCount: 2, imageBytes: 5000, imagePixels: 1500000 },
  cache: { ownsCacheControl: true, markerCount: 1 },
});

describe("compressWithPxpipe gates", () => {
  it("skips when disabled", async () => {
    const transform = vi.fn();
    const result = await compressWithPxpipe(claudeBody(), { enabled: false, transform });
    expect(result).toBeNull();
    expect(transform).not.toHaveBeenCalled();
  });

  it("skips when transform is unavailable (not installed)", async () => {
    const result = await compressWithPxpipe(claudeBody(), { enabled: true, format: "claude", transform: null });
    expect(result).toBeNull();
  });

  it("skips non-Claude formats", async () => {
    const transform = vi.fn();
    const result = await compressWithPxpipe(claudeBody(), { enabled: true, format: "openai", transform });
    expect(result).toBeNull();
    expect(transform).not.toHaveBeenCalled();
  });

  it("bypasses small prompts below minChars", async () => {
    const transform = vi.fn();
    const small = { model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] };
    const result = await compressWithPxpipe(small, { enabled: true, format: "claude", minChars: 25000, transform });
    expect(result).toBeNull();
    expect(transform).not.toHaveBeenCalled();
  });

  it("returns the transformed body when the transform applies", async () => {
    const compressed = { model: "claude-fable-5", messages: [{ role: "user", content: "imaged" }] };
    const result = await compressWithPxpipe(claudeBody(), {
      enabled: true, format: "claude", minChars: 1000, transform: appliedTransform(compressed),
    });
    expect(result).toEqual(compressed);
  });

  it("passes through when the transform declines (not_profitable)", async () => {
    const transform = vi.fn(async () => ({ applied: false, reason: "not_profitable", body: new Uint8Array(), info: {} }));
    const result = await compressWithPxpipe(claudeBody(), {
      enabled: true, format: "claude", minChars: 1000, transform,
    });
    expect(result).toBeNull();
    expect(transform).toHaveBeenCalled();
  });

  it("fails open when the transform throws", async () => {
    const transform = async () => { throw new Error("boom"); };
    const result = await compressWithPxpipe(claudeBody(), {
      enabled: true, format: "claude", minChars: 1000, transform,
    });
    // Fail-open: a throwing transform leaves the request uncompressed rather
    // than failing it.
    expect(result).toBeNull();
  });

  it("fails open on timeout", async () => {
    const transform = () => new Promise(() => {}); // never resolves
    const result = await compressWithPxpipe(claudeBody(), {
      enabled: true, format: "claude", minChars: 1000, timeoutMs: 50, transform,
    });
    expect(result).toBeNull();
  });

  it("leaves the input body untouched", async () => {
    const body = claudeBody();
    const before = JSON.stringify(body);
    await compressWithPxpipe(body, {
      enabled: true, format: "claude", minChars: 1000, transform: appliedTransform({ model: "x", messages: [] }),
    });
    // The result replaces the body in chatCore; the original must survive so a
    // declined transform costs nothing.
    expect(JSON.stringify(body)).toBe(before);
  });
});