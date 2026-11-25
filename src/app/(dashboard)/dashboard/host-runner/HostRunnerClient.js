"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Input, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { parseCommandLine, formatArgv } from "@/lib/hostRunner/argv";

/**
 * Editor for the host-runner whitelist — the list of commands an in-container
 * agent is allowed to ask the host to execute through the `hostrunner_*` MCP
 * tools.
 *
 * The file being edited is not in this container. It lives on the host, out of
 * reach of agents, and every save travels as a message signed with a key
 * derived from the dashboard password — because agents share this container
 * with the API as the same uid, so nothing else separates them. That password
 * is the gate; everything on this page is validation and readability, and both
 * the server and the daemon re-check all of it independently.
 */

const EMPTY_CONFIG = {
  allowedRoots: ["/home/maxim/Projects"],
  envAllowlist: ["PATH", "HOME", "LANG", "LC_ALL", "TZ"],
  maxConcurrent: 1,
  maxPending: 50,
  maxOutputBytes: 200000,
  maxTailBytes: 16000,
  defaultTimeoutMs: 900000,
  maxTimeoutMs: 3600000,
  pollMs: 250,
  auditFile: "",
  tools: {},
};

const NUMERIC_FIELDS = [
  {
    key: "maxConcurrent",
    label: "Параллельно",
    hint: "Сколько задач выполняется одновременно.",
  },
  {
    key: "maxPending",
    label: "В очереди",
    hint: "Глубина очереди, после которой новые задачи ждут в `in/`.",
  },
  {
    key: "maxOutputBytes",
    label: "Макс. лог (байт)",
    hint: "Жёсткий лимит захваченного вывода одной задачи.",
  },
  {
    key: "defaultTimeoutMs",
    label: "Таймаут по умолчанию (мс)",
    hint: "Используется, если ни инструмент, ни запрос не задали свой.",
  },
  {
    key: "maxTimeoutMs",
    label: "Макс. таймаут (мс)",
    hint: "Верхняя граница, которую может запросить заявка.",
  },
  {
    key: "pollMs",
    label: "Интервал опроса (мс)",
    hint: "Как часто демон ищет новые задачи.",
  },
];

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const lines = (text) =>
  String(text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

const envToText = (env) =>
  Object.entries(env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

const textToEnv = (text) => {
  const env = {};
  for (const line of lines(text)) {
    const idx = line.indexOf("=");
    if (idx <= 0) throw new Error(`env line "${line}" must be KEY=value`);
    env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return env;
};

export default function HostRunnerClient() {
  const notify = useNotificationStore();
  const [config, setConfig] = useState(null);
  const [configPath, setConfigPath] = useState("");
  const [writable, setWritable] = useState(false);
  const [authConfigured, setAuthConfigured] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [dirty, setDirty] = useState(false);
  // Never persisted and cleared after every save: it only exists long enough to
  // sign one message.
  const [password, setPassword] = useState("");

  // Command lines are kept as free text while editing: re-parsing argv on every
  // keystroke would fight the user (an unbalanced quote would wipe the field).
  const [cmdLines, setCmdLines] = useState({});
  const [envText, setEnvText] = useState({});
  const [cwdText, setCwdText] = useState({});
  const [newToolName, setNewToolName] = useState("");

  // One load implementation, driven by `refreshKey`: the effect does the fetch
  // itself (react-hooks/set-state-in-effect rejects calling a setState-heavy
  // helper from an effect body), and «Обновить» just bumps the key from an event
  // handler, where setting `loading` is fine.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/host-runner/config", {
          cache: "no-store",
        });
        const data = await res.json();
        if (cancelled) return;
        setConfigPath(data.configPath || "");
        setWritable(Boolean(data.writable));
        setAuthConfigured(Boolean(data.authConfigured));
        if (!data.config) {
          setLoadError(
            data.error ||
              "Whitelist не найден. Демон не стартует без него — добавьте команду ниже, чтобы его создать.",
          );
          setConfig({ ...EMPTY_CONFIG, tools: {} });
          setCmdLines({});
          setEnvText({});
          setCwdText({});
          return;
        }
        setConfig(data.config);
        setCmdLines(
          Object.fromEntries(
            Object.entries(data.config.tools).map(([name, tool]) => [
              name,
              formatArgv(tool.argv),
            ]),
          ),
        );
        setEnvText(
          Object.fromEntries(
            Object.entries(data.config.tools).map(([name, tool]) => [
              name,
              envToText(tool.env),
            ]),
          ),
        );
        setCwdText(
          Object.fromEntries(
            Object.entries(data.config.tools).map(([name, tool]) => [
              name,
              (tool.allowedCwd || []).join("\n"),
            ]),
          ),
        );
        setLoadError("");
      } catch {
        if (!cancelled) setLoadError("Не удалось загрузить whitelist");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const patch = useCallback((updater) => {
    setDirty(true);
    setFormError("");
    setConfig((prev) => (prev ? updater(prev) : prev));
  }, []);

  const patchTool = useCallback(
    (name, changes) => {
      patch((prev) => ({
        ...prev,
        tools: { ...prev.tools, [name]: { ...prev.tools[name], ...changes } },
      }));
    },
    [patch],
  );

  const addTool = () => {
    const name = newToolName.trim();
    if (!TOOL_NAME_RE.test(name)) {
      setFormError(
        `Имя инструмента должно соответствовать ${TOOL_NAME_RE.source}`,
      );
      return;
    }
    if (config.tools[name]) {
      setFormError(`Инструмент «${name}» уже существует`);
      return;
    }
    patch((prev) => ({
      ...prev,
      tools: {
        ...prev.tools,
        [name]: { description: "", argv: [], timeoutMs: 600000, enabled: true },
      },
    }));
    setCmdLines((prev) => ({ ...prev, [name]: "" }));
    setEnvText((prev) => ({ ...prev, [name]: "" }));
    setCwdText((prev) => ({ ...prev, [name]: "" }));
    setNewToolName("");
  };

  const removeTool = (name) => {
    patch((prev) => {
      const tools = { ...prev.tools };
      delete tools[name];
      return { ...prev, tools };
    });
  };

  const argvError = useMemo(() => {
    const errs = {};
    for (const [name, text] of Object.entries(cmdLines)) {
      if (!config?.tools?.[name]) continue;
      try {
        parseCommandLine(text);
      } catch (error) {
        errs[name] = error.message;
      }
    }
    return errs;
  }, [cmdLines, config]);

  const save = async () => {
    if (!config) return;
    if (!password) {
      setFormError("Введите пароль дашборда, чтобы сохранить.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const tools = {};
      for (const [name, tool] of Object.entries(config.tools)) {
        const argv = parseCommandLine(cmdLines[name] ?? "");
        if (!argv.length) throw new Error(`«${name}» нужна команда`);
        tools[name] = {
          ...tool,
          argv,
          env: textToEnv(envText[name] ?? ""),
          allowedCwd: lines(cwdText[name] ?? ""),
        };
      }
      if (!Object.keys(tools).length)
        throw new Error("Добавьте хотя бы одну команду");
      if (!lines(config.allowedRoots || []).length) {
        throw new Error(
          "allowedRoots должен содержать хотя бы один абсолютный путь",
        );
      }

      const res = await fetch("/api/host-runner/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { ...config, tools }, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не удалось сохранить");

      setConfig(data.config);
      setConfigPath(data.configPath || configPath);
      setWritable(Boolean(data.writable));
      setAuthConfigured(Boolean(data.authConfigured));
      setPassword("");
      setDirty(false);
      notify.success("Whitelist сохранён — хостовый демон применил изменения");
    } catch (error) {
      setFormError(error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return <div className="p-6 text-sm text-text-muted">Загрузка…</div>;

  const toolNames = Object.keys(config?.tools || {});

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-main">
          Команды Host Runner
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          MCP-инструменты <code className="text-text-main">hostrunner_*</code>
          могут запускать только то, что перечислено здесь. Shell нет: каждая
          запись — точный argv, выполняемый на хосте для агента внутри
          контейнера. Пути должны быть абсолютными, а рабочая директория задачи
          должна попадать в один из корней ниже.
        </p>
        {configPath && (
          <p className="mt-2 text-xs text-text-muted">
            Источник: <code className="text-text-main">{configPath}</code>
            {" — "}на хосте, вне этого контейнера
          </p>
        )}
      </div>

      {(loadError || formError) && (
        <Card className="p-4 border border-red-500/40">
          <p className="text-sm text-red-500">{formError || loadError}</p>
        </Card>
      )}

      {authConfigured && !writable && (
        <Card className="p-4 border border-yellow-500/40">
          <p className="text-sm text-yellow-500">
            Демон ответил, но сохранение сейчас отключено. Нажмите «Обновить»,
            чтобы обновить его состояние.
          </p>
        </Card>
      )}

      {!authConfigured && !loadError && (
        <Card className="p-4 border border-yellow-500/40">
          <p className="text-sm text-yellow-500">
            На хосте нет ключевого материала, сохранять нечего. Запустите{" "}
            <code className="text-text-main">hostrunner-ctl set-password</code>{" "}
            на хосте один раз, затем нажмите «Обновить».
          </p>
        </Card>
      )}

      {/* ── Roots ─────────────────────────────────────────────────────────── */}
      <Card className="p-5 space-y-3">
        <div>
          <h2 className="text-base font-medium text-text-main">
            Разрешённые корни
          </h2>
          <p className="text-sm text-text-muted">
            Задача отклоняется, если её рабочая директория не попадает в один из
            этих путей. Символические ссылки разрешаются заранее, поэтому ссылка
            «наружу» не поможет.
          </p>
        </div>
        <textarea
          value={(config.allowedRoots || []).join("\n")}
          onChange={(e) =>
            // Keep blank lines out: the server treats an empty entry as a
            // malformed path and would reject the whole save.
            patch((prev) => ({
              ...prev,
              allowedRoots: e.target.value.split("\n").filter((s) => s.trim()),
            }))
          }
          rows={Math.max(2, (config.allowedRoots || []).length)}
          spellCheck={false}
          className="w-full rounded-[10px] bg-surface-2 border border-transparent px-3 py-2 font-mono text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        />
        <p className="text-xs text-text-muted">
          Один абсолютный путь на строку.
        </p>
      </Card>

      {/* ── Commands ──────────────────────────────────────────────────────── */}
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-medium text-text-main">Команды</h2>
            <p className="text-sm text-text-muted">
              {toolNames.length
                ? `${toolNames.length} ${toolNames.length === 1 ? "команда" : toolNames.length < 5 ? "команды" : "команд"} доступно агентам.`
                : "Список пуст — демон не стартует, пока не появится хотя бы одна команда."}
            </p>
          </div>
          <div className="flex items-end gap-2">
            <Input
              value={newToolName}
              onChange={(e) => setNewToolName(e.target.value)}
              placeholder="имя_новой_команды"
              inputClassName="font-mono w-52"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTool();
                }
              }}
            />
            <Button variant="secondary" icon="add" onClick={addTool}>
              Добавить
            </Button>
          </div>
        </div>

        {!toolNames.length && (
          <p className="text-sm text-text-muted">
            Ничего не зарегистрировано. Агенты будут получать ошибку от{" "}
            <code className="text-text-main">hostrunner_run</code>, пока вы не
            добавите хотя бы одну команду.
          </p>
        )}

        <div className="space-y-4">
          {toolNames.map((name) => {
            const tool = config.tools[name];
            return (
              <div
                key={name}
                className="rounded-[10px] border border-surface-3 p-4 space-y-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-medium text-text-main truncate">
                      {name}
                    </span>
                    <Badge
                      variant={tool.enabled === false ? "default" : "success"}
                    >
                      {tool.enabled === false ? "отключён" : "включён"}
                    </Badge>
                    {argvError[name] && (
                      <Badge variant="error">неверная команда</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={tool.enabled !== false}
                      onChange={(v) => patchTool(name, { enabled: v })}
                      size="sm"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="delete"
                      onClick={() => removeTool(name)}
                    >
                      Удалить
                    </Button>
                  </div>
                </div>

                <Input
                  label="Описание"
                  value={tool.description || ""}
                  onChange={(e) =>
                    patchTool(name, { description: e.target.value })
                  }
                  placeholder="Что делает эта команда"
                />

                <Input
                  label="Команда"
                  required
                  value={cmdLines[name] ?? ""}
                  onChange={(e) => {
                    setDirty(true);
                    setFormError("");
                    setCmdLines((prev) => ({
                      ...prev,
                      [name]: e.target.value,
                    }));
                  }}
                  error={argvError[name]}
                  hint="Точный argv, без shell. Кавычки группируют один аргумент: vendor/bin/phpstan analyse --level=max"
                  inputClassName="font-mono"
                  placeholder="npx playwright test"
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Таймаут (мс)"
                    type="number"
                    min={1000}
                    value={tool.timeoutMs ?? ""}
                    onChange={(e) =>
                      patchTool(name, {
                        timeoutMs: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    hint={`По умолчанию ${config.defaultTimeoutMs ?? 900000} мс`}
                  />
                  <Input
                    label="Шаблон аргументов"
                    value={tool.argPattern || ""}
                    onChange={(e) =>
                      patchTool(name, { argPattern: e.target.value })
                    }
                    hint="Регулярное выражение, которому должен соответствовать каждый дополнительный аргумент. Пусто = любой аргумент."
                    inputClassName="font-mono"
                    disabled={tool.allowArgs === false}
                  />
                </div>

                <div className="flex items-center justify-between gap-3 rounded-[10px] border border-surface-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-main">
                      Принимать аргументы от агента
                    </p>
                    <p className="text-xs text-text-muted">
                      Выкл = только фиксированный argv. Демон отклоняет любой
                      дополнительный аргумент, чтобы инструмент не стал вторым
                      способом запускать произвольные команды.
                    </p>
                  </div>
                  <Toggle
                    checked={tool.allowArgs !== false}
                    onChange={(v) => patchTool(name, { allowArgs: v })}
                    size="sm"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-text-main">
                    Дополнительное окружение
                  </label>
                  <textarea
                    value={envText[name] ?? ""}
                    onChange={(e) => {
                      setDirty(true);
                      setEnvText((prev) => ({
                        ...prev,
                        [name]: e.target.value,
                      }));
                    }}
                    rows={Math.max(2, lines(envText[name] ?? "").length)}
                    spellCheck={false}
                    placeholder={"CI=1\nDEBUG=0"}
                    className="mt-1.5 w-full rounded-[10px] bg-surface-2 border border-transparent px-3 py-2 font-mono text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  />
                  <p className="mt-1 text-xs text-text-muted">
                    Одна строка{" "}
                    <code className="text-text-main">KEY=value</code>,
                    добавляется поверх унаследованного allowlist.
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium text-text-main">
                    Рабочие директории для этой команды
                  </label>
                  <textarea
                    value={cwdText[name] ?? ""}
                    onChange={(e) => {
                      setDirty(true);
                      setCwdText((prev) => ({
                        ...prev,
                        [name]: e.target.value,
                      }));
                    }}
                    rows={Math.max(2, lines(cwdText[name] ?? "").length)}
                    spellCheck={false}
                    placeholder="/home/maxim/Projects/my-app"
                    className="mt-1.5 w-full rounded-[10px] bg-surface-2 border border-transparent px-3 py-2 font-mono text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  />
                  <p className="mt-1 text-xs text-text-muted">
                    Один абсолютный путь на строку. Оставьте пустым, чтобы
                    унаследовать глобальные разрешённые корни.
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Limits ────────────────────────────────────────────────────────── */}
      <Card className="p-5 space-y-4">
        <div>
          <h2 className="text-base font-medium text-text-main">
            Очередь и лимиты
          </h2>
          <p className="text-sm text-text-muted">
            Ограничения, не дающие плохо ведущему себя агенту заполнить диск
            daemon&apos;s memory.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {NUMERIC_FIELDS.map((field) => (
            <Input
              key={field.key}
              label={field.label}
              type="number"
              value={config[field.key] ?? ""}
              onChange={(e) =>
                patch((prev) => ({
                  ...prev,
                  [field.key]:
                    e.target.value === "" ? undefined : Number(e.target.value),
                }))
              }
              hint={field.hint}
            />
          ))}
          <Input
            label="Журнал аудита"
            value={config.auditFile || ""}
            onChange={(e) =>
              patch((prev) => ({ ...prev, auditFile: e.target.value }))
            }
            hint="JSONL-файл, записывающий каждую выполненную задачу. Пусто = без журнала."
            inputClassName="font-mono"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-text-main">
            Разрешённое окружение
          </label>
          <textarea
            value={(config.envAllowlist || []).join("\n")}
            onChange={(e) =>
              patch((prev) => ({
                ...prev,
                envAllowlist: e.target.value
                  .split("\n")
                  .filter((s) => s.trim()),
              }))
            }
            rows={Math.max(3, (config.envAllowlist || []).length)}
            spellCheck={false}
            className="mt-1.5 w-full rounded-[10px] bg-surface-2 border border-transparent px-3 py-2 font-mono text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
          <p className="mt-1 text-xs text-text-muted">
            Хостовые переменные, копируемые в задачу. Всё, что не указано — в
            том числе секреты из <code className="text-text-main">.env</code> —
            никогда не попадает в команду.
          </p>
        </div>
      </Card>

      {/* ── Сохранение ──────────────────────────────────────────────────────────── */}
      <Card className="p-5 space-y-4">
        <div>
          <h2 className="text-base font-medium text-text-main">Сохранение</h2>
          <p className="text-sm text-text-muted">
            Saving signs the whole list with your dashboard password and hands
            it to the host daemon — the only thing that can write the file. The
            password is checked here for a quick answer and checked again on the
            host; it is never stored, and it is cleared from this page after
            every save.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Input
            label="Пароль дашборда"
            required
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFormError("");
            }}
            placeholder="обязателен для сохранения"
            inputClassName="font-mono w-72"
            disabled={!writable || saving}
            hint={
              writable
                ? "Тот же пароль, которым вы входите в этот дашборд."
                : "Недоступно, пока демон не запущен и не настроен."
            }
          />
          <Button
            onClick={save}
            disabled={saving || !writable || !password || !dirty}
            loading={saving}
          >
            {saving ? "Сохранение…" : "Сохранить whitelist"}
          </Button>
          {dirty && (
            <span className="text-sm text-text-muted">
              Несохранённые изменения
            </span>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setLoading(true);
              setFormError("");
              setRefreshKey((k) => k + 1);
            }}
            disabled={saving}
          >
            Обновить
          </Button>
        </div>
      </Card>
    </div>
  );
}
