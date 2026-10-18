import { FORMATS } from "../translator/formats.js";

const DEFAULT_MIN_CHARS = 25000;
const DEFAULT_TIMEOUT_MS = 15000;

function bodyChars(body) {
  try {
    return JSON.stringify(body)?.length || 0;
  } catch {
    return 0;
  }
}

// Transform a Claude-format request body through pxpipe.
// Returns the new body, or null when nothing changed.
//
// It used to also return a summary — chars before and after, an estimated token
// saving, a percentage, a duration — and that summary is what grew into a
// per-request JSONL file, a savings timeline and a statistics panel. Its own
// comment admitted the trap it was walking into: the transformed body is LARGER
// in bytes (base64 PNGs) while being cheaper in tokens, so the estimate had to be
// reconstructed in token space, and it was reconstructed from `chars / 4` — the
// same crude average it was trying to escape. A savings number nobody can check
// against a bill is decoration, and the file write behind it cost real time on
// every compressed request. All of that is gone by decision; the compression
// stays.
//
// opts.transform is injected by the host (src side) so open-sse stays free of
// filesystem/install concerns and remains usable standalone.
export async function compressWithPxpipe(body, { enabled, format, model, minChars, timeoutMs, transform } = {}) {
  if (!enabled) return null;
  if (typeof transform !== "function") return null;
  if (!body) return null;
  if (format !== FORMATS.CLAUDE) return null;

  const threshold = Number(minChars) > 0 ? Number(minChars) : DEFAULT_MIN_CHARS;
  if (bodyChars(body) < threshold) return null;

  try {
    const encoded = new TextEncoder().encode(JSON.stringify(body));
    const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    // transformAnthropicMessages is local CPU work and can't be aborted; race a
    // timer and discard the result if it loses (input body is never mutated).
    const result = await Promise.race([
      transform({
        body: encoded,
        model,
        options: { minCompressChars: threshold },
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), budget)),
    ]);
    if (!result || !result.applied) return null;

    return JSON.parse(new TextDecoder().decode(result.body));
  } catch {
    // Fail-open: a transform that throws leaves the request uncompressed rather
    // than failing it.
    return null;
  }
}