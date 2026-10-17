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

/**
 * One scale, both directions: `14% → 86%`.
 *
 * Cursor reports what was spent, so "14%" on its own is the answer to a question
 * nobody asked — it reads as "barely used" when it is a fifth of the month gone.
 * Its complement is on the same allowance, so the pair costs nothing to compute
 * and leaves no room to misread which way the bar runs. The bar itself still
 * fills to `spent`, because that is the number being spent.
 *
 * A bar with no denominator keeps its own note, and the two are never added:
 * they are separate allowances, so their sum is a figure Cursor never stated.
 */
function AllowBar({ label, pct, note, muted }) {
  const known = typeof pct === "number" && Number.isFinite(pct);
  const spent = known ? Math.max(0, Math.min(100, pct)) : null;
  const left = spent == null ? null : Math.max(0, Math.min(100, 100 - spent));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-[11px]">
        <span className="text-text-muted">{label}</span>
        <span className="whitespace-nowrap tabular-nums text-text-secondary">
          {known ? `${spent}% → ${left}%` : (muted ?? "—")}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${spent ?? 0}%` }}
        />
      </div>
      {note ? <p className="text-[10px] leading-relaxed text-text-muted">{note}</p> : null}
    </div>
  );
}

export default function CursorQuotaWidget({ spendBars, planLimits, translate }) {
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
      </div>

      <p className="text-[10px] leading-relaxed text-text-muted">
        {translate(
          "Each bar is measured against its own allowance, so the percentages do not add up to the cycle total."
        )}
      </p>
    </div>
  );
}