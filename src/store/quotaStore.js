"use client";

/**
 * Quota chips in the header.
 *
 * The store lives here, above the Header, because DashboardLayout renders
 * `<Header key={pathname} />` — the header is torn down and rebuilt on every
 * navigation, so anything holding the poll timer inside it would restart the
 * poll on every page change and hit the provider that much more often. A zustand
 * store is a module singleton, so it survives the remount.
 *
 * The timer is module-level for the same reason: it must outlive any component
 * that started it, and must be clearable when the last one goes.
 */

import { create } from "zustand";
import { QUOTA_HEADER_CONFIG } from "@/shared/constants/config";
import {
  pickHeaderQuotas,
  selectHeaderChips,
  chooseHeaderConnections,
  shortAccountLabel,
} from "@/shared/utils/quota";

let pollTimer = null;
let inFlight = null;

async function loadChips() {
  const listRes = await fetch("/api/providers/client?pageSize=500");
  if (!listRes.ok) return { chips: [], pins: [] };
  const listBody = await listRes.json();
  const connections = Array.isArray(listBody?.connections) ? listBody.connections : [];

  // Connections the operator asked to keep in the header, whatever else the
  // strip has room for. That is a personal choice, not a measurement, so it is
  // read from the settings rather than guessed from the numbers.
  let pinnedIds = [];
  try {
    const settingsRes = await fetch("/api/settings", { cache: "no-store" });
    if (settingsRes.ok) {
      const settings = await settingsRes.json();
      if (Array.isArray(settings?.quotaHeaderPins)) pinnedIds = settings.quotaHeaderPins;
    }
  } catch {
    /* no pins — the automatic choice stands */
  }

  // Which connections earn a chip. A provider normally contributes one — a
  // second Cursor login would just repeat the first chip. But a pinned
  // connection is the operator's own choice and always contributes its own
  // chip: pin one of two Codex accounts and that account is the Codex chip;
  // pin both and the header carries both. A provider with a pinned connection
  // no longer contributes an automatic one, or the operator would see the
  // account they did not ask for next to the one they did.
  const toFetch = chooseHeaderConnections(connections, pinnedIds);

  // One entry per scale, not per connection. Cursor measures its own models and
  // everything else against separate allowances, so collapsing them into one chip
  // would produce a number that belongs to no scale at all.
  const chips = (await Promise.all(
    toFetch.map(async (connection) => {
      const provider = connection.provider;
      try {
        const res = await fetch(`/api/usage/${connection.id}`);
        if (!res.ok) return [];
        const payload = await res.json();
        // The provider is known here, not in the response body: Codex sends its
        // windows keyed by name, so the shape depends on whose they are.
        return pickHeaderQuotas(payload, provider).map((quota) => ({
          // Scoped by connection and label: two scales of one account must not
          // collide on the same React key.
          id: `${connection.id}:${quota.label}`,
          provider,
          connectionId: connection.id,
          pinned: pinnedIds.includes(connection.id),
          label: connection.displayName || connection.name || providerLabel(provider),
          account: shortAccountLabel(connection),
          quota,
        }));
      } catch {
        return [];
      }
    })
  )).flat();

  const sorted = chips.sort((a, b) => {
    // Pinned chips come first: the operator asked for that account to be in
    // the header, so it does not get pushed out by a scale that merely looks
    // closer to running out.
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.quota.remaining - b.quota.remaining;
  });

  // The pins come from the settings, not from the chips: a pinned account whose
  // usage query failed has no chip this round, and its checkbox must still say
  // "always" rather than quietly untick itself.
  return { chips: sorted, pins: pinnedIds };
}

function providerLabel(provider) {
  return String(provider || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const useQuotaStore = create((set, get) => ({
  chips: [],
  loading: false,
  lastFetched: 0,
  visible: false,
  overflow: 0,
  // Connection ids the operator pinned into the header.
  pins: [],

  setVisible: (visible) => {
    if (visible) set({ visible: true });
    else set({ visible: false, chips: [], overflow: 0 });
  },

  /**
   * Pin a connection into the header, or let it go back to the automatic
   * choice. The choice is stored on the router, so it follows the operator to
   * another browser, and the chips are rebuilt straight away.
   */
  setPinned: async (connectionId, pinned) => {
    const current = get().pins;
    const next = pinned
      ? [...new Set([...current, connectionId])]
      : current.filter((id) => id !== connectionId);
    set({ pins: next });
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaHeaderPins: next }),
      });
    } catch {
      /* the header keeps the choice for this session */
    }
    await get().refresh({ force: true });
  },

  refresh: async ({ force = false } = {}) => {
    const { lastFetched } = get();
    if (!force && Date.now() - lastFetched < QUOTA_HEADER_CONFIG.pollIntervalMs) return;
    // Coalesce: a manual refresh landing on top of the scheduled one must not
    // produce two passes over the provider list.
    if (inFlight) return inFlight;

    set({ loading: true });
    inFlight = (async () => {
      try {
        const { chips: all, pins } = await loadChips();
        // A pinned chip is always shown, even when the strip is full: that is
        // what "always" means. The rest fill what is left.
        const { shown, overflow } = selectHeaderChips(all, QUOTA_HEADER_CONFIG.maxChips);
        // When a provider contributes more than one chip — two Codex accounts,
        // say — the scale name is not enough to tell them apart, so the chip
        // names the account instead.
        const perProvider = new Map();
        for (const c of shown) perProvider.set(c.provider, (perProvider.get(c.provider) || 0) + 1);
        set({
          chips: shown.map((c) => ({
            ...c,
            showAccount: (perProvider.get(c.provider) || 0) > 1,
          })),
          overflow,
          pins,
          lastFetched: Date.now(),
        });
      } catch {
        // A failed pass leaves the previous chips in place: stale numbers beat
        // an empty header.
      } finally {
        set({ loading: false });
        inFlight = null;
      }
    })();
    return inFlight;
  },

  start: () => {
    if (pollTimer) return;
    get().refresh({ force: true });
    pollTimer = setInterval(() => get().refresh(), QUOTA_HEADER_CONFIG.pollIntervalMs);
  },

  stop: () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  },
}));