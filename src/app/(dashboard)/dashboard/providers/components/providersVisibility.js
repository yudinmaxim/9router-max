"use client";

/**
 * Per-user visibility of providers and provider sections.
 *
 * The page lists every provider the registry knows about, which is a lot of
 * scrolling when you only care about a handful. This hides what you are not
 * using right now — at two levels, since the useful granularity differs: a
 * whole section when you never touch that kind of provider, or single cards
 * when you use most of a section but not all of it.
 *
 * Stored in the router settings rather than localStorage so the choice follows
 * you to another browser and survives a cache clear, which is what people
 * expect from "my dashboard". Nothing is ever removed: hidden entries go to a
 * manager panel that lists them and puts them back.
 *
 * Arrays rather than a boolean per id, so adding and removing an id never has
 * to read-modify-write a growing map and "reset" is a single field.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export const EMPTY_VIEW = { hiddenSections: [], hiddenProviders: [] };

const normalize = (value) => ({
  hiddenSections: Array.isArray(value?.hiddenSections) ? value.hiddenSections : [],
  hiddenProviders: Array.isArray(value?.hiddenProviders) ? value.hiddenProviders : [],
});

export function useProvidersVisibility() {
  const [view, setView] = useState(EMPTY_VIEW);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setView(normalize(data.providersView));
      })
      .catch(() => {
        /* defaults stay: everything visible */
      })
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const persist = useCallback((next) => {
    // Debounced: a run of checkbox clicks should be one write, not one per
    // click. Losing the last few hundred milliseconds on a closed tab is an
    // acceptable trade for not hammering the settings table.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providersView: next }),
      }).catch(() => {
        /* the UI already shows the choice; it re-syncs on the next load */
      });
    }, 400);
  }, []);

  const toggleSection = useCallback(
    (sectionId) => {
      setView((prev) => {
        const on = prev.hiddenSections.includes(sectionId);
        const next = {
          ...prev,
          hiddenSections: on
            ? prev.hiddenSections.filter((s) => s !== sectionId)
            : [...prev.hiddenSections, sectionId],
        };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const toggleProvider = useCallback(
    (providerId) => {
      setView((prev) => {
        const on = prev.hiddenProviders.includes(providerId);
        const next = {
          ...prev,
          hiddenProviders: on
            ? prev.hiddenProviders.filter((p) => p !== providerId)
            : [...prev.hiddenProviders, providerId],
        };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const reset = useCallback(() => {
    setView(EMPTY_VIEW);
    persist(EMPTY_VIEW);
  }, [persist]);

  return {
    view,
    loaded,
    isSectionHidden: (id) => view.hiddenSections.includes(id),
    isProviderHidden: (id) => view.hiddenProviders.includes(id),
    toggleSection,
    toggleProvider,
    reset,
  };
}