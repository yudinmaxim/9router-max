const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

let acpWebSocketAttached = false;

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
    attachAcpWebSocketToServer(server).catch((err) => {
      console.error("[ACP WebSocket] Failed to attach:", err && err.message ? err.message : err);
    });
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

async function attachAcpWebSocketToServer(server) {
  if (acpWebSocketAttached) return;
  acpWebSocketAttached = true;

  try {
    const { attachAcpWebSocket } = await import(pathToFileURL(path.join(__dirname, "open-sse", "acp", "websocket.js")).href);
    const { createChildFactory } = await import(pathToFileURL(path.join(__dirname, "open-sse", "acp", "factory.js")).href);
    const { getExecutor } = await import(pathToFileURL(path.join(__dirname, "open-sse", "executors", "index.js")).href);
    const { getProviderCredentials } = await import(pathToFileURL(path.join(__dirname, "src", "sse", "services", "auth.js")).href);

    const acpProviders = ["codex-acp", "cursor-acp", "opencode-acp", "omp-acp"];
    const { getModelsByProviderId } = await import(pathToFileURL(path.join(__dirname, "open-sse", "config", "providerModels.js")).href);
    const factories = new Map();
    const resolveProvider = (model) => {
      const value = typeof model === "string" ? model : "";
      const match = acpProviders.find((id) => value === id || value.startsWith(`${id}/`));
      return match || "codex-acp";
    };
    const resolveContext = async ({ providerId: id, model }) => {
      const credentials = await getProviderCredentials(id, new Set(), model);
      const data = credentials?.providerSpecificData || {};
      return { context: { connectionId: credentials?.connectionId || null }, proxyOptions: {
        connectionProxyEnabled: data.connectionProxyEnabled === true,
        connectionProxyUrl: data.connectionProxyUrl || "",
        connectionNoProxy: data.connectionNoProxy || "",
        connectionProxyPoolId: data.connectionProxyPoolId || data.proxyPoolId || "",
        strictProxy: data.strictProxy === true,
        vercelRelayUrl: data.vercelRelayUrl || "",
      } };
    };
    for (const providerId of acpProviders) {
      const executor = getExecutor(providerId);
      if (!executor?.acp) continue;
      factories.set(providerId, createChildFactory({
        providerId,
        spec: executor.acp,
        resolveContext,
        log: (level, message) => console.error(`[ACP WebSocket] [${level}] ${message}`),
      }));
    }
    const modelCatalog = () => acpProviders.flatMap((provider) => {
      const models = getModelsByProviderId(provider);
      return models.length
        ? models.map(({ id, name }) => ({ modelId: `${provider}/${id}`, name: name || id, provider }))
        : [{ modelId: provider, name: provider, provider }];
    });

    attachAcpWebSocket(server, {
      openChild: (opts) => {
        const provider = resolveProvider(opts.model);
        const factory = factories.get(provider);
        if (!factory) throw new Error(`ACP provider unavailable: ${provider}`);
        return factory.openChild({ ...opts, model: opts.model?.split("/").slice(1).join("/") || "default" });
      },
      modelCatalog,
      log: (level, message) => console.error(`[ACP WebSocket] [${level}] ${message}`),
      clientInfo: { name: "9router", version: "0.5.99" },
    });

    console.error("[ACP WebSocket] Attached to /api/acp/ws");
  } catch (err) {
    console.error("[ACP WebSocket] Attachment failed:", err && err.message ? err.message : err);
    throw err;
  }
}

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
