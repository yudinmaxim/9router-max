#!/usr/bin/env node
import http from "node:http";
import net from "node:net";

const port = Number(process.env.ACP_PROXY_PORT || 20130);

function target(req) {
  try {
    const url = new URL(req.url);
    return `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
  } catch {
    return req.url || "";
  }
}

const server = http.createServer((req, res) => {
  console.error(`[ACP TEST PROXY] ${req.method} ${target(req)}`);
  const upstream = http.request(req.url, {
    method: req.method,
    headers: req.headers,
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", (error) => {
    console.error(`[ACP TEST PROXY] request error ${error.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.on("connect", (req, clientSocket, head) => {
  const [host, portText] = req.url.split(":");
  const port = Number(portText || 443);
  console.error(`[ACP TEST PROXY] CONNECT ${host}:${port}`);
  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", (error) => {
    console.error(`[ACP TEST PROXY] CONNECT error ${error.message}`);
    clientSocket.destroy();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.error(`[ACP TEST PROXY] listening http://127.0.0.1:${port}`);
});
