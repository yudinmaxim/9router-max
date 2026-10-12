import { describe, expect, it, vi, beforeEach } from "vitest";

const appendRequestLog = vi.fn(async () => {});
const saveRequestUsage = vi.fn(async () => {});
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: (...args) => appendRequestLog(...args),
  saveRequestUsage: (...args) => saveRequestUsage(...args),
}));

const { extractStreamError } = await import("../../open-sse/utils/streamHelpers.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");

async function runStream(input, { targetFormat = FORMATS.OPENAI, sourceFormat = FORMATS.CLAUDE } = {}) {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = upstream.pipeThrough(
    createSSETransformStreamWithLogger(targetFormat, sourceFormat, "opencode", null, null, "some-model"),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("extractStreamError", () => {
  it("maps an OpenAI quota error onto 429", () => {
    const err = extractStreamError({
      error: { message: "FreeUsageLimitError", type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
    expect(err).toEqual({ statusCode: 429, message: "FreeUsageLimitError" });
  });

  it("maps an Anthropic-style error envelope onto 429", () => {
    const err = extractStreamError({
      type: "error",
      error: { type: "rate_limit_error", message: "Number of requests has exceeded your quota" },
    });
    expect(err).toEqual({ statusCode: 429, message: "Number of requests has exceeded your quota" });
  });

  it("honours an explicit numeric status from Gemini-shaped errors", () => {
    const err = extractStreamError({
      error: { code: 429, message: "quota exhausted", status: "RESOURCE_EXHAUSTED" },
    });
    expect(err.statusCode).toBe(429);
    expect(err.message).toBe("quota exhausted");
  });

  it("maps an overloaded error onto 503 and an auth error onto 401", () => {
    expect(extractStreamError({ error: { message: "x", type: "overloaded_error" } }).statusCode).toBe(503);
    expect(extractStreamError({ error: { message: "x", type: "authentication_error" } }).statusCode).toBe(401);
  });

  it("defaults an unrecognised error to 502", () => {
    expect(extractStreamError({ error: { message: "something broke" } }).statusCode).toBe(502);
  });

  it("accepts a bare string error", () => {
    expect(extractStreamError({ error: "upstream exploded" })).toEqual({
      statusCode: 502,
      message: "upstream exploded",
    });
  });

  it("returns null for ordinary chunks and for empty error objects", () => {
    expect(extractStreamError({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
    expect(extractStreamError({ done: true })).toBeNull();
    expect(extractStreamError({})).toBeNull();
    expect(extractStreamError(null)).toBeNull();
    expect(extractStreamError({ error: {} })).toBeNull();
  });
});

describe("error frame arriving inside a 200 stream", () => {
  beforeEach(() => {
    appendRequestLog.mockClear();
    saveRequestUsage.mockClear();
  });

  it("reaches an Anthropic client as `event: error` instead of an empty stream", async () => {
    const out = await runStream(
      'data: {"error":{"message":"FreeUsageLimitError","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n',
    );
    expect(out).toContain("event: error");
    expect(out).toContain("FreeUsageLimitError");
    expect(out).toContain('"type":"rate_limit_error"');
  });

  it("reaches an OpenAI client as an error frame followed by [DONE]", async () => {
    const out = await runStream(
      'data: {"error":{"message":"FreeUsageLimitError","type":"rate_limit_error"}}\n\n',
      { sourceFormat: FORMATS.OPENAI },
    );
    expect(out).toContain('"error"');
    expect(out).toContain("FreeUsageLimitError");
    expect(out).toContain("data: [DONE]");
  });

  it("surfaces an error that arrives without its closing newline", async () => {
    const out = await runStream(
      'data: {"error":{"message":"tail error","type":"rate_limit_error"}}',
    );
    expect(out).toContain("tail error");
  });

  it("records the failure in usage history", async () => {
    await runStream('data: {"error":{"message":"quota gone","type":"rate_limit_error"}}\n\n');
    const statuses = saveRequestUsage.mock.calls.map((c) => c[0].status);
    expect(statuses).toContain("FAILED 429");
  });

  it("still reports a normal completion as 200 OK", async () => {
    await runStream(
      'data: {"id":"chatcmpl-abc123456","choices":[{"delta":{"content":"hi"},"index":0}]}\n\ndata: {"id":"chatcmpl-abc123456","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n',
      { sourceFormat: FORMATS.OPENAI },
    );
    expect(saveRequestUsage.mock.calls.map((c) => c[0].status)).not.toContain("FAILED 429");
  });

  it("delivers content that arrived before the error frame, then reports the error", async () => {
    const out = await runStream(
      'data: {"id":"chatcmpl-abc123456","choices":[{"delta":{"content":"partial"},"index":0}]}\n\n' +
      'data: {"error":{"message":"cut short","type":"server_error"}}\n\n',
      { sourceFormat: FORMATS.OPENAI },
    );
    expect(out).toContain("partial");
    expect(out).toContain("cut short");
  });
});