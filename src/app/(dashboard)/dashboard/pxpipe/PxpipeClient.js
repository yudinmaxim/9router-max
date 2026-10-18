"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button } from "@/shared/components";

const fmtUptime = (ms) => {
  if (!ms || ms <= 0) return "—";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

function SummaryCard({ label, value, sub, tone }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-text-muted uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${tone || ""}`}>{value}</p>
      {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
    </Card>
  );
}

export default function PxpipeClient() {
  const [status, setStatus] = useState(null);
  const [health, setHealth] = useState(null);
  const [logs, setLogs] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, logsRes] = await Promise.all([
        fetch("/api/pxpipe/status", { headers: { "Cache-Control": "no-store" } }),
        fetch("/api/pxpipe/logs"),
      ]);
      setStatus(await statusRes.json());
      setLogs(await logsRes.json());
      const healthRes = await fetch("/api/pxpipe/health", { method: "POST" });
      setHealth(await healthRes.json());
    } catch {
      /* sections render placeholders */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const statusLabel = !status
    ? "—"
    : !status.installed
      ? "Not installed"
      : health?.healthy
        ? "Healthy"
        : status.running
          ? "Running"
          : "Stopped";

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">image</span>
          PXPIPE Dashboard
        </h2>
        <div className="flex items-center gap-2">
          <a href="/dashboard/token-saver" className="text-xs text-primary underline hover:opacity-80">
            Token Saver settings
          </a>
          <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <SummaryCard
          label="Status"
          value={statusLabel}
          tone={health?.healthy ? "text-success" : status?.installed ? "text-warning" : "text-text-muted"}
          sub={status?.enabled ? "Enabled in pipeline" : "Disabled in pipeline"}
        />
        <SummaryCard label="Version" value={status?.version ? `v${status.version}` : "—"} sub="pxpipe-proxy" />
        <SummaryCard label="Uptime" value={fmtUptime(status?.uptimeMs)} sub="module loaded" />
      </div>


      <Card className="p-4" id="logs">
        <h3 className="font-medium mb-3">PXPIPE Logs</h3>
        {logs?.installLog ? (
          <pre className="rounded bg-black/5 dark:bg-white/5 p-3 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
            {logs.installLog}
          </pre>
        ) : (
          <p className="text-sm text-text-muted">No install log yet.</p>
        )}
      </Card>
    </div>
  );
}
