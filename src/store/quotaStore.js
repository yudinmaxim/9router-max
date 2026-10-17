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
import { pickHeaderQuota } from "@/shared/utils/quota";

let pollTimer = null;
let inFlight = null;

async function loadChips() {
  const listRes = await fetch("/api/providers/client?limit=500");
  if (!listRes.ok) return [];
  const listBody = await listRes.json();
  const connections = Array.isArray(listBody?.connections) ? listBody.connections : [];

  // One account per provider is enough for a header strip; a second Cursor login
  // would just repeat the first chip. Sorted so the visible subset is stable
  // across polls and does not shuffle under the cursor.
  const byProvider = new Map();
  for (const c of connections) {
    if (c?.isActive === false) continue;
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, c);
  }

  const chips = await Promise.all(
    [...byProvider.entries()].map(async ([provider, connection]) => {
      try {
        const res = await fetch(`/api/usage/${connection.id}`);
        if (!res.ok) return null;
        const payload = await res.json();
        const quota = pickHeaderQuota(payload);
        if (!quota) return null;
        return {
          id: connection.id,
          provider,
          label: connection.displayName || connection.name || providerLabel(provider),
          quota,
        };
      } catch {
        return null;
      }
    })
  );

  return chips.filter(Boolean).sort((a, b) => a.quota.remaining - b.quota.remaining);
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

  setVisible: (visible) => {
    if (visible) set({ visible: true });
    else set({ visible: false, chips: [], overflow: 0 });
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
        const all = await loadChips();
        set({
          chips: all.slice(0, QUOTA_HEADER_CONFIG.maxChips),
          overflow: Math.max(0, all.length - QUOTA_HEADER_CONFIG.maxChips),
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