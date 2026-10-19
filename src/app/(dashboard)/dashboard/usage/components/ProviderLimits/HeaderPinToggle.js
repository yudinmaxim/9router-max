"use client";

/**
 * HeaderPinToggle — "always show this one in the header".
 *
 * The header strip normally picks by itself: the scale closest to running out
 * wins the slot, and the rest collapse into a "+N". That is a good default,
 * but it is not the operator's choice — a provider they watch every day can be
 * pushed out by another account that merely looks tighter.
 *
 * So the quota page offers the checkbox: a ticked widget always keeps its place
 * in the header, whatever the numbers say. It is stored on the router, so the
 * choice follows the operator to another browser.
 */

import { useCallback, useState } from "react";
import PropTypes from "prop-types";
import { useQuotaStore } from "@/store/quotaStore";
import { translate } from "@/i18n/runtime";

export default function HeaderPinToggle({ connectionId }) {
  const pins = useQuotaStore((s) => s.pins);
  const setPinned = useQuotaStore((s) => s.setPinned);
  const [busy, setBusy] = useState(false);

  const pinned = pins.includes(connectionId);

  const toggle = useCallback(
    async (e) => {
      e.stopPropagation();
      setBusy(true);
      try {
        await setPinned(connectionId, !pinned);
      } finally {
        setBusy(false);
      }
    },
    [setPinned, connectionId, pinned],
  );

  return (
    <label
      title={translate("Keep this widget in the header, whatever the numbers say")}
      className="flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-black/5 dark:hover:bg-white/5"
    >
      <input
        type="checkbox"
        checked={pinned}
        disabled={busy}
        onChange={toggle}
        aria-label={translate("Always show in header")}
        className="size-3.5 accent-[var(--color-primary)]"
      />
      <span className="hidden lg:inline">{translate("Always")}</span>
    </label>
  );
}

HeaderPinToggle.propTypes = {
  connectionId: PropTypes.string.isRequired,
};
