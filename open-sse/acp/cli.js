/**
 * ACP stdio entry — reads newline-delimited JSON-RPC from stdin,
 * writes to stdout, logs to stderr.
 *
 * This is the thin entry point Zed invokes as an External Agent:
 *   node <entry> acp
 *
 * It reuses createAcpTransport for framing, so no protocol duplication.
 * Logs go strictly to stderr — stdout is reserved for JSON-RPC.
 *
 * Provider set comes from ACP_PROVIDERS (default codex-acp,opencode-acp);
 * see providers.js for the shared dispatcher/catalog used by dev-server.js.
 */
import { createAcpTransport } from "../executors/lib/acpTransport.js";
import { createAcpServer } from "./server.js";
import { createAcpProviders } from "./providers.js";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "acp") {
    console.error("Usage: node <entry> acp");
    process.exit(1);
  }

  // Remote mode: ACP_REMOTE_WS points at a dev-server.js endpoint, so the
  // ACP session — and all provider children — live in that process (e.g.
  // inside the VPN container) while Zed still sees a plain stdio agent.
  // Framing differs only in transport: newline-delimited JSON on stdio vs
  // one JSON text frame per message on the socket; payloads pass through
  // untouched in both directions.
  const remoteWs = process.env.ACP_REMOTE_WS;
  if (remoteWs) {
    const log = (level, msg) => {
      try { process.stderr.write(`[${level}] ${msg}\n`); } catch { /* ignore */ }
    };
    const socket = new WebSocket(remoteWs);
    const pending = [];
    socket.addEventListener("open", () => {
      log("info", `ACP remote bridge → ${remoteWs}`);
      for (const chunk of pending.splice(0)) socket.send(chunk);
    });
    socket.addEventListener("message", (event) => {
      process.stdout.write(`${typeof event.data === "string" ? event.data : Buffer.from(event.data).toString()}\n`);
    });
    socket.addEventListener("close", (event) => {
      log("info", `remote socket closed (${event.code} ${event.reason || ""}), exiting`);
      process.exit(event.code === 1000 ? 0 : 1);
    });
    socket.addEventListener("error", (event) => {
      log("error", `remote socket error: ${event.message || event.type || "unknown"}`);
    });
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { JSON.parse(line); } catch { continue; }
        if (socket.readyState === WebSocket.OPEN) socket.send(line);
        else pending.push(line);
      }
    });
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
    return;
  }

  // createAcpTransport is built for child processes: it writes to
  // `child.stdin` and reads `child.stdout`. For the server side the roles
  // are inverted — replies must go to OUR stdout and requests arrive on OUR
  // stdin — so the streams are passed swapped.
  const transport = createAcpTransport({
    stdin: process.stdout,
    stdout: process.stdin,
  });

  const log = (level, msg) => {
    try {
      process.stderr.write(`[${level}] ${msg}\n`);
    } catch {
      /* ignore */
    }
  };

  const { openChild, modelCatalog, providerIds } = createAcpProviders({ log });
  log("info", `ACP providers: ${providerIds.join(",")}`);

  const server = createAcpServer({
    write: (frame) => transport.sendRaw(frame),
    openChild,
    modelCatalog,
    log,
    clientInfo: { name: "9router", version: "1.0" },
  });

  transport.onMessage((msg) => {
    server.handle(msg).catch((err) => {
      log("error", `handle failed: ${err?.stack || err}`);
    });
  });

  process.on("SIGINT", () => {
    log("info", "SIGINT received, exiting");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    log("info", "SIGTERM received, exiting");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`ACP entry failed: ${err?.stack || err}`);
  process.exit(1);
});
