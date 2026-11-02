# Спецификация: ACP-серверная сторона 9router (9router как External Agent для Zed)

Дата: 2026-10-29
Ветка: `max` (реализация — в экспериментальном worktree `9router-max-exp`, порт 20129)
Статус: ПРОЕКТ, до утверждения пользователем. Код не трогаем до зелёного света.

---

## 1. Контекст и проблема

Сейчас 9router умеет говорить по ACP только **как клиент**: `open-sse/executors/lib/acpBase.js`
спавнит внешнего ACP-агента (`codex-acp`, `claude-acp`, `opencode` …) как stdio-процесс и ходит
к нему по JSON-RPC. Наружу (для IDE) 9router отдаёт только **REST** (`/v1/chat/completions`,
`/v1/messages`).

Отсюда корень всех проблем с контекстом:

- REST-клиент (Zed-Model-Provider, Claude Code, любой OpenAI-совместимый) **по протоколу每次 шлёт
  всю историю** в `messages[]`. 9router обязан либо переслать её внутреннему агенту заново, либо
  порезать.
- `stripHistoryForContext` режет middle безусловно (`HEAD_KEEP=6`), теряя `tool_result` → модель
  «забывает» прошлые шаги.
- Пул сессий (`acpSessionPool.js`) должен спасать от пересылки, но `resolveConversationKey` даёт
  хрупкий ключ (хэш текста) → при пустом/коротком диалоге `conversation=""` → пул скипается →
  fresh-spawn на каждый ход → пересылка всей истории → обрезка.

**Суть решения:** дать 9router вторую ипостась — **ACP-агент** (серверную). Тогда живой клиент
(Zed External Agent) сам держит сессию и шлёт **только дельту**, история живёт на стороне
внутреннего агента, а не пересылается текстом. Проблема контекста рассасывается на уровне
транспорта, а не костылями.

---

## 2. Цели

- G1. 9router спавнится Zed-ом как External Agent (`agent_servers` → stdio), отвечает на ACP v1.
- G2. 9router маршрутизирует каждый входящий диалог во **внутренний** ACP-агент (codex-acp и др.),
  переиспользуя существующий клиентский слой (`acpBase`-машинерия).
- G3. Строгая изоляция диалогов: 5 табов в одном проекте/модели не сливаются.
- G4. Смена модели внутри провайдера — контекст сохраняется (тот же child).
  Смена провайдера — перенос контекста в нового child ровно один раз на переключение.
- G5. Восстановление диалога после рестарта Zed — через `session/load` (реплей из shadow-transcript).
- G6. Не сломать REST-путь и пул. ACP-сервер — **надстройка**, а не замена.

## 3. Не-цели (явно)

- N1. Не делаем 9router MCP-сервером и не строим server-side tool loop на первом этапе. MCP/FS/terminal/permission/IDE requests прозрачно пробрасываются между child ACP и Zed, пока protocol trace не уточнит точные формы.
- N2. Не трогаем stable на `20128`. Exp 9router работает на `20129`; ACP WebSocket использует тот же сервер и порт.
- N3. Не решаем вопрос ToS OpenAI/Codex здесь — он остаётся на пользователе.
- N4. Не добавляем provider/model switching и context compression до рабочего end-to-end smoke test.
- N5. Не строим отдельный web-UI для ACP.

---

## 4. Транспорт и этапы реализации

Zed видит один External Agent, но stdio держит отдельный bridge. 9router не запускается как
standalone ACP-процесс: он остаётся обычным сервером и добавляет WebSocket endpoint.

```json
"agent_servers": {
  "9router": {
    "type": "custom",
    "command": "9router-acp-bridge",
    "args": [],
    "env": {}
  }
}
```

Портовая схема:

```text
20128 — stable 9router, не трогать
20129 — exp 9router: dashboard, REST, OpenAI `/v1/*`, ACP WebSocket
```

```text
Zed
  → stdio ACP
  → Dart bridge
  → WebSocket ws://127.0.0.1:20129/api/acp/ws
  → AcpAgentServer
  → hardcoded real ACP agent CLI
  → AcpAgentServer
  → WebSocket
  → Dart bridge
  → Zed
```

Bridge — тупой transport adapter. Он не знает provider, model, transcript, MCP policy или LSP.
`AcpAgentServer` живёт внутри 9router runtime и использует `AcpClientCore` для child CLI.
Второй Next instance, второй 9router process и порт `20130` не используются.

### Этап 1 — рабочий маршрут

Provider и model хардкодны: `codex-acp` и default model child. Цель — end-to-end smoke test:
`initialize`, session lifecycle, prompt/update, files, permission requests, terminal/commands,
MCP/tool messages и все фактические IDE/LSP-related frames, которые пришлёт Zed.

Живой Dart bridge обязателен: через него подключается Zed и записывается реальный ACP trace.
Методы и capabilities не выдумывать до получения trace.

### Этап 2 — routing и контекст

После рабочего маршрута добавить по trace:

- provider/model resolution по составному model ID;
- same-agent model switch;
- cross-agent child replacement;
- shadow transcript persistence и transfer;
- controlled context compression с записью результата в transcript;
- MCP/fs/terminal/permission hardening;
- LSP extensions, если Zed действительно использует их через ACP.

---

## 5. Архитектура (компоненты)

```
Zed (ACP client)
   │  stdio JSON-RPC
   ▼
[ AcpAgentServer ]  ← новый: входящий контракт ACP v1, маршрутизация, реестр диалогов
   │  переиспользует
   ▼
[ AcpClientCore ]   ← вынести из acpBase.js: spawn + sendRpc + session/* к child-агенту
   │  stdio JSON-RPC
   ▼
[ child: codex-acp | claude-acp | opencode | … ]
```

- **AcpClientCore** — рефакторинг: из `acpBase.js` вынести низкоуровневый клиент
  (`spawn`, `sendRpc`, чтение `session/update`, обработка `session/request_permission`,
  `initialize`) в общий модуль, который используют И REST-executor (`acpBase`), И новый сервер.
  Дублирование протокольной машинерии — прямой путь к расхождению поведения.
- **AcpAgentServer** — реализует серверную ипостась: `initialize`, `session/new|load|resume|
  prompt|cancel|list|set_model|set_config_option`, испускает `session/update` в stdout.
- **DialogueRegistry** — маппинг `zedSessionId → { provider, model, childSessionId, entry, transcript }`.
  Переиспользует `acpSessionPool.js` как хранилище child/entry, но **ключ** меняет с хрупкого
  `resolveConversationKey` на устойчивый `zedSessionId` (см. §6).
- **ShadowTranscript** — линейный лог диалога, копится на лету из проходящих `session/update`
  (user/agent chunks, tool_call, tool_result). Нужен для `session/load`-реплея и переноса при
  смене провайдера.

---

## 6. Реестр диалогов и изоляция (G3)

Ключ изоляции — **внешний `sessionId`, который даёт Zed** (он переживает рестарт IDE), а НЕ
`(cwd, model, provider)` и НЕ child-процесс (ACP разрешает мультиплексить несколько сессий на
один child — смешали бы диалоги).

```
zedSessionId (неизменяемый, первичный ключ)
   → { provider, currentModel,
       childSessionId (мутабельный: новый при переспавне child),
       poolKey (внутр. ключ acpSessionPool для child-переиспользования),
       transcript: [...] }
```

Правила:
- Два разных `zedSessionId` → никогда не делят transcript, даже при одинаковых provider/model/cwd.
- `child`/`poolKey` может переиспользоваться между сессиями одного провайдера (агент сам
  мультиплексит), но transcript всегда привязан к `zedSessionId`.
- При `session/new` регистрируем запись; при `session/load` — ищем по `zedSessionId`, которого у
  нас **нет** (после рестарта процесс новый, реестр пуст) → см. §7: восстанавливаем из
  персистентного transcript, либо просим child-агент сделать `session/load` по его `childSessionId`.

### Персистентность

`acpSessionPool` — in-memory, при рестарте 9router-process всё теряется. Для `session/load` после
рестарта нужен **диск**: `<DATA_DIR>/acp-dialogues/<zedSessionId>.json` (transcript + провайдер-кэш).
Запись — по ходу диалога (debounced), чтение — на `session/load`.

Безопасность диска: transcript содержит весь текст диалога. Храним в `DATA_DIR`, права 0600.
**НЕ** пишем в transcript значения `env`/`headers` из MCP-конфигов (spec ACP §MCP Security прямо
требует).

---

## 7. Контракты методов ACP (серверная ипостась)

Таблица: входящий метод от Zed → действие → исходящее.

| Метод (Zed → 9router) | Действие 9router | Ответ / исходящее |
|---|---|---|
| `initialize {clientCapabilities, protocolVersion}` | сохранить caps клиента; собрать каталог моделей (все провайдеры) | `agentCapabilities: { loadSession:true, sessionCapabilities:{resume:{},close:{}}, promptCapabilities:{image:true,embeddedContext:true}, mcpCapabilities:{http:true} }`, `models`, `protocolVersion:1` |
| `session/new {cwd, mcpServers}` | резолв provider+model (из `_meta`/настроек), спавн/переиспольз child, `session/new` к child → `childSessionId`; регистрация по `zedSessionId` | `{ sessionId: <внешний id для Zed> }` + `models/modes/configOptions` |
| `session/load {sessionId, cwd, mcpServers}` | если child жив → делегировать `session/load` и транслировать реплей; иначе → восстановить из `<DATA_DIR>` transcript и **самим** испустить `session/update`-цепочку | `session/update`…(user/agent chunks) → `{}` |
| `session/resume {sessionId,…}` | восстановить контекст без реплея (child жив) | `{}` |
| `session/prompt {sessionId, prompt[]}` | пробросить дельту в child `session/prompt`; стримить ответ; копировать в transcript | `session/update` chunks → `{ stopReason }` |
| `session/set_config_option {sessionId, configId:"model", value}` (канал смены модели; `session/set_model` в нашем клиентском слое НЕ используется — см. acpBase.js:15,752,994) | та же модель/провайдер → `set_config_option model=…` в child (контекст цел); **смена провайдера** → спавн child нового провайдера + перенос transcript (один раз) | `{}` (+configOptions) |
| `session/set_mode` / прочие `set_config_option` (mode/thoughts) | пробросить в child | `{}` |
| `session/cancel {sessionId}` | пробросить `session/cancel` в child | (notification) |
| `session/list {cwd?}` | **обязателен для Zed «Import Threads»** (контракт external-agents): отдаём записи DialogueRegistry из `<DATA_DIR>/acp-dialogues/`, фильтруя по cwd; сессии без cwd пропускаем | `{ sessions: [...] }` |
| `session/delete {sessionId}` | удаляем запись реестра + transcript-файл + release child (если объявляли `delete` в caps) | `{}` |

**Принцип прозрачности (решено, см. §10 Q1/Q2):** 9router в ACP-серверном режиме — прозрачный
прокси, **сам решений не принимает**. Всё, что child-агент адресует клиенту, транслируется в Zed
дословно (с переписыванием только `sessionId` на внешний):

- `session/request_permission` от child → **проброс в Zed** как `session/request_permission`
  от нас (9router) к Zed. Ответ Zed → обратно child. Тихое авто-решение через `acpPermissions`
  (как в REST-`acpBase.js:1196`) в этом режиме **не** применяется.
- `fs/read_text_file` / `fs/write_text_file` от child → **проброс в Zed** (он держит редакторские
  бафферы,Undo и песочницу). 9router сам файлы не читает.
- `terminal/*` от child → **проброс в Zed** (у него отработанный терминал).
- `elicitation/create` от child → **проброс в Zed**.

Обратная сторона: capability-переговорный handshake. В `initialize` от child мы объявляем
**клиентские** capabilities = `fs{read,write} + terminal + elicitation`, только если Zed в своём
`initialize` к нам их объявил (тогда проброс легален). Иначе — честно отвечаем ошибкой
`method not found`, не имитируем поддержку.

### Смена провайдера (G4) — детально

1. `set_model`/`set_config_option{model}` даёт `newModelId`. Определяем `newProvider` по каталогу.
2. `newProvider === currentProvider` → `set_config_option model=…` в тот же child. Transcript не
   трогаем, токены не тратим. **Контекст сохраняется агентом.**
3. `newProvider !== currentProvider` →
   - берём transcript **только этого** `zedSessionId`;
   - спавним child нового провайдера, `session/new`;
   - один раз вливаем transcript (сериализованный) в `session/prompt` нового child как «историю
     импорта» (fresh-путь, но однократно);
   - обновляем `childSessionId` в реестре; старый child → release/TTL.
4. Флаг `announceModelSwitch` (по умолчанию `false`): если `true` — в начало переноса добавляем
   developer-маркер смены модели. Отключаем по умолчанию: лишние системные блоки портят Codex
   prompt-cache и смущают часть моделей.

---

## 8. Переиспользование существующего кода

Что можно взять как есть:
- `acpSessionPool.js` — lifetime/serialization/expiry child-сессий. Ключевой инсайт в комменте:
  **модель вне ключа** (hopping сохраняет child) — это ровно G4. Переиспользуем.
- `acpBase.js` — `sendRpc`, чтение `session/update`, `session/request_permission`, `initialize` →
  вынести в `AcpClientCore`.
- `capabilities.js`/`getCapabilitiesForModel` — каталог моделей и их окно/context для `initialize`.
- `mcpProxyTargets`/`proxyTargets.js` — для передачи MCP в child. ⚠️ `proxyTargets.js:12` хардкодит
  порт 20128 при unset `PORT` → для exp-worktree **обязательно** явный `PORT` в env спавна, иначе
  агент получит неверный MCP-URL (уже отмечено в ACP-JOURNAL как D1).
- `resolveConversationKey` — остаётся для REST-пути; в ACP-сервере **не нужен** (там есть настоящий
  `zedSessionId`).

Что новое:
- `open-sse/acp/server.js` — входящий контракт, AcpAgentServer.
- `open-sse/acp/registry.js` — DialogueRegistry + persistence.
- `open-sse/acp/transcript.js` — ShadowTranscript (сбор/сериализация/реплей).
- `src/cli/acp-agent.js` — stdio-вход (`node entry acp`).

---

## 9. Риск-контейнер: Codex/ToS (N3, но важно)

ACP-сервер **сам по себе не решает** вопрос легальности Codex-подписки, но **снижает риск**
относительно прямого `codex.js`: трафик к OpenAI генерит живой `codex-acp`-процесс, а не роутер,
притворяющийся CLI. Прямой REST-путь через `codex.js` (`originator: codex_cli_rs`, маскировка под
CLI-версию, prompt_cache_key-манипуляции) — заметнее отклоняется от легитимного паттерна и помечен
в реестре как `deprecated:true, RISK_NOTICE`.

Рекомендация для маршрутизации: Codex-модели в ACP-сервере гоним **через child `codex-acp`**, а не
через прямой `codex.js`. Это переносит Codex в ту же «штатную» схему, что DSH/Zed.

---

## 10. Открытые вопросы (требуют решения пользователя до кода)

- Q1. **fs/terminal-мост.** Решено: **прозрачный прокси**. Все `fs/*`/`terminal/*`/`elicitation` от
  child-агента транслируем в Zed дословно. 9router сам файлы не читает.
- Q2. **Permission-эlicitation.** Решено: **проброс в Zed**. 9router — прозрачный прокси, сам
  решений не принимает.
- Q3. **Каталог моделей.** В `initialize` отдаём ВСЕ модели всех провайдеров (как сейчас в REST
  `/v1/models`)? Тогда один ACP-агент = все провайдеры, и смена провайдера — это `set_model`.
  Подтверждаем такую семантику.
- Q4. **Мультиплексирование child.** Разрешаем ли одному child держать несколько `zedSessionId`
  (если агент поддерживает), или всегда 1 child : 1 диалог (проще изоляция, дороже процессы)?
- Q5. **AUTH-методы.** Решено: **считаем «уже авторизован»**. 9router управляется нами, дочерние
  провайдеры авторизуются сами (через свой CLI-флоу или через наш OAuth-стек). В `initialize`
  отвечаем `authMethods: []`.

---

## 11. Декомпозиция (этапы, каждый — зелёный сам по себе)

- **M0. AcpClientCore extraction.** Вынести клиентскую машинерию из `acpBase.js` в общий модуль.
  REST-поведение не меняется. Гейт: регрессии `tests` зелёные, `npm run build` ок.
- **M1. Stdio-вход + initialize/session/new.** Минимальный диалог с child через фикстуру-агента.
  Zed ещё не подключаем — проверяем golden-транскриптом JSON-RPC.
- **M2. session/prompt + стриминг + ShadowTranscript.** Полный ход с дельтой, реплей-лог копится.
- **M3. session/load + persistence + resume.** Восстановление после рестарта процесса.
- **M4. Смена модели (same-provider vs provider-switch) + перенос.** G4.
- **M5. Live-подключение к Zed** (exp-worktree, свой порт). Elicitation/fs-политика по Q1/Q2.
- **M6. Hardening:** security transcript-диска, MCP-PORT (D1), redaction creds в реплее.

---

## 12. Чеклист приёмки

### Функциональные
- [ ] M0: `acpBase` использует `AcpClientCore`, поведение REST идентично (golden-тесты).
- [ ] M1: `node entry acp` отвечает на `initialize` валидными `agentCapabilities`.
- [ ] M1: `session/new` спавнит child, возвращает `sessionId`, регистрирует запись.
- [ ] M2: `session/prompt` стримит `session/update` chunks, `stopReason` корректен.
- [ ] M2: ShadowTranscript содержит user+agent+tool_call+tool_result по порядку.
- [ ] M3: после рестарта процесса `session/load` восстанавливает диалог (реплей из диска).
- [ ] M3: `session/resume` не реплеит историю (spec ACP).
- [ ] M4: смена модели (set_config_option model) same-provider → контекст сохранён, токены не выросли.
- [ ] M4: смена модели cross-provider → новый child + однократный перенос transcript.
- [ ] M5: Zed видит 9router в External Agents, диалог работает, история не режется.
- [ ] M5: «Import Threads» в Zed возвращает наши диалоги через `session/list` (по cwd).
- [ ] M5: `fs/*`/`terminal/*`/`request_permission`/elicitation от child доходят до Zed
      (двунаправленный проброс, ID-маппинг, без собственного решения 9router — Q1/Q2).
- [ ] M5: `initialize` отвечает `authMethods: []`, Zed не требует логина (Q5).

### Изоляция (G3) — критично
- [ ] Тест: 5 `session/new` с одинаковым provider/model/cwd → 5 разных transcript, ноль перетеканий.
- [ ] Тест: два диалога шарят child (мультиплекс) → transcript всё равно разделён по `zedSessionId`.
- [ ] Тест: `session/load` по `zedSessionId` №3 не тянет чужие сообщения из №1/2/4/5.

### Контекст/токены (главная цель)
- [ ] В ACP-режиме `stripHistoryForContext` НЕ вызывается (нет пересылки всей истории).
- [ ] Сравнить токены на 20-ходовом диалоге: ACP-режим << REST-режим с пулом.

### Безопасность
- [ ] Transcript-диск: 0600, без `env`/`headers` из MCP.
- [ ] `session/load`-реплей не протекает креды в stdout (golden-тест на redaction).
- [ ] MCP-PORT: exp-worktree спавнит агента с явным `PORT` (D1), агент получает верный MCP-url.
- [ ] Логи ACP-сервера идут в stderr, не в stdout (не ломают JSON-RPC).

### Качество
- [ ] `cd tests && npx vitest run --test-timeout=15000 --reporter=json --outputFile=/tmp/9r.json && node __baseline__/verify-no-regression.mjs /tmp/9r.json; echo $?` → 0.
- [ ] `npm run build` ок.
- [ ] Линт/типы по проектной команде.
- [ ] Стиль: без комментариев в коде (кроме «зачем» в неочевидном).
- [ ] Новый код не трогает `stable`/порт 20128.

---

## 13. Риски реализации

- **Р1. Мультиплекс vs изоляция.** Если агент мультиплексит child, а мы где-то привяжем transcript
  к child вместо `zedSessionId` — тихое слияние диалогов. Митигация: тесты раздела «Изоляция».
- **Р2. Вынос AcpClientCore — большой рефакторинг живого REST-пути.** Риск регрессий. Митигация:
  M0 отдельным этапом, golden-тесты до/после, не смешивать с M1+.
- **Р3. Codex-acp в exp-worktree.** `cli.js` убивает все 9router-процессы (`killAllAppProcesses`) →
  ACP-stdio-вход нельзя запускать через `cli.js`. Только изолированный dev-вход. См. память проекта.
- **Р4. `session/load` у child-агентов нестабилен** (не все объявляют `loadSession`). Митигация:
  наш shadow-transcript — источник истины для реплея, делегирование агенту — оптимизация.
- **Р5. Прозрачный проброс не покрыт тестами.** Если child шлёт `fs/*`/`terminal/*`, а мы его не
  транслируем в Zed (или теряем `id`-маппинг при ответе) — child висит вечно, диалог стоит.
  Митигация: в M5 обязательны тесты bidirectional-ретрансляции (каждый из 4 каналов: fs, terminal,
  permission, elicitation) + таймаут на зависший запрос с явной ошибкой вместо hang.
