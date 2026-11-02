import { WebSocketServer } from "ws";
import { createAcpServer } from "./server.js";

export function attachAcpWebSocket(server, { openChild, modelCatalog, log = () => {}, clientInfo } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/api/acp/ws") return;
    if (request.headers.origin && request.headers.origin !== "http://127.0.0.1" && request.headers.origin !== "http://localhost") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const trace = process.env.ACP_TRACE === "1";
      const write = (frame) => {
        if (trace) console.error(`[ACP WS] → ${JSON.stringify(frame)}`);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      };
      const acp = createAcpServer({ write, openChild, modelCatalog, log, clientInfo });
      ws.on("message", async (data, isBinary) => {
        if (isBinary) return ws.close(1003, "text frames required");
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return ws.close(1007, "invalid JSON"); }
        if (process.env.ACP_TRACE === "1") console.error(`[ACP WS] ← ${JSON.stringify(frame)}`);
        if (!frame || typeof frame !== "object" || frame.jsonrpc !== "2.0") return ws.close(1007, "invalid JSON-RPC");
        try { await acp.handle(frame); } catch (error) { log("error", `ACP WebSocket frame failed: ${error?.stack || error}`); }
      });
      ws.on("error", (error) => log("error", `ACP WebSocket error: ${error.message}`));
    });
  });

  return wss;
}
