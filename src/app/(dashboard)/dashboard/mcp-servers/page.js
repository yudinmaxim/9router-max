"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Input, Modal, Select, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const EMPTY = {
  name: "",
  url: "",
  transport: "http",
  authType: "none",
  authHeader: "Authorization",
  authToken: "",
  allowLocal: false,
  isActive: true,
};

const STATUS_VARIANT = { ok: "success", error: "error", unknown: "default" };

export default function McpServersPage() {
  const notify = useNotificationStore();
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [testingId, setTestingId] = useState(null);
  const [toolsOf, setToolsOf] = useState({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp-servers", { cache: "no-store" });
      const data = await res.json();
      setServers(data.mcpServers || []);
    } catch {
      notify.error("Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setForm(EMPTY); setEditing({}); };
  const openEdit = (server) => {
    setForm({ ...EMPTY, ...server, authToken: "" });
    setEditing(server);
  };

  const save = async () => {
    try {
      const isNew = !editing.id;
      const res = await fetch(isNew ? "/api/mcp-servers" : `/api/mcp-servers/${editing.id}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) return notify.error(data.error || "Save failed");
      await load();
      notify.success(isNew ? "MCP server added" : "MCP server updated");
      setEditing(null);
    } catch {
      notify.error("Save failed");
    }
  };

  const test = async (server) => {
    setTestingId(server.id);
    setToolsOf((prev) => ({ ...prev, [server.id]: null }));
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}/test`, { method: "POST" });
      const data = await res.json();
      setToolsOf((prev) => ({ ...prev, [server.id]: data.tools || [] }));
      await load();
      if (res.ok && data.status === "ok") {
        notify.success(`${server.name}: ${(data.tools || []).length} tool(s)`);
      } else {
        notify.error(data.error || "Probe failed");
      }
    } catch {
      notify.error("Probe failed");
    } finally {
      setTestingId(null);
    }
  };

  const remove = async (server) => {
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}`, { method: "DELETE" });
      if (!res.ok) return notify.error("Delete failed");
      await load();
      notify.success(`${server.name} removed`);
    } catch {
      notify.error("Delete failed");
    }
  };

  // Input's onChange hands over a DOM event while Select hands the value, so
  // the text fields unwrap it and the selects do not.
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const setText = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">MCP Servers</h1>
          <p className="text-sm text-gray-500">
            Shared by every agent in the router. Agents reach these through the router&apos;s own
            proxy, so the credential never leaves the database.
          </p>
        </div>
        <Button onClick={openCreate}>Add server</Button>
      </div>

      {loading ? (
        <Card><p className="text-sm text-gray-500">Loading…</p></Card>
      ) : servers.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-500">
            Nothing registered yet. Agents keep their own tools; with an empty registry they are
            handed no external MCP servers at all.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <Card key={server.id}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{server.name}</span>
                    <Badge variant={STATUS_VARIANT[server.testStatus] || "default"}>
                      {server.testStatus || "unknown"}
                    </Badge>
                    {server.hasToken ? <Badge variant="default">token</Badge> : null}
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-1">{server.url}</p>
                  {server.lastError ? (
                    <p className="text-xs text-red-400 mt-1">{server.lastError}</p>
                  ) : null}
                  {toolsOf[server.id]?.length ? (
                    <p className="text-xs text-gray-400 mt-2">
                      {toolsOf[server.id].map((t) => t.name).join(", ")}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Toggle checked={server.isActive} onChange={() => {
                    fetch(`/api/mcp-servers/${server.id}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ isActive: !server.isActive }),
                    }).then(load);
                  }} />
                  <Button onClick={() => test(server)} disabled={testingId === server.id}>
                    {testingId === server.id ? "Testing…" : "Test"}
                  </Button>
                  <Button variant="secondary" onClick={() => openEdit(server)}>Edit</Button>
                  <Button variant="danger" onClick={() => remove(server)}>Delete</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing ? (
        <Modal
          isOpen
          onClose={() => setEditing(null)}
          title={editing.id ? "Edit MCP server" : "Add MCP server"}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={save}>Save</Button>
            </div>
          }
        >
          <div className="space-y-3">
            <Input label="Name" value={form.name} onChange={setText("name")} placeholder="Jira" />
            <Input
              label="URL"
              value={form.url}
              onChange={setText("url")}
              placeholder="https://jira.example.com/mcp"
            />
            <Select
              label="Transport"
              value={form.transport}
              onChange={set("transport")}
              options={[
                { value: "http", label: "Streamable HTTP" },
                { value: "sse", label: "SSE (legacy)" },
              ]}
            />
            <Select
              label="Authentication"
              value={form.authType}
              onChange={set("authType")}
              options={[
                { value: "none", label: "None" },
                { value: "bearer", label: "Bearer token" },
                { value: "header", label: "Custom header" },
              ]}
            />
            {form.authType === "header" ? (
              <Input label="Header name" value={form.authHeader} onChange={setText("authHeader")} />
            ) : null}
            {form.authType !== "none" ? (
              <Input
                label="Token"
                type="password"
                value={form.authToken}
                onChange={setText("authToken")}
                placeholder={editing.id && editing.hasToken ? "Leave blank to keep the stored token" : ""}
              />
            ) : null}
            <div className="flex items-start gap-3 pt-1">
              <Toggle checked={form.allowLocal} onChange={set("allowLocal")} />
              <div>
                <p className="text-sm">Allow a private address</p>
                <p className="text-xs text-gray-500">
                  Needed for self-hosted servers on your own network. The proxy refuses internal
                  targets otherwise.
                </p>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}