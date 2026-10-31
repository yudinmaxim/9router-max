# Журнал изменений — 9router-max (ACP-путь)

**Начало:** 2026-10-28
**Текущая ветка (основная):** `stable` (c9a8f472)
**Текущая ветка (эксперимент):** `acp-experiments` (98e2d3ac)

---

## 2026-10-28 — Аудит: потеря контекста, сессии, client-tools

### Найдено

#### 1. Потеря контекста (модели обрываются на полшага) — КРИТИЧНО

**Место:** `open-sse/executors/lib/acpBase.js:454`

```js
const guardedBody = stripHistoryForContext(b, contextWindow);
```

**Проблема:** `stripHistoryForContext()` вызывается на **каждом** шаге turn, включая переиспользуемые (pooled) сессии. Это значит, что история усечается итеративно: turn 1 → 80% окна, turn 2 → 80% от уже усечённого, turn 3 → ещё меньше. За 10–20 шагов диалог сужается до нескольких сообщений.

**Почему не замечено:** тесты пула (`acp-pooled-reuse.test.js`) используют фейкового child, который не вызывает `stripHistoryForContext`. В тестах история остаётся целой.

**Решение:** пропускать `stripHistoryForContext` при reuse pooled сессии. Усечение нужно только при fresh spawn. Альтернатива — хранить усечённый prompt в пуле и не трогать body при reuse.

#### 2. Ситуативное разделение сессий — СРЕДНЕ

**Место:** `open-sse/utils/sessionManager.js` → `resolveConversationKey()`

**Проблема:** `resolveConversationKey()` возвращает `""` когда у запроса нет явного session ID и текст ассистента < 50 символов. Пустой ключ = `sessionIdentity = null` = `sessionKey = null` = **пулинг пропускается**, каждый turn спавнит новый процесс.

**Сценарий:** короткое приветствие в новом диалоге → `""` → нет пула → новый процесс → модель не видит предыдущий контекст (если клиент не присылает full history).

**Решение:** если ключ пустой, но connectionId есть — использовать fallback на connectionId + cwd, но с уникальным суффиксом (например, hash от body hash), чтобы не слить диалоги.

#### 3. Client-tools иногда отваливаются — СРЕДНЕ

**Место:** `open-sse/executors/lib/acpClientTools.js` → `drainToolCallSink()`

**Проблема:** `drainToolCallSink()` полностью очищает sink (`fs.writeFileSync(sink, "")`). Если между drain и startPrompt мост записывает вызов, он теряется. Конкурентные turns в одной пуловой сессии могут перетирать sink друг другу.

**Синхронизация:** `acquireAcpSession()` + `acquireAcpSession().release` обеспечивают сериализацию, но `drainToolCallSink` вызывается **до** acquire (в строке 548 acpBase.js, до `acquireAcpSession` в reuse-ветке). Нужно перенести drain в секцию после acquire.

**Решение:** переместить drain в секцию reuse-branch, сразу после `acquireAcpSession()`.

#### 4. MCP-прокси может указывать на неверный порт

**Место:** `src/lib/mcp/proxyTargets.js:12`

```js
const port = Number(process.env.PORT) || 20128;
```

**Проблема:** экспериментальный worktree (`9router-max-exp`) запускается на порту 20129, но если `PORT` не установлен, по умолчанию 20128. Агент получит URL на неправильный порт.

**Решение:** проверить, что PORT передаётся в env при спавне агента в worktree.

---

## Запланировано

### Блок A: Контекст (потеря истории)
- [ ] A1. Пропускать `stripHistoryForContext` при pooled reuse
- [ ] A2. Добавить тест: pooled session с длинной историей, проверка что история не сжимается
- [ ] A3. Проверить impact на capacity-adapter модели (они получают усечённый body, но при reuse — нет)

### Блок B: Сессии (разделение диалогов)
- [ ] B1. Fallback для `resolveConversationKey`: connectionId + unique suffix
- [ ] B2. Добавить тест: два диалога, один connection, одинаковая модель — не сливаются

### Блок C: Client-tools (отвалы)
- [ ] C1. Перенести drainToolCallSink в секцию после acquireAcpSession
- [ ] C2. Добавить тест: drain после acquire, sink не теряется

### Блок D: MCP
- [ ] D1. Проверить PORT в env для экспериментального worktree
- [ ] D2. Протестировать MCP-прокси на порту 20129

---

## 2026-10-29 — M0: вынос AcpClientCore + разбор мегаметода (реализация спеки ACP-сервера)

Цель M0: подготовить переиспользуемое клиентское ядро для будущей ACP-серверной
ипостаси (G2 спеки) и привести `acpBase.js` в состояние, пригодное для надстройки,
НЕ меняя REST-поведение. Разбит на два прохода, чтобы каждое сравнение
поведения оставалось чистым.

### M0-a — вынос ядра (ГОТОВО ✅)
- `open-sse/executors/lib/acpClientCore.js`: `spawnAcpChild` + `createAcpClientCore`
  (id-счётчик, sendRpc/sendRpcRaw, onMessage, respondTo/failTo, endStdin,
  scheduleKill, dispose). Протокольные РЕШЕНИЯ (policy, pooling, SSE, pinning) —
  остались у вызывающего.
- `acpBase.js` переведён на ядро: убраны inline `spawn`, `createAcpTransport`,
  `idCounter`, `stdinClosed`, `killTimer`.
- Гейт: 65 ACP-тестов зелёные; полный прогон — 0 новых падений против снимка «до».
  (3 падения golden-url-header — платформозависимость macOS→Linux, были и до.)
- `npm run build` — ок (первый SIGABRT был фликером кэша Next.js+sqlite, чистый
  `.next` собирает чисто).

### M0-b — разбор мегаметода execute() (ЧАСТИЧНО ✅)
Чистый extract-function, поток управления 1:1, решений не меняем:
- [x] `deriveSessionIdentity()` — conversationKey → sessionIdentity/sessionKey
- [x] `resolveSpawnPlan()` — env/прокси/bin/adapter
- [x] `buildPermissionPolicy()` + `buildSessionDefaults()` — слияние header/body/dashboard
- [ ] `buildClientToolBridge()` — mcp-мост, sink, knownTools (отложено: не блокирует M1)
- [ ] emission-блок + `createMessagePump()` (пофазные обработчики) — отложено:
      чистая косметика читаемости, трогает самый хрупкий живой код, не нужен для M1.
      Делать отдельным коммитом позже.
Гейт после каждого extract: ACP-тесты + before/after diff падений.

### Итог M0 (вердикт гейта)
- Ядро `acpClientCore.js` (140 строк) готово к переиспользованию в M1-сервере.
- Полный прогон: 85 baseline-падений + 3 golden-снапшота (macOS→Linux) на месте,
  **0 ACP-регрессий** против снимка чистого HEAD.
- `usage-account-stats` (2 падения) — внешний шум: воспроизводятся на голом HEAD
  (проверено stash), к ACP-пути не относятся.
- `npx eslint` изменённых файлов — чисто. `npm run build` — ок.

---

## 2026-10-30 — M1: ACP-серверная façade (initialize + session/new) — ЗАВЕРШЁНО ✅

M0 закрыт коммитом `296905f0`. M1 закоммичен `e5581fc4`.

### Сделано
- `open-sse/acp/server.js` (148 строк) — `createAcpServer({ write, openChild, modelCatalog, log, clientInfo })`.
  Транспортно-агностичен, без side-effect'ов: всё внешнее инжектится, поэтому контракт
  тестируется на фикстуре без реальных бинарей. Реализованы `initialize` (protocolVersion 1,
  честные agentCapabilities, `authMethods: []`, каталог всех моделей — Q3) и `session/new`
  (открывает child, регистрирует диалог по **внешнему** `zedSessionId`, возвращает models/configOptions).
  Неизвестный запрос → `-32601`, уведомление → без ответа, ошибка openChild → `-32603` без
  регистрации, отсутствующий cwd → `-32602`. Линт чист.
- `open-sse/acp/factory.js` (109 строк) — prod-фабрика `openChild` поверх `resolveSpawnPlan` + `createAcpClientCore`
  + handshake `initialize`→`session/new`. Добавлен `export` для `resolveSpawnPlan` в acpBase.js.
- `open-sse/acp/cli.js` (94 строки) — stdio-вход (NDJSON из stdin в stdout, логи в stderr).
  Переиспользует `createAcpTransport` для фрейминга. Provider selection: хардкод `codex-acp` для M1.
- `tests/unit/acp-server-m1.test.js` (240 строк) — **16 golden-тестов, все зелёные**: транскрипт
  исходящих кадров + изоляция (5 tabов → 5 записей, у каждого свой `transcript`), мультиплекс
  одного child без слияния диалогов, гигиена транспорта.
- ACP-набор целиком: `unit/acp-*.test.js` → 13 файлов / **165 тестов зелёные**.
- Билд: прошёл с `NEXT_PRIVATE_DISABLE_TURBOPACK=1` (turbopack падал из-за Rust worker threads в окружении).

---

## 2026-10-31 — план расширения ACP и bridge

Текущая серверная façade достаточна для первичной проверки связки на fake child и подготовки smoke-теста. Lifecycle сам по себе недостаточен для полноценной IDE-работы.

Добавлено в план:

- общий child-message multiplexer для параллельных RPC;
- прозрачный relay `session/request_permission` child ↔ Zed;
- прозрачный relay `fs/*` child ↔ Zed;
- прозрачный relay `terminal/*` child ↔ Zed;
- `session/cancel`;
- MCP capability negotiation и tool relay; серверный MCP loop пока не делать;
- cross-provider transcript transfer;
- реальный Zed ACP trace;
- LSP не добавлять до обнаружения фактических Zed ACP extension methods.

## Портовая схема и фактический поток

Экспериментальный worktree запускается как полная копия 9router на `20129`; старый stable остаётся на `20128`.

ACP listener должен использовать тот же exp-сервер и порт `20129`, что dashboard/REST/OpenAI:

```text
20128 stable 9router
20129 exp 9router REST/dashboard/OpenAI
20129 exp ACP WebSocket + HTTP
```

Фактический поток:

```text
Zed → stdio → Dart bridge → WebSocket :20129 → ACP server → выбранный provider agent CLI
```

Bridge имитирует внешний console tool и только транслирует ACP JSON-RPC. ACP server выбирает модель/provider, запускает соответствующий agent CLI, держит session state и проксирует живой ACP protocol. `20129` использует тот же Next/Node server и не поднимает второй полный instance.

## Console bridge

Нужна отдельная консольная утилита внутри репозитория. Production-задача bridge:

```text
Zed stdio NDJSON ACP ↔ bridge ↔ router server transport
```

Bridge не знает providers, transcript, MCP policy или LSP. Он только проксирует кадры,
держит stdout чистым и пишет диагностику в stderr.

Проверены доступные toolchains:

- Dart 3.13.1 — установлен, подходит для статического native binary через `dart compile exe`;
- Go 1.26.7 — установлен;
- Rust 1.94.1 — установлен.

Предпочтение владельца — Dart. Начать с Dart bridge-прототипа и compile smoke test.

