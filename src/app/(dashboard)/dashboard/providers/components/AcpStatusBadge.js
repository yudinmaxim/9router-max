"use client";

/**
 * AcpStatusBadge — measured readiness for one ACP agent.
 *
 * Replaces the unconditional green "Ready" the providers page used to print for
 * every noAuth provider. The cheap poll answers "is the CLI installed"; the
 * deep probe, triggered from the popover, spawns the agent and completes the
 * ACP `initialize` handshake, which is the only state allowed to render green.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import { Badge, Button } from "@/shared/components";

const POLL_MS = 30000;

// An ACP agent has no connection to make: no credential row, no login step.
// So the badge answers the only question that matters — can it serve a request
// — and "Installed" is deliberately not an end state, because it reads the
// same as "broken" to anyone who hasn't opened the popover.
const STATUS_VIEW = {
  working: { variant: "success", label: "Working" },
  broken: { variant: "error", label: "Not working" },
  missing: { variant: "warning", label: "Not installed" },
  verifying: { variant: "default", label: "Checking…" },
};

export default function AcpStatusBadge({ providerId, refreshKey = 0 }) {
  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const pollRef = useRef(false);

  const pick = useCallback(
    (json) => (json?.providers || []).find((p) => p.providerId === providerId) || null,
    [providerId],
  );

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/acp-status", { cache: "no-store" });
      if (res.ok) setEntry(pick(await res.json()));
    } catch {
      /* offline — keep the previous reading */
    } finally {
      setLoading(false);
    }
  }, [pick]);

  const probeNow = useCallback(async () => {
    setProbing(true);
    try {
      const res = await fetch("/api/acp-status?probe=1", { cache: "no-store" });
      if (res.ok) setEntry(pick(await res.json()));
    } catch {
      /* keep the previous reading */
    } finally {
      setProbing(false);
    }
  }, [pick]);

  // An agent whose CLI has no `acp` subcommand (Codex) needs a bridge package
  // installed before it can answer at all. Installing it here is the whole
  // setup: the router provisions it into its own data dir, so there is no shell
  // command and no version pinning for the user to get wrong.
  const setUp = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const res = await fetch("/api/acp-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setInstallError(json?.error || `Setup failed (HTTP ${res.status})`);
        return;
      }
      setEntry(json.status || null);
    } catch (error) {
      setInstallError(error?.message || "Setup failed");
    } finally {
      setInstalling(false);
    }
  }, [providerId]);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [fetchStatus, refreshKey]);

  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  if (loading) return null;

  const view = STATUS_VIEW[entry?.status] || STATUS_VIEW.verifying;

  return (
    <span className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-left"
        title="ACP agent status — click for details"
      >
        <Badge variant={view.variant} size="sm" dot>
          {view.label}
        </Badge>
      </button>

      {open && (
        <span className="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-xl border border-border bg-surface p-3 shadow-2xl text-text-main text-xs font-normal">
          <span className="flex items-center justify-between gap-2">
            <span className="font-semibold">{entry?.bin || providerId}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-text-muted hover:text-text-main"
              aria-label="Close"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </span>

          <span className="mt-2 block space-y-1">
            <span className="block">
              <span className="text-text-muted">Status: </span>
              {view.label}
            </span>
            {entry?.resolvedPath && (
              <span className="block break-all">
                <span className="text-text-muted">Binary: </span>
                <span className="font-mono">{entry.resolvedPath}</span>
              </span>
            )}
            {entry?.detail && (
              <span className="block break-words text-text-muted">{entry.detail}</span>
            )}
            <span className="block text-text-muted">
              {entry?.status === "verifying"
                ? "Measuring whether the agent answers — this runs on its own, no need to check."
                : ""}
            </span>
            {entry?.setup?.needed && (
              <span className="block">
                Needs its ACP bridge: <span className="font-mono">{entry.setup.package}</span>
              </span>
            )}
            {installError && (
              <span className="block text-red-500 break-words">{installError}</span>
            )}
            {entry?.checkedAt && (
              <span className="block text-text-muted">
                Checked {new Date(entry.checkedAt).toLocaleTimeString()}
              </span>
            )}
          </span>

          <span className="mt-3 flex items-center justify-end gap-2">
            {entry?.setup?.needed ? (
              <Button size="sm" onClick={setUp} disabled={installing}>
                {installing ? "Setting up…" : "Set up"}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={probeNow} disabled={probing}>
                {probing ? "Checking…" : "Check now"}
              </Button>
            )}
          </span>
        </span>
      )}
    </span>
  );
}

AcpStatusBadge.propTypes = {
  providerId: PropTypes.string.isRequired,
  // Bumped by the page when a fresh measurement was just triggered, so every
  // badge re-reads immediately instead of waiting out its poll interval.
  refreshKey: PropTypes.number,
};