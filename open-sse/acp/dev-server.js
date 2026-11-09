import http from "node:http";
import { WebSocketServer } from "ws";
import { createAcpServer } from "./server.js";
import { createAcpProviders } from "./providers.js";

const port = Number(process.env.PORT || 20129);
const log = (level, message) => console.error(`[${level}] ${message}`);
const { openChild, modelCatalog, providerIds } = createAcpProviders({ log });

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
  console.error(`[acp] ws://127.0.0.1:${port}/api/acp/ws providers=${providerIds.join(",")}`);
});
