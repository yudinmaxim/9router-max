# ACP-HANDOFF — boot-файл для новой сессии (реализация ACP-сервера)

Дата: 2026-10-29. Ветка реализации: `acp-experiments` в worktree `/home/maxim/Projects/personal-projects/9router-max-exp` (порт 20129).
Спека: `docs/ACP-SERVER-SPEC.md` (315 строк, финализирована, все открытые вопросы закрыты).
Журнал проблем: `ACP-JOURNAL.md`.

## TL;DR для старта

Строим **ACP-серверную ипостась** 9router: 9router спавнится Zed как External Agent (stdio JSON-RPC) и работает **прозрачным ACP-прокси** внутрь — к существующим ACP-агентам-детям (codex-acp и др.). Цель — убить проблему контекста на уровне транспорта: Zed держит живую сессию, шлёт только дельту, история живёт у child-агента, никакого пересыла всей истории и никакой обрезки.

## Почему это нужно (корень проблемы)

1. REST-клиенты по протоколу每次 шлют всю историю → 9router обязан пересылать её child-агенту текстом в `promptText` (в ACP нет дозагрузки истории).
2. `stripHistoryForContext` (open-sse/executors/lib/acpCommon.js) режет middle безусловно (`HEAD_KEEP=6`) → теряются `tool_result` → модель «забывает» прошлые шаги, обрывы на полшаге. Эмпирически проверено: 81 сообщение → 7, tool_results 1/20 (см. .tmp-ctx-audit.mjs).
3. Пул сессий (`acpSessionPool.js`) должен спасать, но `resolveConversationKey` даёт хрупкий ключ (хэш текста) → `conversation=""` → пул скипается → fresh-spawn каждый ход → см. п.1+2.
4. Dilemma «токены vs смысл» решается только живой сессией. ACP-сервер даёт её бесплатно от транспорта (Zed), без эмуляции пулом.

## Ключевые архитектурные решения (зафиксированы в спеке, НЕ переигрывать)

- **Транспорт:** stdio-процесс по контракту Zed `agent_servers {command, args}`. НЕ TCP/HTTP-порт. Логи — строго в stderr.
- **Изоляция диалогов:** первичный ключ — **внешний `zedSessionId`** (неизменяемый, переживает рестарт). НЕ `(cwd,model,provider)`, НЕ child-процесс (ACP разрешает мультиплекс — смешаем диалоги). Маппинг: `zedSessionId → {provider, currentModel, childSessionId (мутабельный), poolKey, transcript}`.
- **Модель вне ключа пула** (G4): hopping между моделями одного провайдера сохраняет child и контекст; смена провайдера = новый child + **однократный** перенос transcript.
- **Смена модели** идёт через `session/set_config_option {configId:"model"}` — НЕ `session/set_model` (наш слой его не использует; см. acpBase.js:15,752,994).
- **ShadowTranscript** — источник истины для реплея и переноса. Персистентность: `<DATA_DIR>/acp-dialogues/<zedSessionId>.json`, права 0600, без env/headers из MCP. `loadSession:true` в initialize **гарантируем сами** из transcript (не зависим от child-агента).
- **Принцип прозрачности (Q1/Q2):** 9router сам решений не принимает. `fs/*`, `terminal/*`, `session/request_permission`, `elicitation/create` от child → двунаправленный проброс в Zed (только если Zed объявил клиентские capabilities). ID-маппинг — наша ответственность.
- **Q5 auth:** отвечаем `authMethods: []` — «уже авторизован» (9router управляется пользователем, дети авторизуются через 9router).
- **Q3 каталог:** отдаём все модели всех провайдеров → один ACP-агент = все провайдеры, смена провайдера = смена модели.
- **`session/list`** — обязателен (фича Zed «Import Threads»).
- **Codex-риск (ToS):** в ACP-режиме трафик к OpenAI генерит живой codex-acp-процесс (штатный паттерн, как DSH/Zed) — риск НИЖЕ, чем прямой `codex.js` (там маскировка `originator:codex_cli_rs` + `deprecated:true, RISK_NOTICE`). Codex гоним через child, не через прямой codex.js.

## Декомпозиция (следующие шаги)

- **M0 (ПЕРВЫЙ, сейчас):** вынести `AcpClientCore` из `acpBase.js` (spawn+sendRpc+session/update+request_permission+initialize) в общий модуль. REST-поведение НЕ меняется. Golden-тесты до/после. Это единственный рискованный рефакторинг живого пути — идёт строго отдельно от M1+.
- M1: stdio-вход + initialize/session/new (фикстура, без Zed).
- M2: session/prompt + стриминг + ShadowTranscript.
- M3: session/load + persistence + resume.
- M4: смена модели (same-provider vs cross-provider) + перенос + session/list.
- M5: live-Zed (exp-worktree) + двунаправленный проброс (4 канала) + authMethods:[].
- M6: hardening (redaction creds в реплее, MCP-PORT D1, права диска).

## Конвенции проекта (ОБЯЗАТЕЛЬНО)

- Тесты: `cd tests && npx vitest run <файл> --test-timeout=15000`. Корневой `npm test` НЕ запускает тесты.
- Гейт регрессий (единственный вердикт): `cd tests && npx vitest run --test-timeout=15000 --reporter=json --outputFile=/tmp/9r-results.json` затем `node __baseline__/verify-no-regression.mjs /tmp/9r-results.json; echo $?` (код БЕЗ пайпа!). Baseline = 85 записей.
- Сборка: `npm run build`. Стиль: без комментариев в коде (кроме «зачем»). Fail-open для мутаторов запроса.
- Перед правкой в `open-sse/` читать `open-sse/AGENTS.md`. Реестр `providers/registry/index.js` — руками, генератора нет.
- git: всегда `--no-pager`. НЕ трогать stable/порт 20128/9router.service. НЕ пушить/коммитить без явного разрешения. НЕ удалять файлы без подтверждения.
- **cli.js убивает ВСЕ процессы 9router (killAllAppProcesses)** — exp-инстанс поднимать только через изолированный dev-сервер (next dev) в worktree, НЕ через cli.js. MCP-прокси в exp требует явного `PORT=20129` в env спавна агента (proxyTargets.js:12 иначе дефолтит 20128).
- docs/* в .gitignore — для спеки/журнала в exp добавить `!docs/ACP-SERVER-SPEC.md` в КОНЕЦ .gitignore (последнее правило побеждает).

## Статус файлов

- `docs/ACP-SERVER-SPEC.md` — готова (в stable-директории; в exp ещё НЕ скопирована — скопировать при старте).
- `ACP-JOURNAL.md` — блок A/B/C/D (REST-пул фиксы) висит отдельным треком, НЕ блокирует ACP-сервер.
- `.tmp-ctx-audit.mjs` — эмпирическая проверка потери контекста (можно переиспользовать для «до/после»).

## Первая задача новой сессии

Скопировать `docs/ACP-SERVER-SPEC.md` + `ACP-JOURNAL.md` + этот файл в exp-worktree; добавить gitignore-исключение; затем начать **M0**: прочитать полностью `open-sse/executors/lib/acpBase.js` (1621 строк), наметить границу `AcpClientCore`, сделать golden-снимки REST-поведения, вынести модуль, прогнать гейт регрессий.
