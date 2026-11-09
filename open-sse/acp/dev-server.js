import http from "node:http";
import { WebSocketServer } from "ws";
import { getExecutor } from "../executors/index.js";
import { createChildFactory } from "./factory.js";
import { createAcpServer } from "./server.js";
import { readCachedCatalog } from "../executors/lib/acpCatalog.js";

const port = Number(process.env.PORT || 20129);
// Comma-separated ACP provider ids. Each becomes a child factory; the
// dispatcher routes `provider/model` (or `provider::model`) selections to the
// matching factory and strips the prefix before talking to the child.
const providerIds = (process.env.ACP_PROVIDERS || "codex-acp")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const log = (level, message) => console.error(`[${level}] ${message}`);
const factories = new Map();
for (const providerId of providerIds) {
  const executor = getExecutor(providerId);
  if (!executor?.acp) {
    log("warn", `skip ${providerId}: executor has no ACP spec`);
    continue;
  }
  factories.set(providerId, createChildFactory({ providerId, spec: executor.acp, log }));
}
if (!factories.size) throw new Error("no usable ACP providers configured");

const DEFAULT_PROVIDER = providerIds.find((id) => factories.has(id));

function splitModelSelector(model) {
  if (!model || model === "default") return { providerId: null, childModel: "default" };
  const sep = model.includes("::") ? "::" : model.includes("/") ? "/" : null;
  if (!sep) {
    return factories.has(model)
      ? { providerId: model, childModel: "default" }
      : { providerId: null, childModel: model };
  }
  const head = model.slice(0, model.indexOf(sep));
  if (!factories.has(head)) return { providerId: null, childModel: model };
  return { providerId: head, childModel: model.slice(head.length + sep.length) || "default" };
}

async function openChild({ cwd, mcpServers, model = "default", resumeSessionId = null }) {
  const { providerId, childModel } = splitModelSelector(model);
  const target = providerId || DEFAULT_PROVIDER;
  const factory = factories.get(target);
  if (!factory) throw new Error(`no ACP factory for provider ${target}`);
  const child = await factory.openChild({ cwd, mcpServers, model: childModel, resumeSessionId });
  log("info", `openChild routed ${model || "default"} → ${target} childModel=${childModel} session=${child?.sessionId || "?"} resumed=${!!child?.resumed}`);
  return child;
}

function modelCatalog() {
  const out = [];
  for (const providerId of factories.keys()) {
    const cached = readCachedCatalog(providerId);
    const models = cached?.models || [];
    if (models.length) {
      for (const m of models) {
        out.push({ modelId: `${providerId}/${m.id}`, name: `${providerId}: ${m.name || m.id}` });
      }
    } else {
      out.push({ modelId: providerId, name: `${providerId} (default model)` });
    }
  }
  return out;
}

const httpServer = http.createServer((req, res) => {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("ACP WebSocket endpoint only\n");
});
const wss = new WebSocketServer({ server: httpServer, path: "/api/acp/ws", maxPayload: 1024 * 1024 });

wss.on("connection", (socket) => {
  const server = createAcpServer({
    write: (frame) => socket.send(JSON.stringify(frame)),
    openChild,
    modelCatalog,
    log,
    clientInfo: { name: "9router", version: "0.5.99" },
  });
  socket.on("message", async (data, binary) => {
    if (binary) return socket.close(1003, "text frames required");
    let message;
    try { message = JSON.parse(data.toString()); } catch { return socket.close(1007, "invalid JSON"); }
    if (message?.jsonrpc !== "2.0") return socket.close(1007, "invalid JSON-RPC");
    await server.handle(message);
  });
});

httpServer.listen(port, "127.0.0.1", () => {
  console.error(`[acp] ws://127.0.0.1:${port}/api/acp/ws providers=${[...factories.keys()].join(",")}`);
});
