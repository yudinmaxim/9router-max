"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Select, Toggle } from "@/shared/components";
import { PROVIDERS } from "open-sse/config/providers.js";

// Every provider the ACP executor actually serves. Listing only the ones that
// already have an override would make a new provider unselectable.
const ACP_PROVIDERS = Object.keys(PROVIDERS).filter((id) => id.endsWith("-acp")).sort();

const ACTIONS = ["read", "search", "edit", "move", "delete", "execute", "fetch", "other"];
const VALUES = ["always", "once", "deny"];
const DEFAULT_VALUE = "always";

const ACTION_LABELS = {
  read: { title: "Read", hint: "Open a file and look at it." },
  search: { title: "Search", hint: "List or glob a directory." },
  edit: { title: "Edit", hint: "Write to a file." },
  move: { title: "Move / rename", hint: "Relocate a file." },
  delete: { title: "Delete", hint: "Remove a file. Not reversible." },
  execute: { title: "Run command", hint: "Shell. Reaches anything, wherever the file lives." },
  fetch: { title: "Fetch URL", hint: "Network access." },
  other: { title: "Other", hint: "Anything the router could not classify." },
};

const VALUE_OPTIONS = VALUES.map((v) => ({
  value: v,
  label: { always: "Always allow", once: "Allow once", deny: "Deny" }[v],
}));

const emptyPolicy = () =>
  Object.fromEntries(ACTIONS.map((a) => [a, { inside: DEFAULT_VALUE, outside: DEFAULT_VALUE }]));

const scopesFor = (policy, action) => policy[action] || { inside: DEFAULT_VALUE, outside: DEFAULT_VALUE };

export default function AcpPermissionsClient() {
  const [defaults, setDefaults] = useState(null);
  const [providers, setProviders] = useState([]);
  const [selected, setSelected] = useState("");
  const [override, setOverride] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Async fetch inside the effect: setState runs in the promise continuation,
  // never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/acp-permissions");
        const data = await res.json();
        if (cancelled) return;
        setDefaults(data.defaults || {});
        setProviders(data.providers || []);
      } catch {
        if (!cancelled) setError("Could not load permissions");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The editor always shows a full grid. A provider with no override inherits
  // the router default, so editing starts from a copy of it.
  const gridFor = useCallback(
    (provider) => {
      const g = emptyPolicy();
      for (const a of ACTIONS) {
        const d = defaults?.[a];
        if (d) g[a] = { ...g[a], ...d };
      }
      if (provider && override) return override;
      return g;
    },
    [defaults, override]
  );

  const grid = gridFor(selected);

  const loadProvider = useCallback(
    async (provider) => {
      if (!provider) {
        setOverride(null);
        return;
      }
      try {
        const res = await fetch(`/api/acp-permissions?provider=${encodeURIComponent(provider)}`);
        const data = await res.json();
        setOverride(data.policy || null);
      } catch {
        setError("Could not load provider policy");
      }
    },
    []
  );

  const setCell = (action, scope, value) => {
    setError("");
    const base = gridFor(selected);
    setOverride({ ...base, [action]: { ...base[action], [scope]: value } });
    // Router-wide edits write straight into the defaults grid.
    if (!selected) setDefaults({ ...base, [action]: { ...base[action], [scope]: value } });
  };

  const save = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/acp-permissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: gridFor(selected), provider: selected || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Save failed");
        return;
      }
      if (selected) setProviders(data.providers || []);
      else setDefaults(data.defaults || {});
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  }, [selected, gridFor]);

  const resetProvider = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch("/api/acp-permissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: null, provider: selected }),
      });
      const data = await res.json();
      setProviders(data.providers || []);
      setOverride(null);
    } catch {
      setError("Reset failed");
    } finally {
      setSaving(false);
    }
  }, [selected]);

  if (!loaded) return <div className="p-6 text-sm text-text-muted">Loading…</div>;

  const isOverridden = Boolean(selected && override);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-main">ACP agent permissions</h1>
        <p className="mt-1 text-sm text-text-muted">
          When a CLI agent wants to use a tool it asks the router, and waits. There is nobody to
          ask here, so the router answers from these rules. Denying is safe — the agent marks the
          tool failed and finishes the turn.
        </p>
      </div>

      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-medium text-text-main">Scope</h2>
            <p className="text-sm text-text-muted">
              {selected
                ? isOverridden
                  ? "This provider overrides the router default."
                  : "This provider inherits the router default."
                : "Editing the router-wide default, used by every provider without its own rule."}
            </p>
          </div>
          <div className="w-64">
            <Select
              value={selected}
              onChange={(e) => {
                const v = e?.target?.value ?? e;
                setSelected(v);
                loadProvider(v);
              }}
              options={[
                { value: "", label: "All providers (default)" },
                ...ACP_PROVIDERS.map((p) => ({
                  value: p,
                  label: override && providers.includes(p) ? `${p} (override)` : p,
                })),
              ]}
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted border-b border-surface-3">
                <th className="py-2 pr-4 font-medium">Action</th>
                <th className="py-2 px-2 font-medium">Inside working directory</th>
                <th className="py-2 pl-2 font-medium">Outside</th>
              </tr>
            </thead>
            <tbody>
              {ACTIONS.map((action) => {
                const cell = scopesFor(grid, action);
                return (
                  <tr key={action} className="border-b border-surface-3/50 last:border-0">
                    <td className="py-2.5 pr-4">
                      <div className="text-text-main">{ACTION_LABELS[action].title}</div>
                      <div className="text-xs text-text-muted">{ACTION_LABELS[action].hint}</div>
                    </td>
                    <td className="py-2.5 px-2">
                      <Select
                        value={cell.inside}
                        onChange={(e) => setCell(action, "inside", e?.target?.value ?? e)}
                        options={VALUE_OPTIONS}
                      />
                    </td>
                    <td className="py-2.5 pl-2">
                      <Select
                        value={cell.outside}
                        onChange={(e) => setCell(action, "outside", e?.target?.value ?? e)}
                        options={VALUE_OPTIONS}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {selected && isOverridden && (
            <Button variant="ghost" onClick={resetProvider} disabled={saving}>
              Reset to router default
            </Button>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <Toggle
          label="Per-request override"
          description="A client can grant or deny for a single call without touching these settings, using the x-9router-acp-permissions header or metadata.acp_permissions in the request body — for example execute=once. It wins over anything set here."
          checked={true}
          disabled={true}
        />
      </Card>
    </div>
  );
}