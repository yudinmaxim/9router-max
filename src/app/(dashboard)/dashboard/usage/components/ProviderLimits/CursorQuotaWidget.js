import React from "react";

/**
 * The Cursor quota widget — numbers first.
 *
 * Every provider gets its own widget here; this one is Cursor's. It answers the
 * only two questions that matter: how much money the cycle has cost, and how
 * each model group is doing against its own allowance.
 *
 * The three bars deliberately do not share a scale. Cursor measures `auto`
 * (its own models) and `api` (everything else) against separate denominators —
 * both read ~14% while the cycle total reads 14.00%, which is only possible if
 * they are measured separately. Cursor sends no denominator, so the widget shows
 * the percentages as its own bar and never adds them up, renormalises them, or
 * presents them as slices of one whole.
 *
 * Money comes from Cursor and is authoritative. The router's own history is not
 * used for it: locally the same period prices out at a few thousandths of a
 * dollar, because most routed models carry no tariff, so a locally-derived
 * split would contradict the number Cursor actually charges.
 */
function Money({ label, value, muted, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className={strong ? "text-text-secondary" : "text-text-muted"}>{label}</span>
      <span className={strong ? "font-medium tabular-nums text-text" : "tabular-nums text-text-secondary"}>
        {value == null ? (muted ?? "—") : `$${value.toFixed(2)}`}
      </span>
    </div>
  );
}

function AllowBar({ label, pct, note, muted }) {
  const known = typeof pct === "number" && Number.isFinite(pct);
  const value = known ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-[11px]">
        <span className="text-text-muted">{label}</span>
        <span className="tabular-nums text-text-secondary">
          {known ? `${value}%` : (muted ?? "—")}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${value}%` }} />
      </div>
      {note ? <p className="text-[10px] leading-relaxed text-text-muted">{note}</p> : null}
    </div>
  );
}

export default function CursorQuotaWidget({ spendBars, translate }) {
  const totals = spendBars?.total || null;
  if (!spendBars) return null;

  return (
    <div className="flex flex-col gap-4 py-1">
      <div className="flex flex-col gap-1">
        <Money label={translate("Spent this cycle")} value={totals?.amount} strong />
        <Money label={translate("Included in plan")} value={totals?.includedAmount} />
        <Money label={translate("Bonus credit")} value={totals?.bonusAmount} />
        <Money label={translate("Plan limit")} value={totals?.limitAmount} />
      </div>

      <div className="flex flex-col gap-3 border-t border-black/5 pt-3 dark:border-white/5">
        <AllowBar
          label={translate("Cursor models")}
          pct={spendBars?.cursorModels?.pct}
          note={translate("Measured against Cursor's own allowance")}
        />
        <AllowBar
          label={translate("Other models")}
          pct={spendBars?.otherModels?.pct}
          note={translate("Measured against a separate allowance")}
        />
        <AllowBar
          label={translate("Grok, weekly")}
          pct={spendBars?.grokWeekly?.pct}
          muted={translate("Not reported by Cursor")}
          note={translate("Cursor's billing API does not send this allowance yet")}
        />
      </div>

      {totals?.denominatorsKnown === false && (
        <p className="text-[10px] leading-relaxed text-text-muted">
          {translate(
            "Each bar is measured against its own allowance, so the percentages do not add up to the cycle total."
          )}
        </p>
      )}
    </div>
  );
}