import React from "react";

/**
 * The Cursor quota widget — money first, then each model group on its own scale.
 *
 * Every provider gets its own widget here; this one is Cursor's.
 *
 * The plan limits come as one sentence worth telling: $20 of included credit
 * spent against $20 included, $44.72 paid from bonus, `remainingBonus: false`
 * meaning there is no bonus left. Read as three unrelated numbers this looks
 * like a contradiction, so the widget groups them the way the account does.
 *
 * The two model bars deliberately do not share a scale. Cursor measures auto
 * (its own models) and api (everything else) against separate allowances — both
 * read near 14% while the cycle total reads 14.00, and together they reach 28.2,
 * which only works if they are measured separately. The denominators are not
 * sent, so the bars are never added up or renormalised.
 *
 * Money comes from Cursor and is authoritative. The router's own history is not
 * used for it: locally the same period prices out at a few thousandths of a
 * dollar, because most routed models carry no tariff.
 */
const money = (v) => (typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(2)}` : null);

function Row({ label, value, muted, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className={strong ? "text-text-secondary" : "text-text-muted"}>{label}</span>
      <span className={strong ? "font-medium tabular-nums text-text" : "tabular-nums text-text-secondary"}>
        {value == null ? (muted ?? "—") : value}
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

export default function CursorQuotaWidget({ spendBars, planLimits, grokPool, translate }) {
  if (!spendBars) return null;
  const limits = planLimits || null;
  const cycleEnd = limits?.cycleEnd
    ? new Date(limits.cycleEnd).toLocaleDateString(translate("ru-RU"))
    : null;

  return (
    <div className="flex flex-col gap-4 py-1">
      {limits?.membership && (
        <p className="text-[11px] text-text-secondary">
          {limits.membership}
          {limits.price ? ` · ${limits.price}` : ""}
          {cycleEnd ? ` · ${translate("until")} ${cycleEnd}` : ""}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <Row label={translate("Spent this cycle")} value={money(limits?.totalSpend ?? spendBars?.total?.amount)} strong />
        <Row
          label={translate("Included credit")}
          value={
            limits?.includedUsed != null
              ? `${money(limits.includedUsed)}${limits.includedLimit != null ? ` / ${money(limits.includedLimit)}` : ""}`
              : money(spendBars?.total?.includedAmount)
          }
        />
        <Row
          label={translate("Included credit left")}
          value={money(limits?.includedRemaining)}
          muted={translate("unknown")}
        />
        <Row
          label={translate("Bonus credit")}
          value={
            limits?.bonusUsed != null
              ? `${money(limits.bonusUsed)}${limits.bonusRemaining === false ? ` · ${translate("exhausted")}` : ""}`
              : money(spendBars?.total?.bonusAmount)
          }
        />
      </div>

      <div className="flex flex-col gap-3 border-t border-black/5 pt-3 dark:border-white/5">
        <AllowBar
          label={translate("Cursor models")}
          pct={spendBars?.cursorModels?.pct}
          note={translate("Composer and Grok, on Cursor's own allowance")}
        />
        <AllowBar
          label={translate("Other models")}
          pct={spendBars?.otherModels?.pct}
          note={translate("Named models, on a separate allowance")}
        />
        <AllowBar
          label={grokPool?.label || translate("Grok Bot")}
          pct={grokPool?.pct}
          muted={translate("Not reported by Cursor")}
          note={[
            grokPool?.includedInPlan
              ? translate("Included in ") + grokPool.includedInPlan
              : null,
            grokPool?.resetsWeekly ? translate("resets weekly") : null,
            grokPool?.hasAvailableUsage === false ? translate("paused at the limit") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      </div>

      <p className="text-[10px] leading-relaxed text-text-muted">
        {translate(
          "Each bar is measured against its own allowance, so the percentages do not add up to the cycle total."
        )}
      </p>
    </div>
  );
}