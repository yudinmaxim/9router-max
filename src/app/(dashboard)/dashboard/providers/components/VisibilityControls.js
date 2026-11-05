"use client";

/**
 * Visibility controls for the providers page.
 *
 * Hiding is only useful if unhiding is just as easy, so nothing disappears
 * silently: a hidden section collapses to a one-line bar naming it, and the
 * manager opens a tree where every provider has a checkbox, whatever its
 * current state.
 *
 * The tree mirrors the page: a section is a branch, its providers are leaves.
 * A branch checkbox is tri-state — checked only when the section is visible and
 * every provider inside it is too — so one click either shows the whole branch
 * or puts it away, without a separate "select all" control nobody would find.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";

/** Section ids, matching what the page passes to useProvidersVisibility(). */
export const SECTION_IDS = {
  compatible: "Custom Providers",
  oauth: "OAuth Providers",
  localAgents: "Local Agents",
  free: "Free Tier Providers",
  apikey: "API Key Providers",
};

export function SectionVisibilityBar({ sectionId, count, onShow }) {
  const label = SECTION_IDS[sectionId] || sectionId;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-text-muted">
      <span className="material-symbols-outlined text-[15px]">visibility_off</span>
      <span className="flex-1 truncate">
        <span className="font-medium text-text-main">{label}</span> hidden
        {count ? ` · ${count} provider${count === 1 ? "" : "s"}` : ""}
      </span>
      <button
        type="button"
        onClick={onShow}
        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] transition-colors hover:border-primary/40 hover:text-text-main"
      >
        <span className="material-symbols-outlined text-[13px]">visibility</span>
        Show
      </button>
    </div>
  );
}

SectionVisibilityBar.propTypes = {
  sectionId: PropTypes.string.isRequired,
  count: PropTypes.number,
  onShow: PropTypes.func.isRequired,
};

function Checkbox({ checked, indeterminate, onChange, label, description, indent = 0 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);

  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface ${indent ? "ml-5" : ""}`}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-[2px] accent-[var(--color-primary)]"
      />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-xs ${indent ? "text-text-muted" : "font-medium text-text-main"}`}>
          {label}
        </span>
        {description && <span className="block truncate text-[11px] text-text-muted">{description}</span>}
      </span>
    </label>
  );
}

Checkbox.propTypes = {
  checked: PropTypes.bool.isRequired,
  indeterminate: PropTypes.bool,
  onChange: PropTypes.func.isRequired,
  label: PropTypes.string.isRequired,
  description: PropTypes.string,
  indent: PropTypes.number,
};

export function VisibilityTreeMenu({ tree, isSectionHidden, isProviderHidden, onToggleSection, onToggleProvider, onReset }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const hiddenCount = useMemo(
    () =>
      tree.filter((s) => isSectionHidden(s.id)).length +
      tree.reduce((n, s) => n + s.providers.filter((p) => isProviderHidden(p.id)).length, 0),
    [tree, isSectionHidden, isProviderHidden],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  // Showing a branch has to bring its providers back too, otherwise the section
  // would come back empty and look broken.
  const showSection = (section) => {
    if (isSectionHidden(section.id)) onToggleSection(section.id);
    for (const provider of section.providers) {
      if (isProviderHidden(provider.id)) onToggleProvider(provider.id);
    }
  };

  const hideSection = (section) => {
    if (!isSectionHidden(section.id)) onToggleSection(section.id);
    for (const provider of section.providers) {
      if (!isProviderHidden(provider.id)) onToggleProvider(provider.id);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs transition-colors ${
          hiddenCount
            ? "border-black/10 bg-black/[0.02] text-text-primary hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            : "cursor-default border-black/10 text-text-muted opacity-50 dark:border-white/10"
        }`}
        aria-label="Choose which providers to show"
        title={hiddenCount ? `${hiddenCount} hidden — click to choose what to show` : "Everything is shown"}
      >
        <span className="material-symbols-outlined text-[15px]">account_tree</span>
        {hiddenCount || <span className="text-[11px]">all</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-border bg-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold text-text-main">Visible providers</span>
            <div className="flex items-center gap-2">
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onReset();
                    setOpen(false);
                  }}
                  className="text-[11px] text-text-muted hover:text-text-main"
                >
                  Show all
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-text-muted hover:text-text-main"
                aria-label="Close"
              >
                <span className="material-symbols-outlined text-[15px]">close</span>
              </button>
            </div>
          </div>

          <div className="max-h-[26rem] overflow-y-auto p-1.5">
            {tree.map((section) => {
              const hiddenSection = isSectionHidden(section.id);
              const hiddenProviders = section.providers.filter((p) => isProviderHidden(p.id));
              const allShown = !hiddenSection && hiddenProviders.length === 0;
              const label = SECTION_IDS[section.id] || section.id;
              const description =
                hiddenSection && hiddenProviders.length
                  ? `${hiddenProviders.length}/${section.providers.length} hidden`
                  : null;

              return (
                <div key={section.id} className="mb-1 last:mb-0">
                  <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <Checkbox
                        checked={allShown}
                        indeterminate={!allShown}
                        onChange={() => (allShown ? hideSection(section) : showSection(section))}
                        label={label}
                        description={description}
                      />
                    </div>
                    {hiddenSection && (
                      <button
                        type="button"
                        onClick={() => showSection(section)}
                        className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-primary hover:underline"
                        title={`Show ${label}`}
                      >
                        Show
                      </button>
                    )}
                  </div>

                  {section.providers.map((provider) => (
                    <Checkbox
                      key={provider.id}
                      indent
                      checked={!isProviderHidden(provider.id) && !hiddenSection}
                      onChange={() => onToggleProvider(provider.id)}
                      label={provider.name}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

VisibilityTreeMenu.propTypes = {
  tree: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      providers: PropTypes.arrayOf(
        PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string.isRequired }),
      ).isRequired,
    }),
  ).isRequired,
  isSectionHidden: PropTypes.func.isRequired,
  isProviderHidden: PropTypes.func.isRequired,
  onToggleSection: PropTypes.func.isRequired,
  onToggleProvider: PropTypes.func.isRequired,
  onReset: PropTypes.func.isRequired,
};

/** Small "hide this one" affordance for a provider card. */
export function HideProviderButton({ providerId, name, onHide }) {
  return (
    <button
      type="button"
      title={`Hide ${name}`}
      aria-label={`Hide ${name}`}
      onClick={(e) => {
        // The card is wrapped in a link; without this the click navigates.
        e.preventDefault();
        e.stopPropagation();
        onHide(providerId);
      }}
      className="absolute left-2 top-2 z-10 rounded-md p-1 text-text-muted opacity-0 transition-all hover:bg-surface hover:text-text-main focus:opacity-100 group-hover:opacity-100"
    >
      <span className="material-symbols-outlined text-[14px]">visibility_off</span>
    </button>
  );
}

HideProviderButton.propTypes = {
  providerId: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  onHide: PropTypes.func.isRequired,
};