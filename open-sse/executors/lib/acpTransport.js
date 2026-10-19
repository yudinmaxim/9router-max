/**
 * ACP child-process JSON-RPC transport.
 *
 * ACP uses newline-delimited JSON over child stdin/stdout. Transport owns only
 * framing and dispatch; request sequencing and protocol state stay with caller.
 */
export function createAcpTransport(child) {
  let closed = false;
  let buffer = "";
  const listeners = new Set();

  const write = (message) => {
    if (closed || child.stdin.destroyed) return false;
    try {
      child.stdin.write(JSON.stringify(message) + "\n");
      return true;
    } catch {
      return false;
    }
  };

  const send = (method, params, id) => {
    const message = { jsonrpc: "2.0", method, params };
    if (id !== undefined) message.id = id;
    return write(message) ? id : undefined;
  };

  const onMessage = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        for (const listener of listeners) listener(message);
      } catch {
        // Ignore non-JSON lines (agent banners, diagnostics, etc.).
      }
    }
  });

  return {
    send,
    sendRaw: write,
    onMessage,
    close() { closed = true; },
  };
}
