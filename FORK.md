# 9router-max — форк 9router

Личная сборка [9router](https://github.com/decolua/9router) от `decolua`.
Форк нужен для трёх вещей, которых нет в апстриме:

- **ACP-провайдеры** — автономные агенты через локальные CLI: `cursor-acp` (`ca`),
  `opencode-acp` (`oacp`), `omp-acp`, `codex-acp`. Один общий исполнитель
  `executors/lib/acpBase.js` поверх Agent Client Protocol.
- **Настраиваемые разрешения агента** — политика по действиям и по расположению
  файлов, настраивается для роутера и для провайдера.
- **Лимиты квоты** cursor, которые теперь идут по `cursor-acp`.

Ветка по умолчанию здесь — `max`. Ветка `master` — нетронутая копия апстрима.

---

## Что здесь добавлено

Полная история — в `git log`. Отличия от апстримного v0.5.99 наращивались итеративно;
первые пять коммитов поверх `ce4460ef` дают исходный каркас:

```
d6cadb2f chore: release 0.5.99-max-fork
17b60157 feat(cursor-acp): drive the local cursor-agent CLI over ACP
fe74a7b9 feat(cursor): report plan quota for the current billing cycle
37852b65 refactor(cursor): move the HTTP/2 client into cursorHttp2
05f732d7 refactor(devin-cli): extract shared ACP helpers into acpCommon
```

Позже поверх этого добавлены, в частности: общий ACP-исполнитель с
`opencode`/`omp`/`codex`, исправление зависания на `session/request_permission`,
резолв бинаря и моделей агента, политика разрешений с ГУИ, и **выпиливание
не-ACP вариантов** — `cursor` (api2), `opencode`, `opencode-zen`,
`opencode-go`, то есть эти модели доступны исключительно через ACP.

Состояние работы и накопленные грабли: `STATUS.md`.

### 1. Cursor ACP — провайдер `cursor-acp` (алиас `ca`)

Главное добавление. Заставляет 9router говорить с уже установленным у вас
`cursor-agent` напрямую, по протоколу **Agent Client Protocol** (JSON-RPC 2.0
через stdio). Апстримный вариант ходил в api2-RPC эндпоинты; в этой сборке он
удалён вместе с провайдером `cursor`, так что ACP — единственный путь.

Зачем: через api2 у cursor **не проходят вызовы инструментов** — модель
возвращает текст вместо `tool_calls`. Через ACP курсор работает как
полноценный агент и выполняет свои инструменты (shell, правка файлов) внутри
одного запроса. В запросе к `ca/*` инструменты передавать не нужно — курсор
исполняет их сам.

Сессия: `initialize` → `session/new` → `session/set_model` → `session/prompt`.
Ответ курсора разбирается построчно: `agent_message_chunk` идёт в `content`,
`agent_thought_chunk` — в `reasoning_content`.

Каталог моделей (44 модели) снимается с того cursor-agent, который стоит у
вас, при `session/new`, так что список не приходится поддерживать вручную.

> **Важно про инструменты.** `ca/*` работает как автономный агент:
> объявления `tools` в запросе игнорируются (эта сборка курсора не
> объявляет клиентский канал инструментов по ACP), а `tool_call` /
> `tool_call_update` от курсора намеренно **не** превращаются обратно в
> OpenAI `tool_calls` — иначе инструменты исполнились бы дважды.
>
> Если агенту нужно разрешение, он спрашивает клиента и **ждёт**. Ответ даёт
> политика из настроек (`/dashboard/acp-permissions`), по умолчанию разрешающая.

Ключевые файлы:
- `open-sse/executors/cursor-acp.js` — сам исполнитель (ACP-сессия)
- `open-sse/providers/registry/cursor-acp.js` — каталог моделей, алиас `ca`
- `open-sse/executors/lib/acpCommon.js` — общие ACP-хелперы (вынесены из `devin-cli.js`, переиспользуются обоими)

### 2. Лимиты квоты cursor

Показывает остаток пакета по текущему циклу: три полосы (Total / API / Auto) и
суммы included / bonus / spent. Берётся из
`DashboardService/GetCurrentPeriodUsage` — это Connect-RPC, который отвечает
только по HTTP/2 и только в JSON-кодировке (стриминговая
`application/connect+proto` для unary-вызова отвергается).

Поля `includedSpend` — это включённая сумма, а не остаток, поэтому полосы
считаются из процентных полей, а не из сумм. Деньги приходят в центах.

Квота приходит из аккаунта Cursor IDE, поэтому токен импортируется в подключение
`cursor-acp` — api2-провайдера в этой сборке больше нет.

Ключевые файлы:
- `open-sse/services/usage/cursor.js` — разбор ответа
- `open-sse/utils/cursorHttp2.js` — HTTP/2-обёртка (вынесена из `executors/cursor.js`)

### 3. Мелкое

- `noAuth`-провайдерам разрешено подключаться без API-ключа (тем же
  исключением, что уже было в `/api/providers/validate`); их учётные данные
  хранятся в хранилище самого агента.
- Версия форка — `0.5.99-max-fork` в `package.json` и `cli/package.json`.

---

## Как пользоваться

```bash
# 1. Собрать форк
git clone git@github.com:yudinmaxim/9router-max.git
cd 9router-max
git checkout max
npm install
npm run build

# 2. Запустить (порт по умолчанию 20128)
PORT=20128 npm run start
```

Дашборд: <http://localhost:20128/dashboard>, API: `/v1`.

Клиенты (omp, opencode, Zed и т.д.) уже умеют работать с 9router — правьте
адрес `http://127.0.0.1:20128/v1` и ключ, который 9router показывает в
дашборде.

---

## Не потеряйте форк при npm i -g 9router

Штатный способ установки 9router — `npm i -g 9router`. Он **перетирает
собранный сервер** стоковой версией, и форк пропадает.

Как это устроено: лаунчер `cli.js` берёт сервер из `path.join(__dirname, "app")`,
то есть ровно из одной директории. Подмена этой директории меняет сервер, но
оставляет нетронутыми трей, автозапуск, порт и логику обновления — все клиенты
продолжают ходить на тот же `20128`.

Восстановление после переустановки — одним скриптом:

```bash
9router-fork-sync            # пересобрать форк и вернуть его
9router-fork-sync --skip-build   # если сборка уже на месте, просто вернуть
```

Скрипт сам: пересоберёт форк (или возьмёт готовую сборку), сохранит штатный
бандл в `app.npm.bak`, подменит `app/` через `ditto`, перезапустит сервис,
переприменит патч и проверит, что `ca/*` отвечают.

### Патч сборки

Отдельно от форка к бандлу применяется патч в
`app/.next/server/chunks/5330.js`: курсор говорит по IDE-exec протоколу, который
9router реализовал частично, и неизвестные варианты запроса убивали весь
turn ошибкой `Cursor AgentService requested an unsupported IDE tool` вместо того,
чтобы подтвердить вызов и продолжить. Этот же патч уже есть в апстриме в виде
[#4550](https://github.com/decolua/9router/pull/4550), но в npm-релиз не вошёл,
поэтому патчится локально:

```bash
9router-fix
```

Он сам находит нужный чанк (и в форковой раскладке `.next/server/chunks`, и в
опубликованной `.next-cli-build/server/chunks`), применяет правки идемпотентно
(повторный запуск скажет `already applied`), проверяет синтаксис, перезапускает
сервис и делает smoke-проверку.

Оба скрипта живут в `~/.local/bin/`. Их нет в репозитории намеренно: это
машинная обвязка, а не код продукта.

---

## Тесты

Тесты живут в отдельном воркспейсе `tests/` со своим vitest — в корневом
`package.json` их нет.

```bash
npm install            # зависимости корня (нужны тестам из src/)
cd tests && npm install
npx vitest run unit/cursor-acp-executor.test.js unit/cursor-usage.test.js
```

Оба набора зелёные (26 + 17). Весь прогон `tests/unit/` **не** зелёный и не
должен быть — красные тесты каталогизированы в
`tests/__baseline__/known-fails.txt`, регрессии сверять скриптом
`tests/__baseline__/verify-no-regression.mjs`.

---

## Синхронизация с апстримом

```bash
git remote -v
# origin    git@github.com:yudinmaxim/9router-max.git   ← свой форк
# upstream  git@github.com:decolua/9router.git          ← только читать

git fetch upstream
git log upstream/master..max      # что здесь есть моего
```

В `upstream` не пушим никогда.

---

## Лицензия

MIT, как и в апстриме — см. [LICENSE](./LICENSE).
Правки и этот файл принадлежат Maxim Yudin.

---

Апстримовская документация по самому 9router — в [README.md](./README.md)
(не изменялась, кроме плашки-указателя наверху).
