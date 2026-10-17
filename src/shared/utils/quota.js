/**
 * Quota formatting — the parts of `ProviderLimits/utils.js` that do not need the
 * model catalogue.
 *
 * They live apart because the header chips need them on every dashboard page:
 * `utils.js` imports `open-sse/config/providerModels.js`, and pulling the whole
 * model matrix into the shared header bundle to read a percentage is a bad trade.
 * The originals stay exported from `utils.js`, so existing imports are unchanged.
 */

/**
 * Format ISO date string to countdown format (inspired by vscode-antigravity-cockpit)
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted countdown (e.g., "2d 5h 30m", "4h 40m", "15m") or "-"
 */
export function formatResetTime(date) {
  if (!date) return "-";

  try {
    const resetDate = typeof date === "string" ? new Date(date) : date;
    const now = new Date();
    const diffMs = resetDate - now;

    // `new Date("nonsense")` does not throw — it yields an Invalid Date, and
    // subtracting it produces NaN. Every comparison below is false for NaN, so
    // the code used to walk past all of them and print "NaNd NaNh NaNm". The
    // try/catch never fired. A provider is free to send a malformed resetAt, and
    // the header chip renders this into its tooltip.
    if (!Number.isFinite(diffMs)) return "-";
    if (diffMs <= 0) return "-";

    const totalMinutes = Math.ceil(diffMs / (1000 * 60));
    
    // < 60 minutes: show only minutes
    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }
    
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    
    // < 24 hours: show hours and minutes
    if (totalHours < 24) {
      return `${totalHours}h ${remainingMinutes}m`;
    }
    
    // >= 24 hours: show days, hours, and minutes
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  } catch (error) {
    return "-";
  }
}
/**
 * What the header chips should show for one connection.
 *
 * Returns a list, because one connection can own more than one scale. Cursor is
 * the case that forces it: it measures its own models (auto) and everything else
 * (api) against separate allowances, both read near 14% while the cycle total
 * reads 14.0. Collapse those two into a single chip and the number becomes
 * meaningless — the operator cannot tell which scale ran down, and there is no
 * honest way to average them into one. Two scales, two chips.
 *
 * Both directions are reported, `spent` and `remaining`. `spent` is what the
 * provider states and `remaining` is its complement on the *same* scale, so
 * showing both is arithmetic rather than interpretation. What cannot be done is
 * combining two different scales, and nothing here does.
 *
 *   - Cursor-style (`spendBars`): one chip per bar, plus the cycle total when
 *     there is one.
 *   - everything else: the row with the least left. A chip exists to flag what is
 *     about to run out; showing the healthiest row would be the one number the
 *     operator does not need. Unlimited rows are skipped — they never run out,
 *     so they can never be the tightest.
 *
 * @returns {Array<{label: string, spent: number, remaining: number, resetAt: ?string}>}
 */
export function pickHeaderQuotas(payload) {
  if (!payload || typeof payload !== "object") return [];

  const bars = payload.spendBars;
  const cycleEnd = payload.planLimits?.cycleEnd || null;
  const out = [];

  const asChip = (label, spent) => ({
    label,
    spent: clampPercent(spent),
    remaining: clampPercent(100 - spent),
    resetAt: cycleEnd,
  });

  if (bars?.cursorModels && Number.isFinite(bars.cursorModels.pct)) {
    out.push(asChip("Cursor models", bars.cursorModels.pct));
  }
  if (bars?.otherModels && Number.isFinite(bars.otherModels.pct)) {
    out.push(asChip("Other models", bars.otherModels.pct));
  }
  if (out.length === 0 && bars?.total && Number.isFinite(bars.total.pct)) {
    out.push(asChip(payload.plan || "Plan", bars.total.pct));
  }
  if (out.length > 0) return out;

  const rows = Array.isArray(payload.quotas) ? payload.quotas : [];
  let tightest = null;
  for (const row of rows) {
    if (!row || row.unlimited) continue;
    const remaining = getRemainingPercentage(row);
    if (!Number.isFinite(remaining)) continue;
    if (!tightest || remaining < tightest.remaining) {
      tightest = { label: row.name || "quota", remaining, resetAt: row.resetAt || null };
    }
  }
  if (!tightest) return [];
  return [{ ...tightest, spent: clampPercent(100 - tightest.remaining) }];
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Tailwind color classes for a remaining-percentage, in one place.
 *
 * The map was written out three times — `QuotaTable.js`, `QuotaProgressBar.js`
 * and here — and the copies had already drifted: the table used the
 * `dark:` variants of the text colors while the bar used the plain ones, so the
 * same quota rendered green in one card and a different green in the next. The
 * only real difference between the two call sites was that `dark` variants, so
 * that is the one option left.
 *
 * `getStatusColor` and `getStatusEmoji` stay as the bare-name versions for
 * callers that need only the word or the dot.
 *
 * @param {number} percentage Remaining percentage (0-100)
 * @param {{dark?: boolean}} [opts] `dark: true` returns `dark:` text variants
 */
export function getQuotaColors(percentage, { dark = false } = {}) {
  const tone = (name) => ({
    text: dark ? `text-${name}-600 dark:text-${name}-400` : `text-${name}-500`,
    bg: `bg-${name}-500`,
    bgLight: `bg-${name}-500/10`,
    emoji: STATUS_EMOJI[name],
  });

  if (percentage > 70) return tone("green");
  if (percentage >= 30) return tone("yellow");
  return tone("red"); // 0-29% including 0% (out of quota)
}

const STATUS_EMOJI = { green: "🟢", yellow: "🟡", red: "🔴" };

/**
 * Get Tailwind color class based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Color name: "green" | "yellow" | "red"
 */
export function getStatusColor(percentage) {
  if (percentage > 70) return "green";
  if (percentage >= 30) return "yellow";
  return "red"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Get status emoji based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Emoji: "🟢" | "🟡" | "🔴"
 */
export function getStatusEmoji(percentage) {
  if (percentage > 70) return "🟢";
  if (percentage >= 30) return "🟡";
  return "🔴"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Calculate remaining percentage
 * @param {number} used - Used amount
 * @param {number} total - Total amount
 * @returns {number} Remaining percentage (0-100)
 */
export function calculatePercentage(used, total) {
  if (!total || total === 0) return 0;
  if (!used || used < 0) return 100;
  if (used >= total) return 0;

  return Math.round(((total - used) / total) * 100);
}

/**
 * Get remaining percentage from a normalized quota row
 * @param {Object} quota - Normalized quota object
 * @returns {number} Remaining percentage (0-100)
 */
export function getRemainingPercentage(quota) {
  if (quota?.remaining !== undefined) {
    return Math.max(0, Math.round(quota.remaining));
  }

  if (quota?.remainingPercentage !== undefined) {
    return Math.round(quota.remainingPercentage);
  }

  return calculatePercentage(quota?.used, quota?.total);
}
