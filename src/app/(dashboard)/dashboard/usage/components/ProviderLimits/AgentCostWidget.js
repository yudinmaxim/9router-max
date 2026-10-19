"use client";

/**
 * AgentCostWidget — the quota card for a provider that has no upstream quota.
 *
 * An agent provider (cursor-acp, codex-acp, devin-cli, omp-acp, opencode-acp)
 * runs a CLI on the operator's own subscription. Nothing upstream can be polled
 * for a remainder, so the router's own history is the only true answer it has:
 * requests, tokens, cost, and which models carried the traffic.
 *
 * This widget is for those providers *only*. It is deliberately not a generic
 * fallback: Codex, Claude and Gemini all have real upstream quotas, and
 * showing them this card hid the very windows they came for.
 */

import PropTypes from "prop-types";
import { fmt } from "../UsageTable";
import { computeTierShares } from "@/lib/quotaTiers";

const TIER_LABELS = [
  ["cursorModels", "Cursor Models", "Includes Cursor Grok and Composer"],
  ["otherModels", "Other Models"],
];

export default function AgentCostWidget({ localUsage, translate }) {
  if (!localUsage) return null;

  // Percentages are shares of the total spend, computed once here so every bar
  // is measured against the same denominator.
  const shareData = computeTierShares(localUsage.tiers);
  const shareOf = (key) => shareData.shares[key] || { pct: 0, hasTraffic: false };

  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-lg font-semibold text-text-main">{fmt(localUsage.requests)}</p>
          <p className="text-[10px] text-text-muted">{translate("Requests")}</p>
        </div>
        <div>
          <p className="text-lg font-semibold text-text-main">{fmt(localUsage.promptTokens)}</p>
          <p className="text-[10px] text-text-muted">{translate("Input tokens")}</p>
        </div>
        <div>
          <p className="text-lg font-semibold text-text-main">
            {localUsage.cost > 0 ? `$${localUsage.cost.toFixed(4)}` : "—"}
          </p>
          <p className="text-[10px] text-text-muted">{translate("Cost")}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-black/5 pt-2 dark:border-white/5">
        {TIER_LABELS.map(([key, label, hint]) => {
          const t = (localUsage.tiers || {})[key];
          const { pct, hasTraffic } = shareOf(key);
          return (
            <div key={key} className="flex flex-col gap-1">
              <div className="flex items-start justify-between gap-2 text-[11px]">
                <span className="min-w-0 text-text-muted">
                  {translate(label)}
                  {hint ? <span className="ml-1 text-text-muted/70">· {translate(hint)}</span> : null}
                </span>
                <span className="shrink-0 text-sm font-semibold text-text-main">
                  {hasTraffic ? `${pct}%` : translate("No data")}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${hasTraffic ? Math.max(pct, 2) : 0}%` }}
                />
              </div>
              {hasTraffic ? (
                <span className="text-[10px] text-text-muted/70">
                  {fmt(t.promptTokens + t.completionTokens)} tok · ${t.cost.toFixed(4)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-1 border-t border-black/5 pt-2 text-[11px] dark:border-white/5">
        {(localUsage.models || []).map((m) => (
          <div key={m.model} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-text-muted">
              {m.model}
              <span className="ml-1 text-text-muted/70">· {fmt(m.promptTokens + m.completionTokens)} tok</span>
            </span>
            <span className="shrink-0 text-text-main">
              {m.cost > 0 ? `$${m.cost.toFixed(4)}` : translate("No tariff")}
            </span>
          </div>
        ))}
      </div>

      {/* Grok's weekly allowance exists only on a Cursor plan. Printing a
          "No connection" row for it on every other agent was noise that read
          like a missing measurement. */}
      {localUsage.grokWeekly ? (
        <div className="flex flex-col gap-1 border-t border-black/5 pt-2 text-[11px] dark:border-white/5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-text-muted">{translate("Grok, weekly")}</span>
            <span className="shrink-0 text-sm font-semibold text-text-main">
              {localUsage.grokWeekly.remainingPercentage ?? 0}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${localUsage.grokWeekly.remainingPercentage || 0}%` }}
            />
          </div>
        </div>
      ) : null}

      {!localUsage.fullyPriced && (
        <p className="text-[10px] leading-relaxed text-text-muted">
          {translate(
            "Some models carry no price, so the total understates spend. Set one in Settings → Pricing."
          )}
        </p>
      )}
    </div>
  );
}

AgentCostWidget.propTypes = {
  localUsage: PropTypes.shape({
    requests: PropTypes.number,
    promptTokens: PropTypes.number,
    cost: PropTypes.number,
    tiers: PropTypes.object,
    models: PropTypes.array,
    grokWeekly: PropTypes.object,
    fullyPriced: PropTypes.bool,
  }),
  translate: PropTypes.func.isRequired,
};
