"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Card, Button, Select } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const ACTIONS = ["read", "search", "edit", "move", "delete", "execute", "fetch", "other"];
const VALUE_OPTIONS = [
  { value: "always", label: "Always allow" },
  { value: "once", label: "Allow once" },
  { value: "deny", label: "Deny" },
];
const VALUE_OF = { always: "always", once: "once", deny: "deny" };
const DEFAULT_VALUE = "always";

/**
 * Per-provider ACP permissions, layered over the router default.
 *
 * Only shown for providers the ACP executor serves. Diff-on-save, like the
 * custom-headers card: rows left at the inherited value are not written, so
 * changing the router default later still moves this provider with it.
 */
export default function AcpPermissionsCard({ providerId }) {
  const notify = useNotificationStore();
  const [expanded, setExpanded] = useState(false);
  const [grid, setGrid] = useState(null);
  const [inherited, setInherited] = useState({});
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/acp-permissions?provider=${encodeURIComponent(providerId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const base = {};
        for (const a of ACTIONS) {
          const d = data.defaults?.[a] || {};
          base[a] = { inside: d.inside || DEFAULT_VALUE, outside: d.outside || DEFAULT_VALUE };
        }
        const merged = {};
        for (const a of ACTIONS) {
          const o = data.policy?.[a];
          merged[a] = {
            inside: o?.inside || base[a].inside,
            outside: o?.outside || base[a].outside,
          };
        }
        setInherited(base);
        setGrid(merged);
        setHasOverride(Boolean(data.policy));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const setCell = (action, scope, value) => {
    setGrid((prev) => ({ ...prev, [action]: { ...prev[action], [scope]: value } }));
  };

  const save = useCallback(async () => {
    if (!grid) return;
    setSaving(true);
    // Only send what actually differs, so untouched actions keep following the
    // router default rather than freezing a copy of it.
    const policy = {};
    for (const a of ACTIONS) {
      const cell = grid[a];
      const base = inherited[a];
      if (cell.inside !== base.inside || cell.outside !== base.outside) {
        policy[a] = { inside: cell.inside, outside: cell.outside };
      }
    }
    try {
      const res = await fetch("/api/acp-permissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: Object.keys(policy).length ? policy : null, provider: providerId }),
      });
      const data = await res.json();
      if (!res.ok) {
        notify.error?.(data.error || "Failed to save permissions");
        return;
      }
      setHasOverride(Object.keys(policy).length > 0);
      notify.success?.("ACP permissions saved");
    } catch {
      notify.error?.("Failed to save permissions");
    } finally {
      setSaving(false);
    }
  }, [grid, inherited, providerId, notify]);

  const reset = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/acp-permissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: null, provider: providerId }),
      });
      const data = await res.json();
      setGrid(JSON.parse(JSON.stringify(inherited)));
      setHasOverride(false);
      notify.success?.("Reset to router default");
    } catch {
      notify.error?.("Failed to reset permissions");
    } finally {
      setSaving(false);
    }
  }, [inherited, providerId, notify]);

  if (!grid) return null;

  return (
    <Card className="mb-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <div>
          <h2 className="text-lg font-semibold">ACP Permissions</h2>
          <p className="text-sm text-text-muted">
            {hasOverride
              ? "This provider overrides the router default."
              : "Following the router default."}
          </p>
        </div>
        <span className="material-symbols-outlined">{expanded ? "expand_less" : "expand_more"}</span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted border-b border-surface-3">
                <th className="py-2 pr-4 font-medium">Action</th>
                <th className="py-2 px-2 font-medium">Inside working directory</th>
                <th className="py-2 pl-2 font-medium">Outside</th>
              </tr>
            </thead>
            <tbody>
              {ACTIONS.map((action) => (
                <tr key={action} className="border-b border-surface-3/50 last:border-0">
                  <td className="py-2 pr-4">{action}</td>
                  <td className="py-2 px-2">
                    <Select
                      value={grid[action].inside}
                      onChange={(e) => setCell(action, "inside", e?.target?.value ?? e)}
                      options={VALUE_OPTIONS}
                    />
                  </td>
                  <td className="py-2 pl-2">
                    <Select
                      value={grid[action].outside}
                      onChange={(e) => setCell(action, "outside", e?.target?.value ?? e)}
                      options={VALUE_OPTIONS}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {hasOverride && (
              <Button variant="ghost" onClick={reset} disabled={saving}>
                Reset to router default
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

AcpPermissionsCard.propTypes = { providerId: PropTypes.string.isRequired };