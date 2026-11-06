// NINEROUTER_TRUSTED_PEERS: bridge gateway addresses should be treated as
// local equivalents for LOCAL_ONLY_PATHS without creating a spoofing hole.
// The peer IP is stamped by custom-server.js from the TCP socket, so it is
// the unspoofable socket peer, not something a client can forge.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const { proxy } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";

// /api/headroom/start spawns the compression proxy child process, so it sits
// in LOCAL_ONLY_PATHS and is the route this feature exists to unblock.
const LOCAL_ONLY = "/api/headroom/start";

function request(pathname, headers = {}) {
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: new Headers(headers),
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

describe("trusted peer addresses (NINEROUTER_TRUSTED_PEERS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    process.env.NINEROUTER_TRUSTED_PEERS = "172.20.0.1";
    process.env.NODE_ENV = "production";
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.NINEROUTER_PEER_TOKEN;
    delete process.env.NINEROUTER_TRUSTED_PEERS;
  });

  it("allows the stamped bridge gateway on a local-only route", async () => {
    const response = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "172.20.0.1",
      "x-9r-peer-token": PEER_TOKEN,
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("matches a peer inside a CIDR range", async () => {
    process.env.NINEROUTER_TRUSTED_PEERS = "172.20.0.0/24";

    const response = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "172.20.0.50",
      "x-9r-peer-token": PEER_TOKEN,
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("refuses a peer outside the configured single address", async () => {
    const response = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "172.20.0.50",
      "x-9r-peer-token": PEER_TOKEN,
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("refuses a peer outside the configured CIDR", async () => {
    process.env.NINEROUTER_TRUSTED_PEERS = "172.20.0.0/24";

    const response = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "172.21.0.50",
      "x-9r-peer-token": PEER_TOKEN,
    }));

    expect(response.status).toBe(403);
  });

  it("still requires the peer token proof for a trusted address", async () => {
    const response = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "172.20.0.1",
    }));

    expect(response.status).toBe(403);
  });

  it("keeps loopback working when no trusted peers are configured", async () => {
    delete process.env.NINEROUTER_TRUSTED_PEERS;

    const response = await proxy(request(LOCAL_ONLY, {
      host: "localhost:20129",
      "x-9r-real-ip": "127.0.0.1",
      "x-9r-peer-token": PEER_TOKEN,
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("treats the ::ffff-mapped form of a trusted peer as local", async () => {
    const response = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "::ffff:172.20.0.1",
      "x-9r-peer-token": PEER_TOKEN,
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("never trusts an IPv6-only address via the IPv4 matcher", async () => {
    process.env.NINEROUTER_TRUSTED_PEERS = "2001:db8::1";

    const response = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "2001:db8::1",
      "x-9r-peer-token": PEER_TOKEN,
    }));

    expect(response.status).toBe(403);
  });

  it("ignores malformed entries but keeps valid ones", async () => {
    process.env.NINEROUTER_TRUSTED_PEERS = "not-an-ip, 172.20.0.1/33, 999.1.1.1, 172.20.0.1";

    const response = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "172.20.0.1",
      "x-9r-peer-token": PEER_TOKEN,
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("re-reads the env after it changes (cache is keyed on the raw value)", async () => {
    process.env.NINEROUTER_TRUSTED_PEERS = "";

    const blocked = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "172.20.0.1",
      "x-9r-peer-token": PEER_TOKEN,
    }));
    expect(blocked.status).toBe(403);

    process.env.NINEROUTER_TRUSTED_PEERS = "172.20.0.1";

    const allowed = await proxy(request(LOCAL_ONLY, {
      host: "127.0.0.1:20129",
      "x-9r-real-ip": "172.20.0.1",
      "x-9r-peer-token": PEER_TOKEN,
    }));
    expect(allowed).toBe(mocks.nextResponse);
  });

  it("does not widen access for an unauthenticated remote peer on a normal API route", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);

    const response = await proxy(request("/api/providers", {
      host: "203.0.113.9:20129",
      "x-9r-real-ip": "203.0.113.9",
      "x-9r-peer-token": PEER_TOKEN,
    }));

    expect(response.status).toBe(401);
  });
});
