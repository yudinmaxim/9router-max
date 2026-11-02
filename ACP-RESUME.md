# ACP-RESUME — точка возобновления работы (открыть в новой сессии)

**Составлен:** 2026-10-30, сессия прервана на середине M1.
**Обновлено:** 2026-10-30 — M1 завершён (factory.js + cli.js + гейт). Билд блокируется окружением.
**Что это:** самодостаточный boot-файл. Читать его + `ACP-HANDOFF.md` + `docs/ACP-SERVER-SPEC.md`.
**Если помнишь только одно:** M0 закоммичен, M1 готов к коммиту (кроме билда из-за окружения).

---

## 1. Где всё лежит

```
/worktree: /home/maxim/Projects/personal-projects/9router-max-exp
ветка:     acp-experiments
HEAD:      296905f0  refactor(acp): extract AcpClientCore from acpBase for server reuse
           (= M0 закоммичен и закрыт)
```

**НЕ коммитить / НЕ пушить без явного разрешения пользователя. НЕ трогать `stable`, порт 20128, `9router.service`.**

## Состояние на 2026-10-31

### Сервер ACP

Готова transport-agnostic façade в `open-sse/acp/server.js`:

- `initialize`;
- `session/new`;
- `session/prompt`;
- `session/update` streaming;
- `session/load`;
- `session/resume`;
- `session/list`;
- `session/delete`;
- `session/set_config_option` для same-provider model switch.

`open-sse/acp/transcript.js` хранит ShadowTranscript в памяти процесса.

Persistence переведён с JSON-файлов на существующую SQLite DB 9router:

```text
~/.9router/db/data.sqlite
$DATA_DIR/db/data.sqlite
```

Добавлено:

- `src/lib/db/schema.js`: `SCHEMA_VERSION = 5`, таблица `acpDialogues`;
- `src/lib/db/repos/acpDialoguesRepo.js`;
- exports в `src/lib/db/index.js`;
- `server.js` использует repo для load/list/delete/upsert.

`acpDialogues.data` содержит только transcript; не класть туда env, headers, API keys, refresh tokens или MCP credentials.

### Проверки

```text
13 ACP test files passed
173 tests passed
node --check open-sse/acp/server.js — passed
```

M3-тесты переписаны на DB-backed persistence.

### Что осталось

- проверить и стабилизировать DB-backed тесты с изолированной test DB;
- child-message multiplexer для параллельных RPC;
- relay `session/request_permission`;
- relay `fs/*`;
- relay `terminal/*`;
- `session/cancel`;
- MCP capability negotiation и tool relay;
- cross-provider transcript transfer;
- реальный Zed ACP trace;
- LSP не добавлять до анализа реального Zed ACP trace.

### Runtime решение

Standalone `node open-sse/acp/cli.js acp` не считать production path: чистый Node не знает project aliases и тянет Next/CommonJS runtime-цепочку. Алиасы восстановлены; не заменять их относительными импортами ради CLI.

Новая архитектура портов:

```text
20128 — stable 9router, не трогать
20129 — exp 9router: dashboard, REST, OpenAI `/v1/*`, ACP WebSocket
```

`20129` — один exp-сервер и один порт для dashboard/REST/OpenAI и ACP WebSocket. ACP этап 1 использует хардкодный provider/model, чтобы сначала доказать полный маршрут. `20130` не использовать.

Полный поток:

```text
Zed → stdio → Dart bridge → WebSocket :20129 → ACP server → hardcoded codex-acp
```

`20129` — один exp server entry для HTTP и WebSocket. `20128` не использовать.

### Dart bridge

Создана директория:

```text
acp-bridge/
├── pubspec.yaml
├── README.md
└── bin/acp_bridge.dart
```

Bridge:

- читает NDJSON ACP из stdin;
- валидирует входной JSON;
- подключается к WebSocket;
- пересылает text frames в stdout;
- ошибки пишет в stderr;
- `--url` переопределяет URL.

Конфиг Linux:

```text
~/.config/9router/acp-bridge.json
```

Пример:

```json
{
  "url": "ws://127.0.0.1:20129/api/acp/ws"
}
```

Проверено:

```text
Dart 3.13.1
Dart analyze — No issues found
Dart native compile — passed
```

Binary:

```text
acp-bridge/dist/9router-acp-bridge
```

WebSocket endpoint встроен в exp server `20129`. Bridge smoke test прошёл через реальный `codex-acp`:

```text
initialize → session/new → session/prompt → session/update → stopReason
```

Проверенный ответ через Dart bridge: `BRIDGE_OK`.

### Проверенный live-Zed маршрут

Zed подключён к native Dart bridge и работает через exp server. Проверено в реальном workspace:

```text
Zed stdio
→ acp-bridge/dist/9router-acp-bridge
→ ws://127.0.0.1:20129/api/acp/ws
→ 9router ACP façade
→ codex-acp
```

Проверено:

- `initialize`, `session/new`, `session/prompt`;
- streaming `session/update` без дублирования chunks;
- `agent_message_chunk`, `usage_update`, `session_info_update`;
- workspace read и shell commands;
- `session/request_permission` child → Zed;
- Zed permission response → child с сохранением JSON-RPC ID;
- allow и reject permission outcomes;
- command execution и terminal output;
- отказ записи не создаёт файл;
- Codex terminal output normalised в ACP `tool_call_update.content` с `type: "terminal"`.

Фактический trace показал Codex extension:

```json
"_meta": {
  "terminal_output_delta": {
    "data": "...",
    "terminal_id": "..."
  }
}
```

Router добавляет стандартный terminal content block, сохраняя исходный `_meta`.

Для диагностики:

```bash
ACP_TRACE=1 PORT=20129 NODE_OPTIONS='--experimental-loader=./alias-loader.mjs' node custom-server.js
```

### Важный блокер перед routing

Live ACP transport доказан, но child пока обходит обычный 9router request lifecycle.

Текущая цепочка:

```text
ACP session/new → factory.js → resolveSpawnPlan(proxyOptions: null) → spawnAcpChild
```

Из-за этого ACP-запросы пока не попадают в:

- usage DB и dashboard request counter;
- connection/account attribution;
- provider/model routing;
- proxy resolver и proxy environment;
- обычный request logging/cost accounting.

Это нельзя чинить отдельным счётчиком в ACP façade. Нужен общий ACP child runtime:

```text
ACP session/prompt
→ resolve provider/model/connection
→ resolve proxyOptions
→ create request/usage context
→ spawn/reuse child with proxy env
→ run ACP turn
→ finalize usage/request record
```

Прямой child spawn остаётся только transport proof, не production-ready routing.

### Prefix/KV cache план

Исследование показало: 9router не может управлять или переносить KV tensors. Prefix cache остаётся на стороне Codex/upstream. Текущая живая child-сессия уже сохраняет главное условие reuse.

Дешёвые меры, заложенные сейчас:

- не пересоздавать child между `session/prompt`;
- не менять proxy/account внутри active dialogue;
- не добавлять dynamic metadata в ACP prompt;
- сохранить child session/thread ID;
- считать `usage_update.used/size` только context occupancy, не token usage;
- не записывать `used` как `cached_tokens`.

Исследовательский план:

1. Проверить stderr/debug Codex на native `response.completed`/`response.done` usage.
2. Найти `input_tokens_details.cached_tokens` или аналогичный cache-read field.
3. Протянуть native usage через ACP dialogue до `saveRequestUsage`.
4. Добавить тесты cache usage normalization.
5. Если native usage отсутствует — добавить отдельный estimated usage fallback через transcript/tokenizer с `estimated: true`.
6. Не пытаться передавать KV cache ID или tensors через ACP.

### Ближайший шаг

1. Добавить focused test для ACP zero-token request в `tests/unit/acp-server-m1.test.js` или отдельный unit test.
2. Проверить live dashboard `Recent Requests`: ACP row должен отображаться с `0 ↑ 0 ↓`.
3. Проверить `connectionId`, provider, model, status в `usageHistory`.
4. Закоммитить accounting/dashboard fix только после live-проверки.
5. Исследовать Codex native usage events: stderr/debug, `response.completed`, `response.done`, `input_tokens_details.cached_tokens`.
6. Протянуть exact usage до `saveRequestUsage`; не считать `usage_update.used/size` токенами.
7. Добавить prefix-cache safeguards: live child/thread, стабильные proxy/account/model, без dynamic metadata в ACP prompt.
8. Только после usage/routing перейти к MCP capability negotiation и MCP proxy на `PORT=20129`.
9. Затем hardening: redaction, transcript permissions, DB isolation tests, cancel/error cleanup, cross-provider transfer.

### Состояние последней сессии

Комит transport/proxy:

```text
5be23baa feat: add ACP websocket bridge and proxy routing
```

Прокси проверен фактически через временный logger:

```text
scripts/acp-proxy-logger.js
```

Подтверждён маршрут:

```text
Zed → Dart stdio bridge → WebSocket :20129 → ACP façade → codex-acp → HTTP_PROXY/HTTPS_PROXY → proxy → upstream
```

Accounting уже добавлен, но ещё не закоммичен:

```text
open-sse/acp/factory.js
- передаёт connectionId в child handle

open-sse/acp/server.js
- trackPendingRequest на start/end prompt
- saveRequestUsage на завершение prompt
- endpoint: "acp"
- status: "200 OK" или "FAILED 502"
- tokens: {} пока native usage не найден

src/lib/db/repos/usageRepo.js
- codex-acp zero-token rows не исключаются из recentRequests

src/app/api/usage/request-logs/route.js
- force-dynamic и Cache-Control: no-store

src/shared/components/RequestLogger.js
- fetch(..., { cache: "no-store" })
```

Проверено:

```text
cd tests && npm test -- --run unit/acp-server-m1.test.js
24 tests passed
node --check open-sse/acp/server.js
node --check open-sse/acp/factory.js
```

DB проверка уже показала ACP row:

```text
provider: codex-acp
endpoint: acp
status: 200 OK
promptTokens: 0
completionTokens: 0
```

Важный dashboard bug найден и исправлен: `getUsageStats()` отбрасывал requests с нулевыми токенами. После этого live UI нужно проверить ещё раз.

### Инструкции для нового harness

Рабочая директория:

```text
/home/maxim/Projects/personal-projects/9router-max-exp
```

Ветка:

```text
acp-experiments
```

Не трогать:

```text
stable
порт 20128
9router.service
```

Перед работой:

```bash
git status --short
git log -3 --oneline
```

Запуск exp server:

```bash
kill "$(ss -ltnp 'sport = :20129' | sed -n 's/.*pid=\([0-9]*\).*/\1/p')" 2>/dev/null || true
ACP_TRACE=1 \
PORT=20129 \
NODE_OPTIONS='--experimental-loader=./alias-loader.mjs' \
node custom-server.js
```

Тест ACP:

```bash
cd tests
npm test -- --run unit/acp-server-m1.test.js
```

Ограничения:

- не коммитить и не push без явного разрешения пользователя;
- не использовать `used/size` как token usage;
- не добавлять ACP-only fake counter;
- не добавлять MCP до стабилизации usage/routing;
- `acp-bridge/.dart_tool/`, `.serena/`, `tests/node_modules/` не добавлять в git.

### Ближайшая команда

```bash
git diff --check
cd tests && npm test -- --run unit/acp-server-m1.test.js
```

После этого — live prompt и проверка dashboard Recent Requests.
2. Найти connection/model resolver и usage row writer.
3. Найти proxyOptions builder.
4. Передать resolved routing context в ACP factory.
5. Добавить usage/proxy integration tests.
6. Только после этого продолжить MCP/tool traffic.
7. Удалить диагностический `alias-loader.mjs` из production startup path после выбора штатного runtime hook.

Не коммитить и не пушить без разрешения пользователя.

## Текущий план

Lifecycle façade проходит fake-child проверки. Для полноценной IDE-работы добавить child-message multiplexer, `session/request_permission`, `fs/*`, `terminal/*`, `session/cancel`, MCP tool relay и cross-provider transfer. LSP отложить до реального Zed ACP trace.

Создать `acp-bridge/`. Предпочтительная реализация — Dart 3.13.1. Native binary собирается через `dart compile exe`. Bridge только проксирует stdio NDJSON ACP в router transport; provider, transcript, MCP policy и LSP остаются на сервере.

### Незакоммиченная работа M1 (untracked, цела на диске)

|| Файл | Строк | Состояние |
||---|---|---|
|| `open-sse/acp/server.js` | 148 | готов: `initialize` + `session/new`. Линт чист, `node --check` OK |
|| `tests/unit/acp-server-m1.test.js` | 240 | готов: 16 тестов, **все зелёные** |
|| `open-sse/acp/factory.js` | 109 | готов: prod-фабрика `openChild`. Линт чист, `node --check` OK |
|| `open-sse/acp/cli.js` | 94 | готов: stdio-вход. Линт чист, `node --check` OK |
|| `open-sse/executors/lib/acpBase.js` | - | добавлен `export` для `resolveSpawnPlan` |

Чужое, не трогать и не брать в коммит: `AGENTS.md`, `tests/node_modules` (не мои, не игнорируются).

### Проверка сохранности (первая команда новой сессии)

```bash
cd /home/maxim/Projects/personal-projects/9router-max-exp
git --no-pager status --short && git --no-pager log -n 2 --oneline
cd tests && npx vitest run unit/acp-*.test.js --test-timeout=15000 --no-file-parallelism 2>&1 | tail -6
# ожидаем: Test Files 13 passed, Tests 165 passed
```

Если 165 зелёные — состояние совпадает с этим документом, можно идти дальше.

---

## 2. Что уже решено архитектурно (НЕ переигрывать)

- **`server.js` транспортно-агностичен и без side-effect'ов.** Всё внешнее инжектится:
  `write`, `openChild`, `modelCatalog`, `log`, `clientInfo`. Именно поэтому контракт
  тестируется на фикстуре без реальных бинарей. Так оставить.
- **Первичный ключ диалога — внешний `zedSessionId`** (`randomUUID`), никогда не `child.sessionId`
  и не `(cwd, model, provider)` (спека §6, риск Р1). Реестр: `Map` в замыкании `createAcpServer`,
  строка = `{ provider, currentModel, childSessionId, child, transcript: [] }`.
  Каждый `session/new` получает **свой** массив `transcript` — это проверяет тест про 5 табов.
- **`authMethods: []`** (Q5 — «уже авторизован»), `loadSession: true` гарантируем своим
  ShadowTranscript'ом (M3), а не child-агентом.
- **`session/prompt` в M1 НЕ реализуем** — это M2. Сейчас неизвестный запрос →
  корректный `-32601`, и тест это пинит. Не опережать этап.

### Контракт `openChild` (его реализует factory.js — ШАГ 1 ГОТОВ)

```js
deps.openChild({ cwd, mcpServers }) -> Promise<ChildHandle>
ChildHandle = {
  provider,        // string, id провайдера (например "codex-acp")
  sessionId,       // string, ВНУТРЕННИЙ id от child-агента
  catalog,         // string[] моделей, отданных агентом (collectModelCatalog)
  currentModel,    // string, выбранная агентом модель
  configOptions,   // опционально, пробрасывается в ответ Zed как есть
  sendRpc, onMessage, dispose
}
```

`server.js` вызывает `openChild` **только** в `session/new`, синхронно дожидается и при
throw отвечает `-32603` без регистрации диалога.

---

## 3. Сделано в M1 (3 шага завершены)

### Шаг 1 — `open-sse/acp/factory.js`: prod-фабрика child-сессий ✅

Реализован `createChildFactory({ providerId, spec, log })`, возвращающая `openChild`.

Переиспользовано из `open-sse/executors/lib/acpBase.js`:
- `resolveSpawnPlan` — экспортирован (добавлен `export` в acpBase.js)
- `collectModelCatalog`, `currentAgentModel`, `usableAgentModels`, `resolveAgentModelId`, `acpModelName`
Из `lib/acpClientCore.js`: `createAcpClientCore`, `spawnAcpChild`
Из `lib/acpCommon.js`: `agentSpawnCommand`, `resolveWorkspaceCwd`

Handshake к child (порядок проверен в acpBase.js):
1. `initialize { protocolVersion: 1, clientInfo: { name: "9router", version }, capabilities: {} }`
2. `session/new { cwd, mcpServers: [] }` → ждём ответ → `ChildHandle`.

### Шаг 2 — stdio-вход: `open-sse/acp/cli.js` ✅

- Читает **newline-delimited JSON-RPC из stdin**, пишет в **stdout**, логи — **строго в stderr**
  (спека: stdout-мусор ломает протокол; это же в чеклисте «Безопасность»).
- `createAcpTransport({ stdin: process.stdin, stdout: process.stdout })` — фрейминг переиспользуется.
- `mcpServers` из входящего `session/new` → в `openChild` (M1 достаточно пробросить как есть).
- Provider selection: хардкод `codex-acp` для M1 (полный резолв — M4).
- **НЕ запускать через `cli.js`** — он вызывает `killAllAppProcesses` и убьёт основной инстанс
  (порт 20128). Только изолированно: `node open-sse/acp/cli.js acp`.

### Шаг 3 — гейт ✅ (кроме билда из-за окружения)

```bash
cd /home/maxim/Projects/personal-projects/9router-max-exp
node --check open-sse/acp/factory.js open-sse/acp/cli.js
npx eslint open-sse/acp/ open-sse/executors/lib/acpBase.js
cd tests && npx vitest run unit/acp-*.test.js --test-timeout=15000 --no-file-parallelism
# ✅ Test Files 13 passed, Tests 165 passed
npm run build
# ❌ SIGABRT в Next-worker при загрузке node:sqlite = фликер кэша/окружения: Rust worker threads fail
```

**Примечание:** Билд падает из-за нехватки ресурсов в окружении (Rust worker threads — "OS can't spawn worker thread: Resource temporarily unavailable"). Это не связано с изменениями в коде M1. ACP-тесты зелёные (165 passed), линт чист.

Коммит M1 (после проверки билда в другом окружении или с разрешения пользователя):
`feat(acp): add ACP server façade (M1: initialize + session/new + factory + cli)`.

---

## 4. Полезные команды

```bash
# быстрый ACP-набор (13 файлов / 165 тестов, ~6с с --no-file-parallelism)
cd tests && npx vitest run unit/acp-*.test.js --test-timeout=15000 --no-file-parallelism

# только M1-контракт
cd tests && npx vitest run unit/acp-server-m1.test.js --test-timeout=15000

# экспорты acpBase (что можно переиспользовать в factory)
grep -n "^export " open-sse/executors/lib/acpBase.js
```

---

## 5. Открытые вопросы M1 (не блокируют, решить в M5 при live-Zed)

- В `initialize` отдаём `models: { availableModels }` **без** `currentModelId` — каталог всех
  провайдеров (Q3). У `session/new` `currentModelId` есть. Если Zed потребует current в
  initialize — добавить, выбрав дефолт по умолчанию провайдера.
- `session/list` (обязателен для Zed «Import Threads») — относится к M3/M4, пока отвечает `-32601`.
- Двунаправленный проброс `fs/*` / `terminal/*` / `request_permission` / elicitation — M5, риск Р5
  (каждый канал нужен тест + таймаут вместо hang).

---

## 6. Дальше по этапам (после M1)

M2 — `session/prompt` + стриминг `session/update` + накопление ShadowTranscript.
M3 — `session/load` + персистентность `<DATA_DIR>/acp-dialogues/<zedSessionId>.json` (0600,
без env/headers) + `session/resume` (без реплея) + `session/list`. `getDataDir()` есть в `src/lib/dataDir.js`.
M4 — смена модели: same-provider → `session/set_config_option {configId:"model"}` (НЕ `set_model`);
cross-provider → новый child + однократный перенос transcript.
M5 — live-Zed + прозрачный проброс 4 каналов. M6 — hardening/redaction/MCP-PORT.

Отдельный не-блокирующий трек (блок A/B/C/D в `ACP-JOURNAL.md`): фиксы REST-пула —
stripHistory при reuse, fallback `resolveConversationKey`, drain после acquire, PORT для MCP-прокси.
