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
 * Provider selection (M4): for now, hardcodes codex-acp. The full
 * provider-resolve logic from _meta/settings is deferred to M4.
 */
import { createAcpTransport } from "../executors/lib/acpTransport.js";
import { createAcpServer } from "./server.js";
import { createChildFactory } from "./factory.js";
import { getExecutor } from "../executors/index.js";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "acp") {
    console.error("Usage: node <entry> acp");
    process.exit(1);
  }

  const transport = createAcpTransport({
    stdin: process.stdin,
    stdout: process.stdout,
  });

  const modelCatalog = () => {
    const models = [];
    const acpProviders = ["codex-acp", "cursor-acp", "opencode-acp"];
    for (const providerId of acpProviders) {
      const executor = getExecutor(providerId);
      if (executor?.acp) {
        models.push({ modelId: providerId, name: providerId });
      }
    }
    return models;
  };

  const log = (level, msg) => {
    try {
      process.stderr.write(`[${level}] ${msg}\n`);
    } catch {
      /* ignore */
    }
  };

  const providerId = "codex-acp";
  const executor = getExecutor(providerId);
  if (!executor?.acp) {
    log("error", `provider ${providerId} has no ACP spec`);
    process.exit(1);
  }

  const factory = createChildFactory({
    providerId,
    spec: executor.acp,
    log,
  });

  const server = createAcpServer({
    write: (frame) => transport.sendRaw(frame),
    openChild: factory.openChild,
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
