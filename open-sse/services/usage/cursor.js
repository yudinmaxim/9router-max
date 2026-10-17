/**
 * Cursor usage — plan quota for the current billing cycle.
 *
 *   POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 *
 * Connect-RPC over HTTP/2, JSON codec, empty request message (`{}`). The same
 * account quota covers both the `cursor` provider (api2 cursor-sh RPC) and the
 * `cursor-acp` provider (the local `cursor-agent` CLI), so both share this reader.
 *
 * Wire notes (each one cost a round-trip to discover):
 *   - HTTP/2 is mandatory — HTTP/1.1 gets 415 from api2 on every route.
 *   - Unary RPCs reject `application/connect+proto` (that is the streaming
 *     encoding); `application/json` is accepted and the response parses as JSON.
 *   - Headers come from buildCursorHeaders() (checksum/client-key/connect headers).
 *   - `api3.cursor.sh` answers a subset of `aiserver.v1.*`; `agent.api5` and
 *     `agentn.api5` do not serve DashboardService at all (404).
 */

import { buildCursorHeaders } from "../../utils/cursorChecksum.js";
import { makeCursorHttp2Request } from "../../utils/cursorHttp2.js";
import { U } from "./shared.js";

// Spend fields arrive in cents (9904 === $99.04), so every money value is scaled
// by 100 before it reaches the dashboard's quota bars.
const CENTS = 100;

// Inlined, not read from the provider registry: the `cursor` api2 entry is
// gone from this fork, but `cursor-acp` still reads its quota through the same
// Connect-RPC call. Connect-RPC over HTTP/2 with the JSON codec — the
// `application/connect+proto` streaming encoding is rejected by this unary
// method.
const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

function num(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

// Cursor sends timestamps as stringified milliseconds ("1789496277000").
function isoDate(value) {
  const ms = num(value, 0);
  if (ms <= 0) return null;
  const date = new Date(ms < 1e12 ? ms * 1000 : ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Build the quota bars the dashboard renders.
 *
 * Cursor reports spend and utilization separately, and the spends do NOT add up to
 * a limit: `included_spend`/`limit` is the money the plan includes ($20 here),
 * `bonus_spend` is provider-subsidised usage ($79.04) that draws on a separate
 * pool, and `total_spend` is their sum ($99.04). Treating any of those as
 * "used of total" renders a full bar on a barely-used account.
 *
 * So the limit bars use the utilization percentages — the same ones Cursor's own
 * UI puts in words ("You've used 21% of your included total usage") — and the
 * dollar amounts are exposed as credit balances, which is what they are.
 */
function buildQuotas(plan, resetAt) {
  const quotas = {};
  if (!plan || typeof plan !== "object") return quotas;

  const totalPercent = num(plan.totalPercentUsed ?? plan.total_percent_used, Number.NaN);
  const apiPercent = num(plan.apiPercentUsed ?? plan.api_percent_used, Number.NaN);
  const autoPercent = num(plan.autoPercentUsed ?? plan.auto_percent_used, Number.NaN);

  const percentBar = (percent) => {
    const clamped = Math.max(0, Math.min(100, percent));
    return {
      used: Number(clamped.toFixed(2)),
      total: 100,
      remaining: Number((100 - clamped).toFixed(2)),
      remainingPercentage: Number((100 - clamped).toFixed(2)),
      resetAt,
      unlimited: false,
    };
  };

  if (Number.isFinite(totalPercent)) quotas["Total usage"] = percentBar(totalPercent);
  if (Number.isFinite(apiPercent)) quotas["API usage"] = percentBar(apiPercent);
  if (Number.isFinite(autoPercent)) quotas["Auto (Composer) usage"] = percentBar(autoPercent);

  const creditBar = (cents) => ({
    used: cents / CENTS,
    total: cents / CENTS,
    remainingPercentage: 0,
    resetAt: null,
    unlimited: true,
    isCreditBalance: true,
    currency: "USD",
  });

  const included = num(plan.includedSpend ?? plan.included_spend);
  const bonus = num(plan.bonusSpend ?? plan.bonus_spend);
  const spent = num(plan.totalSpend ?? plan.total_spend);

  if (included > 0) quotas["Included credit"] = creditBar(included);
  if (bonus > 0) quotas["Bonus credit"] = creditBar(bonus);
  if (spent > 0) quotas["Spent this cycle"] = creditBar(spent);

  return quotas;
}

function parseUsage(data) {
  if (!data || typeof data !== "object") return null;

  const plan = data.planUsage || data.plan_usage || null;
  const resetAt = isoDate(data.billingCycleEnd ?? data.billing_cycle_end);
  const totalPercent = num(
    plan?.totalPercentUsed ?? plan?.total_percent_used,
    Number.NaN
  );

  const plan_name = data.plan || data.planName || null;
  const quotas = buildQuotas(plan, resetAt);

  const result = {
    plan: plan_name || "Cursor",
    quotas,
    spendBars: cursorSpendBars(plan),
  };

  // Surface upstream's own state so the dashboard can warn before a request
  // fails: `enabled:false` with a displayMessage means the account is blocked.
  const displayMessage = data.displayMessage || data.display_message;
  if (displayMessage && (data.enabled === false || totalPercent >= 100)) {
    result.message = String(displayMessage);
  }

  const apiPercent = num(plan?.apiPercentUsed ?? plan?.api_percent_used, Number.NaN);
  if (Number.isFinite(apiPercent) && Number.isFinite(totalPercent)) {
    result.detail = `Total ${totalPercent.toFixed(1)}% · API ${apiPercent.toFixed(1)}% used`;
  }

  return result;
}

/**
 * @param {string|null|undefined} accessToken cursor OAuth access token (or a
 *   `cursor-agent --api-key` value on the cursor-acp connection)
 * @param {object|null} providerSpecificData
 */
/**
 * The three spend bars the Cursor quota widget draws.
 *
 * Cursor's plan usage carries exactly two model-side percentages — auto (its
 * own models, i.e. Auto/Composer) and api (everything else) — plus the cycle
 * total. It reports nothing about a weekly Grok allowance, so that bar is not
 * part of this: it is a separate provider's quota (grok-cli) and is filled in
 * by the caller, which knows whether such a connection exists.
 *
 * Percentages are of Cursor's own cycle allowance, so they are not shares of
 * each other: auto 13.99 and api 14.22 sum to more than total 14.00.
 */
export function cursorSpendBars(plan) {
  const pct = (v) => {
    const n = num(v, Number.NaN);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
  };
  const dollars = (v) => {
    const n = num(v, Number.NaN);
    return Number.isFinite(n) ? Number((n / CENTS).toFixed(2)) : null;
  };
  return {
    cursorModels: { pct: pct(plan?.autoPercentUsed ?? plan?.auto_percent_used), amount: dollars(plan?.bonusSpend ?? plan?.bonus_spend) },
    otherModels: { pct: pct(plan?.apiPercentUsed ?? plan?.api_percent_used), amount: null },
    total: {
      pct: pct(plan?.totalPercentUsed ?? plan?.total_percent_used),
      amount: dollars(plan?.totalSpend ?? plan?.total_spend),
      includedAmount: dollars(plan?.includedSpend ?? plan?.included_spend),
      bonusAmount: dollars(plan?.bonusSpend ?? plan?.bonus_spend),
      limitAmount: dollars(plan?.limit ?? plan?.limit_amount),
      // The percentages are not shares of one allowance: auto 13.99 and api
      // 14.22 both read near 14% and together come to 28.21, well past the
      // 14.00 cycle total, so each is measured against its own denominator —
      // which Cursor does not send. Without this flag the widget cannot tell
      // "13.99%" apart from "13.99% of the cycle".
      denominatorsKnown: false,
    },
  };
}

export async function getCursorUsage(accessToken = null, providerSpecificData = null) {
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!token) {
    return {
      message:
        "No Cursor token on this connection. Cursor quota belongs to the account " +
        "(the local cursor-agent CLI spends the same pool) — add a Cursor API key to this " +
        "connection, or view the limit on the Cursor connection.",
    };
  }

  const machineId = providerSpecificData?.machineId || providerSpecificData?.machine_id || null;
  const endpoint = USAGE_URL;
  if (!endpoint) {
    return { message: "Cursor usage endpoint is not configured in the provider registry." };
  }

  try {
    const response = await makeCursorHttp2Request(
      endpoint,
      {
        ...buildCursorHeaders(token, machineId),
        "content-type": "application/json",
        "accept": "application/json",
      },
      "{}",
      null,
      { timeoutMs: 20000 }
    );

    if (response.status === 401 || response.status === 403) {
      return { plan: "Cursor", message: "Cursor authentication failed. Re-authorize the connection." };
    }
    if (response.status !== 200) {
      const text = response.body?.toString("utf8") || "";
      let message = text.slice(0, 160);
      try {
        message = JSON.parse(text)?.message || message;
      } catch {
        /* keep raw text */
      }
      return { plan: "Cursor", message: `Cursor usage API error (${response.status}): ${message}` };
    }

    let data = null;
    try {
      data = JSON.parse(response.body.toString("utf8"));
    } catch {
      return { plan: "Cursor", message: "Cursor usage response was not JSON." };
    }

    const parsed = parseUsage(data);
    if (!parsed) return { plan: "Cursor", message: "Cursor usage response was empty." };
    return parsed;
  } catch (error) {
    return { message: `Cursor usage error: ${error.message}` };
  }
}

export default getCursorUsage;