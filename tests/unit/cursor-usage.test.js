import { describe, it, expect, vi, beforeEach } from "vitest";

const { h2Mock } = vi.hoisted(() => ({ h2Mock: vi.fn() }));

vi.mock("open-sse/utils/cursorHttp2.js", () => ({
  makeCursorHttp2Request: (...args) => h2Mock(...args),
}));

const { getCursorUsage } = await import("open-sse/services/usage/cursor.js");

// Shape returned by a real cursor-agent 2026.07 account, cents for money.
const REAL_RESPONSE = {
  billingCycleStart: "1789496277000",
  billingCycleEnd: "1792088277000",
  planUsage: {
    totalSpend: 9904,
    includedSpend: 2000,
    bonusSpend: 7904,
    limit: 2000,
    remainingBonus: false,
    bonusTooltip: "We work with model providers to give you free usage beyond what you've purchased.",
    autoPercentUsed: 21.982222222222223,
    apiPercentUsed: 1.0666666666666667,
    totalPercentUsed: 21.47208672086721,
  },
  spendLimitUsage: { limitType: "user" },
  displayThreshold: 200,
  enabled: true,
  displayMessage: "You've hit your usage limit",
  autoModelSelectedDisplayMessage: "You've used 21% of your included total usage",
  namedModelSelectedDisplayMessage: "You've used 1% of your included API usage",
};

const okJson = (data) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(data)) });

beforeEach(() => {
  h2Mock.mockReset();
});

describe("getCursorUsage request", () => {
  it("calls the registry usage URL over the JSON codec with cursor headers", async () => {
    h2Mock.mockResolvedValue(okJson(REAL_RESPONSE));
    await getCursorUsage("tok-123", { machineId: "m-9" });

    const [url, headers, body] = h2Mock.mock.calls[0];
    expect(url).toBe("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
    // Unary RPC: the streaming connect+proto encoding gets 415 here.
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["connect-protocol-version"]).toBe("1");
    expect(headers.authorization).toContain("Bearer");
    expect(body).toBe("{}");
  });

  it("reports a missing token instead of calling out", async () => {
    const res = await getCursorUsage(null, null);
    expect(h2Mock).not.toHaveBeenCalled();
    expect(res.message).toMatch(/Cursor quota belongs to the account/);
  });

  it("treats an empty/whitespace token as missing", async () => {
    expect((await getCursorUsage("   ", null)).message).toMatch(/No Cursor token/);
    expect(h2Mock).not.toHaveBeenCalled();
  });

  it("strips cursor's ::token prefix before sending", async () => {
    h2Mock.mockResolvedValue(okJson(REAL_RESPONSE));
    await getCursorUsage("::prefixed-token", null);
    expect(h2Mock.mock.calls[0][1].authorization).toBe("Bearer prefixed-token");
  });
});

describe("getCursorUsage quota mapping", () => {
  it("maps utilization percentages onto 0-100 bars", async () => {
    h2Mock.mockResolvedValue(okJson(REAL_RESPONSE));
    const { quotas } = await getCursorUsage("tok", null);

    expect(quotas["Total usage"].used).toBeCloseTo(21.47, 2);
    expect(quotas["Total usage"].total).toBe(100);
    expect(quotas["Total usage"].remainingPercentage).toBeCloseTo(78.53, 2);
    expect(quotas["API usage"].used).toBeCloseTo(1.07, 2);
    expect(quotas["Auto (Composer) usage"].used).toBeCloseTo(21.98, 2);
  });

  it("converts cents to currency units on the credit bars", async () => {
    h2Mock.mockResolvedValue(okJson(REAL_RESPONSE));
    const { quotas } = await getCursorUsage("tok", null);

    expect(quotas["Included credit"].used).toBe(20);
    expect(quotas["Bonus credit"].used).toBeCloseTo(79.04, 2);
    expect(quotas["Spent this cycle"].used).toBeCloseTo(99.04, 2);
    for (const key of ["Included credit", "Bonus credit", "Spent this cycle"]) {
      expect(quotas[key].isCreditBalance).toBe(true);
      expect(quotas[key].currency).toBe("USD");
    }
  });

  it("never presents a fully-used bar on a barely-used account", async () => {
    // includedSpend == limit == $20, so folding spends into a used/total pair
    // would render 100% while cursor itself reports 21%.
    h2Mock.mockResolvedValue(okJson(REAL_RESPONSE));
    const { quotas } = await getCursorUsage("tok", null);

    for (const [key, bar] of Object.entries(quotas)) {
      if (bar.isCreditBalance) continue;
      expect(bar.used, key).toBeLessThan(bar.total);
    }
  });

  it("puts the billing-cycle end on the limit bars as resetAt", async () => {
    h2Mock.mockResolvedValue(okJson(REAL_RESPONSE));
    const { quotas } = await getCursorUsage("tok", null);
    expect(quotas["Total usage"].resetAt).toBe("2026-10-15T18:17:57.000Z");
  });

  it("omits bars whose numbers the account did not report", async () => {
    h2Mock.mockResolvedValue(okJson({ planUsage: { includedSpend: 2000 } }));
    const { quotas } = await getCursorUsage("tok", null);
    expect(Object.keys(quotas)).toEqual(["Included credit"]);
  });

  it("accepts snake_case field names", async () => {
    h2Mock.mockResolvedValue(
      okJson({
        billing_cycle_end: "1792088277000",
        plan_usage: { total_percent_used: 50, api_percent_used: 25, total_spend: 500 },
      })
    );
    const { quotas } = await getCursorUsage("tok", null);
    expect(quotas["Total usage"].used).toBe(50);
    expect(quotas["API usage"].used).toBe(25);
    expect(quotas["Spent this cycle"].used).toBe(5);
    expect(quotas["Total usage"].resetAt).toBe("2026-10-15T18:17:57.000Z");
  });

  it("surfaces the display message when the account is blocked", async () => {
    h2Mock.mockResolvedValue(okJson({ ...REAL_RESPONSE, enabled: false }));
    const res = await getCursorUsage("tok", null);
    expect(res.message).toBe("You've hit your usage limit");
  });

  it("stays quiet about displayMessage while the account is healthy", async () => {
    h2Mock.mockResolvedValue(okJson(REAL_RESPONSE));
    const res = await getCursorUsage("tok", null);
    expect(res.message).toBeUndefined();
    expect(res.detail).toBe("Total 21.5% · API 1.1% used");
  });
});

describe("getCursorUsage failures", () => {
  it("flags auth failures for the reconnect path", async () => {
    h2Mock.mockResolvedValue({ status: 401, headers: {}, body: Buffer.from("") });
    const res = await getCursorUsage("tok", null);
    expect(res.message).toMatch(/authentication failed/i);
  });

  it("includes the upstream status and body on other errors", async () => {
    h2Mock.mockResolvedValue({ status: 500, headers: {}, body: Buffer.from("boom") });
    const res = await getCursorUsage("tok", null);
    expect(res.message).toMatch(/error \(500\): boom/);
  });

  it("prefers the structured message out of an error body", async () => {
    h2Mock.mockResolvedValue({
      status: 400,
      headers: {},
      body: Buffer.from(JSON.stringify({ message: "invalid team_id" })),
    });
    const res = await getCursorUsage("tok", null);
    expect(res.message).toMatch(/invalid team_id/);
  });

  it("handles a non-JSON body", async () => {
    h2Mock.mockResolvedValue({ status: 200, headers: {}, body: Buffer.from("<html>") });
    const res = await getCursorUsage("tok", null);
    expect(res.message).toMatch(/not JSON/);
  });

  it("wraps transport errors instead of throwing", async () => {
    h2Mock.mockRejectedValue(new Error("HTTP/2 request timed out"));
    const res = await getCursorUsage("tok", null);
    expect(res.message).toMatch(/timed out/);
  });
});