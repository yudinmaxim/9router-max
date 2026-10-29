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

*Продолжение следует...*
