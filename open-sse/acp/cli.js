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
