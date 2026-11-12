// Remote-mode bridge test for open-sse/acp/cli.js: with ACP_REMOTE_WS set,
// the stdio entry must forward newline-delimited JSON-RPC from stdin to the
// WebSocket as text frames, and socket messages back to stdout as lines.
// This is the exact path Zed uses against the containerized endpoint, so the
// framing contract is pinned end-to-end with a real socket pair.

import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "open-sse/acp/cli.js");
const LOADER = path.join(ROOT, "alias-loader.mjs");

let wss;
let child;
let port;

async function startBridge() {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  port = wss.address().port;

  const received = [];
  const socketReady = new Promise((resolve) => {
    wss.once("connection", (socket) => {
      socket.on("message", (data) => received.push(data.toString()));
      resolve(socket);
    });
  });

  child = spawn(process.execPath, ["--experimental-loader", LOADER, CLI, "acp"], {
    env: { ...process.env, ACP_REMOTE_WS: `ws://127.0.0.1:${port}/api/acp/ws` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // bridge logs go to stderr — swallow

  let stdoutBuf = "";
  const stdoutLines = [];
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let i;
    while ((i = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, i).trim();
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (line) stdoutLines.push(line);
    }
  });

  const socket = await socketReady;
  return { socket, received, stdoutLines };
}

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  await new Promise((r) => (wss ? wss.close(r) : r()));
  wss = null;
});

describe("ACP cli.js remote bridge", () => {
  it("forwards stdin JSON lines to the socket and socket frames to stdout", async () => {
    const { socket, received, stdoutLines } = await startBridge();

    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    child.stdin.write(request + "\n");
    await vi.waitFor(() => expect(received).toContain(request), { timeout: 5000 });

    const reply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    socket.send(reply);
    await vi.waitFor(() => expect(stdoutLines).toContain(reply), { timeout: 5000 });

    // Malformed lines must not reach the socket.
    child.stdin.write("not json\n");
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
  }, 15000);
});
