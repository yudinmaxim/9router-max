import http from "node:http";
import { WebSocketServer } from "ws";
import { getExecutor } from "../executors/index.js";
import { createChildFactory } from "./factory.js";
import { createAcpServer } from "./server.js";

const port = Number(process.env.PORT || 20129);
const providerId = "codex-acp";
const executor = getExecutor(providerId);
if (!executor?.acp) throw new Error(`${providerId} has no ACP spec`);
const factory = createChildFactory({
  providerId,
  spec: executor.acp,
  log: (level, message) => console.error(`[${level}] ${message}`),
});

const httpServer = http.createServer((req, res) => {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("ACP WebSocket endpoint only\n");
});
const wss = new WebSocketServer({ server: httpServer, path: "/api/acp/ws", maxPayload: 1024 * 1024 });

wss.on("connection", (socket) => {
  const server = createAcpServer({
    write: (frame) => socket.send(JSON.stringify(frame)),
    openChild: factory.openChild,
    modelCatalog: () => [{ modelId: providerId, name: providerId }],
    log: (level, message) => console.error(`[${level}] ${message}`),
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

httpServer.listen(port, "127.0.0.1", () => console.error(`[acp] ws://127.0.0.1:${port}/api/acp/ws`));
