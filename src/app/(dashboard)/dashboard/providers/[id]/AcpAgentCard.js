"use client";

/**
 * AcpAgentCard — the setup surface an ACP agent never had.
 *
 * An ACP provider has no account row: it is a local process holding its own
 * credentials, so the providers page used to show nothing but a proxy-pool
 * picker. That left the two things an operator actually wants — which models to
 * publish, and how the agent should behave — with nowhere to live.
 *
 * Everything shown here is read from the agent itself (see acpCatalog.js): the
 * model list and the knobs are whatever the running CLI advertises in its ACP
 * `session/new`. The user picks which models to publish; the executor pins the
 * chosen options on every new session.
 */

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Card, Badge, Button } from "@/shared/components";
import AcpStatusBadge from "../components/AcpStatusBadge";

const OPTIONS_TO_SHOW = ["mode", "collaboration_mode", "thought_level"];

const OPTION_LABELS = {
  mode: "Access Mode",
  collaboration_mode: "Collaboration Mode",
  thought_level: "Reasoning Level",
};

const OPTION_HINTS = {
  mode: "How much the agent may touch on this machine.",
  collaboration_mode: "Whether it plans before acting.",
  thought_level: "Reasoning effort spent per turn.",
};

export default function AcpAgentCard({ providerId }) {
  const [installed, setInstalled] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [enabledModels, setEnabledModels] = useState(null);
  const [defaults, setDefaults] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/acp-agents/${encodeURIComponent(providerId)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setInstalled(Boolean(data.installed));
      setCatalog(data.catalog || null);
      setEnabledModels(Array.isArray(data.enabledModels) ? data.enabledModels : null);
      setDefaults(data.defaults || {});
    } catch {
      /* keep whatever is on screen */
    }
  }, [providerId]);

  useEffect(() => {
    load();
  }, [load]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`/api/acp-agents/${encodeURIComponent(providerId)}/catalog?sync=1`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || `Could not read the agent catalog (HTTP ${res.status})`);
        return;
      }
      setCatalog(data);
      setInstalled(true);
      // First sync with nothing chosen yet: publish everything the agent offers,
      // which is what a client expects from a provider that just appeared.
      setEnabledModels((prev) => prev ?? (data.models || []).map((m) => m.id));
    } finally {
      setSyncing(false);
    }
  }, [providerId]);

  const save = useCallback(
    async (patch) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/acp-agents/${encodeURIComponent(providerId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setError(data?.error || `Could not save (HTTP ${res.status})`);
          return false;
        }
        setEnabledModels(Array.isArray(data.enabledModels) ? data.enabledModels : null);
        setDefaults(data.defaults || {});
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
        return true;
      } finally {
        setSaving(false);
      }
    },
    [providerId],
  );

  const toggleModel = (id) => {
    const current = enabledModels ?? (catalog?.models || []).map((m) => m.id);
    const next = current.includes(id) ? current.filter((m) => m !== id) : [...current, id];
    setEnabledModels(next);
    save({ enabledModels: next });
  };

  const setDefault = (configId, value) => {
    const next = { ...defaults };
    if (!value) delete next[configId];
    else next[configId] = value;
    setDefaults(next);
    save({ defaults: next });
  };

  const models = catalog?.models || [];
  // Match on the category, not the id: Codex reports reasoning as
  // { id: "reasoning_effort", category: "thought_level" }, so an id-only
  // filter drops the one option most operators want to change.
  const options = (catalog?.options || []).filter((o) => OPTIONS_TO_SHOW.includes(o.category || o.id));
  const selected = enabledModels ?? models.map((m) => m.id);

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">smart_toy</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">ACP Agent</p>
          <p className="text-xs text-text-muted">
            This agent runs as a local process and brings its own credentials — there is nothing to add
            here. Sync to read the models it actually offers, then choose which to publish.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AcpStatusBadge providerId={providerId} />
          {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-text-main">Models</p>
        <Button size="sm" variant="secondary" icon="sync" onClick={sync} disabled={syncing || !installed}>
          {syncing ? "Syncing…" : "Sync from agent"}
        </Button>
      </div>

      {!catalog ? (
        <p className="mt-2 text-xs text-text-muted">
          {installed
            ? "No catalog cached yet — sync to read the models this agent offers."
            : "The agent CLI was not found on this machine."}
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-text-muted">
            Published models appear in <code className="font-mono">/v1/models</code> as{" "}
            <code className="font-mono">{`${providerId}/<model>`}</code> and can be picked by any client.
            {catalog.fetchedAt && (
              <> Synced {new Date(catalog.fetchedAt).toLocaleString()}.</>
            )}
          </p>

          <div className="mt-3 flex flex-col gap-1.5">
            {models.map((model) => {
              const on = selected.includes(model.id);
              return (
                <label
                  key={model.id}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 cursor-pointer hover:bg-sidebar/50"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleModel(model.id)}
                    disabled={saving}
                    className="accent-[var(--color-primary)]"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">{model.name || model.id}</span>
                    {model.description && (
                      <span className="block text-xs text-text-muted truncate">{model.description}</span>
                    )}
                  </span>
                  <code className="text-xs text-text-muted font-mono">{model.id}</code>
                  {model.current && <Badge variant="success" size="sm">agent default</Badge>}
                </label>
              );
            })}
            {!models.length && <p className="text-xs text-text-muted">The agent reported no models.</p>}
          </div>

          {options.length > 0 && (
            <>
              <p className="mt-5 mb-1 text-sm font-medium text-text-main">How the agent works</p>
              <p className="text-xs text-text-muted">
                Applied to every new session this agent starts.
              </p>
              <div className="mt-2 flex flex-col gap-3">
                {options.map((option) => {
                  const key = option.category || option.id;
                  return (
                  <div key={option.id}>
                    <label className="text-sm font-medium text-text-main">{OPTION_LABELS[key] || option.name}</label>
                    <select
                      value={defaults[option.id] || ""}
                      onChange={(e) => setDefault(option.id, e.target.value)}
                      disabled={saving}
                      className="mt-1 w-full py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 transition-all disabled:opacity-50"
                    >
                      <option value="">Agent default ({option.currentValue || "unknown"})</option>
                      {option.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.name || o.value}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-text-muted">
                      {OPTION_HINTS[key] || option.description || ""}
                    </p>
                  </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

AcpAgentCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};