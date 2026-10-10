/**
 * Minimal HTTP/2 POST helper for Cursor's Connect-RPC endpoints.
 *
 * Cursor speaks Connect-RPC over h2 only: a plain `fetch` (HTTP/1.1) is
 * rejected with 415 even on endpoints that are otherwise working, so every
 * cursor call has to go through node:http2. Extracted from the cursor executor
 * so the usage/quota service can reuse exactly the same client instead of
 * growing a second, subtly different one.
 *
 * Note on content-type: `application/connect+proto` is the STREAMING encoding
 * and gets 415 on unary RPCs. Unary calls (e.g. GetCurrentPeriodUsage) must use
 * `application/json` or `application/proto`.
 */

// The engine runs in edge/worker sandboxes too, where node:http2 does not exist
// and a static import would break the whole module at load time. Resolve it on
// first use and cache the result (cursor.js used the same lazy pattern).
let http2Promise = null;
function loadHttp2() {
  if (!http2Promise) {
    http2Promise = Promise.resolve()
      .then(() => import("http2"))
      .then((mod) => mod.connect ? mod : mod.default)
      .catch(() => null);
  }
  return http2Promise;
}

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * POST to an https:// URL over HTTP/2 and buffer the whole response.
 *
 * @param {string} url full URL (path is used, host becomes :authority)
 * @param {Record<string,string>} headers
 * @param {Buffer|string} body
 * @param {AbortSignal} [signal]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, headers: Record<string,unknown>, body: Buffer }>}
 */
export async function makeCursorHttp2Request(url, headers, body, signal, options = {}) {
  const http2 = await loadHttp2();
  if (!http2?.connect) throw new Error("http2 module not available in this runtime");

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = http2.connect(`https://${urlObj.host}`);
    const chunks = [];
    let responseHeaders = {};
    let settled = false;

    const finish = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(hangTimeout);
      try {
        client.close();
      } catch {
        /* already closed */
      }
      fn(...args);
    };

    // Hard timeout: close the session if the server never responds.
    const hangTimeout = setTimeout(
      finish(() => reject(new Error("HTTP/2 request timed out"))),
      timeoutMs
    );

    client.on("error", finish(reject));

    const req = client.request({
      ":method": "POST",
      ":path": urlObj.pathname + (urlObj.search || ""),
      ":authority": urlObj.host,
      ":scheme": "https",
      ...headers,
    });

    req.on("response", (hdrs) => {
      responseHeaders = hdrs;
    });
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", finish(() =>
      resolve({
        status: responseHeaders[":status"],
        headers: responseHeaders,
        body: Buffer.concat(chunks),
      })
    ));
    req.on("error", finish(reject));

    if (signal) {
      signal.addEventListener("abort", finish(() => reject(new Error("Request aborted"))), {
        once: true,
      });
    }

    req.write(body);
    req.end();
  });
}

export default makeCursorHttp2Request;