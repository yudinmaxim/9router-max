"use client";

/**
 * Quota chips in the header.
 *
 * One chip per provider showing the number that is closest to running out. The
 * reasoning for picking the tightest row rather than the first one lives in
 * `pickHeaderQuotas`; the short version is that a chip whose job is to flag risk
 * and which reports a healthy account is a chip nobody reads, and that one
 * account can own more than one scale — see that function for why Cursor needs
 * two chips rather than one averaged one.
 *
 * The Header is remounted on every navigation (`<Header key={pathname} />` in
 * DashboardLayout), so this component holds no state of its own — everything
 * comes from the store, which is a module singleton and survives the remount.
 */

import { useQuotaStore } from "@/store/quotaStore";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Tooltip from "@/shared/components/Tooltip";
import { getQuotaColors, formatResetTime } from "@/shared/utils/quota";

function Chip({ chip }) {
  const { provider, label, quota } = chip;
  const colors = getQuotaColors(quota.remaining);
  const tooltip = [
    `${label} · ${quota.label}`,
    `${quota.spent}% spent, ${quota.remaining}% left`,
    quota.resetAt ? `· resets in ${formatResetTime(quota.resetAt)}` : null,
  ].filter(Boolean).join(" ");

  return (
    <Tooltip text={tooltip}>
      <div
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface/70 px-2 text-xs ${colors.text}`}
        aria-label={`${label}, ${quota.label}: ${quota.spent} percent spent, ${quota.remaining} percent left`}
      >
        <ProviderIcon
          src={`/providers/${provider}.png`}
          alt={provider}
          size={16}
          className="size-4 shrink-0 rounded object-contain"
          fallbackText={provider?.slice(0, 2).toUpperCase() || "PR"}
        />
        {/* Two Cursor scales render the same numbers, so the scale name has to be
            readable somewhere — but only where there is room for it. Below `lg`
            the name drops and the numbers stay, because a chip that disappears
            on a narrow window is worse than a chip without a caption. `.lg\:flex`
            sits inside `@media (min-width:64rem)`, so gating the whole chip on it
            hid the feature outright at 1023px. */}
        <span className="hidden max-w-[92px] truncate text-text-secondary lg:inline">
          {quota.label}
        </span>
        <span className="whitespace-nowrap tabular-nums font-medium">
          {quota.spent}% <span className="text-text-muted">→</span> {quota.remaining}%
        </span>
      </div>
    </Tooltip>
  );
}

export default function QuotaChips() {
  const chips = useQuotaStore((s) => s.chips);
  const overflow = useQuotaStore((s) => s.overflow);
  if (!chips.length && !overflow) return null;

  return (
    <>
      {chips.map((chip) => (
        <Chip key={chip.id} chip={chip} />
      ))}
      {overflow > 0 && (
        <Tooltip text={`${overflow} more account(s) — open the Quota page`}>
          <div className="flex h-8 shrink-0 items-center rounded-lg border border-border-subtle bg-surface/70 px-2 text-xs text-text-muted tabular-nums">
            +{overflow}
          </div>
        </Tooltip>
      )}
    </>
  );
}