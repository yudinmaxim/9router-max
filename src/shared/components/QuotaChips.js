"use client";

/**
 * Quota chips in the header.
 *
 * One chip per provider showing the number that is closest to running out. The
 * reasoning for picking the tightest row rather than the first one lives in
 * `pickHeaderQuota`; the short version is that a chip whose job is to flag risk
 * and which reports a healthy account is a chip nobody reads.
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
    `${label}: ${quota.remaining}% left`,
    quota.label ? `· ${quota.label}` : null,
    quota.resetAt ? `· resets in ${formatResetTime(quota.resetAt)}` : null,
  ].filter(Boolean).join(" ");

  return (
    <Tooltip text={tooltip}>
      <div
        className={`hidden lg:flex h-8 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface/70 px-2 text-xs ${colors.text}`}
        aria-label={`${label} quota ${quota.remaining}% remaining`}
      >
        <ProviderIcon
          src={`/providers/${provider}.png`}
          alt={provider}
          size={16}
          className="size-4 rounded object-contain"
          fallbackText={provider?.slice(0, 2).toUpperCase() || "PR"}
        />
        <span className="tabular-nums font-medium">{quota.remaining}%</span>
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
          <div className="hidden lg:flex h-8 items-center rounded-lg border border-border-subtle bg-surface/70 px-2 text-xs text-text-muted tabular-nums">
            +{overflow}
          </div>
        </Tooltip>
      )}
    </>
  );
}