# hostrunner — управляемый доступ агента к хосту

Вместо SSH, `docker.sock` и прямого сетевого доступа к хосту агенты получают
обычный MCP‑инструмент. Инструмент **не исполняет команды внутри контейнера** —
он пишет заявку в общий каталог, а host‑daemon выполняет только whitelisted
`argv` на хосте.

```text
Агент в контейнере
  │ mcp tools/call: hostrunner_run
  ▼
host-runner/plugin.mjs (stdio MCP, внутри контейнера)
  │ пишет <id>.request.json
  ▼
/var/lib/9r-runner/in     → монтируется с хоста ~/.9r-host-runner/in (rw)
  │
  ▼
host-runner/daemon.py     → systemd --user, выполняет только ~/.9r-host-runner/tools.json
  │ пишет <id>.json + <id>.log
  ▼
/var/lib/9r-runner/out    → монтируется с хоста ~/.9r-host-runner/out (ro)
  │
  ▼
Агент читает результат через hostrunner_status / hostrunner_tail
```

Ключевой момент: `out` смонтирован **только для чтения**. Агент не может
подменить результат и «успешно» закрыть упавший тест.

---

## Что даём агенту

После включения `NINEROUTER_HOST_RUNNER=1` в `session/new` добавляется stdio
MCP‑сервер `hostrunner` с четырьмя инструментами:

| Инструмент | Назначение |
|---|---|
| `hostrunner_run` | Запустить whitelisted инструмент на хосте |
| `hostrunner_status` | Получить статус/результат по `id` |
| `hostrunner_cancel` | Попросить демон убить процесс по `id` |
| `hostrunner_tail` | Последние строки лога задания |

Пример вызова:

```json
{
  "tool": "e2e_playwright",
  "cwd": "/home/maxim/Projects/zephyr-ui/monorepa",
  "args": ["src/e2e/login.spec.ts"],
  "timeoutMs": 900000,
  "waitMs": 600000,
  "requester": "acp:codex-acp"
}
```

`waitMs: 0` возвращает сразу `{id, status: "queued"}` — дальше можно опрашивать
`hostrunner_status` и читать `hostrunner_tail`.

### Статусы

`hostrunner_status` отвечает одним из:

| Статус | Что означает | Источник |
|---|---|---|
| `queued` | заявка принята, ждёт свободного воркера | `in/<id>.request.json` или `out/<id>.state.json` |
| `running` | процесс уже запущен | `out/<id>.state.json` либо `in/.processing/<id>.request.json` |
| `ok` · `failed` · `timeout` · `cancelled` · `rejected` · `spawn_failed` | терминальный результат (в нём `exitCode`, `durationMs`, `stdoutTail`, `stderrTail`) | `out/<id>.json` |
| `unknown` | ни заявки, ни результата: задание выдано другим демоном/очередью либо id неверный | — |

Живой маркер лежит отдельно, в `out/<id>.state.json`, а не в `<id>.json` —
иначе плагин принял бы «running» за готовый ответ и перестал ждать. Демон
удаляет маркер, как только публикует результат.

Ответ всегда содержит `logAvailable` — можно ли уже читать `hostrunner_tail`
(пустой лог при `logAvailable: false` означает «ещё не начат», а не «вывода
нет»).

---

## Установка на хосте

### 1. Каталоги очереди

```bash
mkdir -p ~/.9r-host-runner/{in,out}
chmod 700 ~/.9r-host-runner
chmod 700 ~/.9r-host-runner/in ~/.9r-host-runner/out
```

UID пользователя `node` в образе совпадает с UID хоста (1000), поэтому дополнительный
`chown` обычно не нужен. Если запускаете демон от другого пользователя — выставьте
владельца `1000:1000` для `in` и `out`.

### 2. Whitelist инструментов

Whitelist живёт **на хосте**, в `~/.9r-host-runner/tools.json` — вне всех
монтирований контейнера, чтобы агент не мог его переписать. Файл
`host-runner/tools.json` в репозитории — только шаблон для первой установки:

```bash
./host-runner/hostrunner-ctl init       # создаёт ~/.9r-host-runner/tools.json из шаблона
./host-runner/hostrunner-ctl status     # что уже настроено
```

Шаблон по умолчанию содержит `e2e_playwright`, `e2e_playwright_ui`, `php_test`,
`php_lint`, `phpstan`, `composer_test`, `e2e_real`.

После переезда правьте whitelist через веб-интерфейс (см. «Редактирование из
веб-интерфейса» ниже) либо руками на хосте; демон перечитывает файл по mtime,
перезапуск не нужен.

Формат одного инструмента:

```json
"php_test": {
  "argv": ["php", "artisan", "test"],
  "allowedCwd": ["/home/maxim/Projects"],
  "timeoutMs": 600000,
  "maxTimeoutMs": 1200000,
  "argPattern": "^[A-Za-z0-9_./:@=-]+$",
  "env": { "APP_ENV": "testing" }
}
```

- `argv` — **фиксированная** часть команды; агент может добавить только `args`.
- `shell` всегда `false`, интерполяций нет.
- `allowedCwd` необязателен; по умолчанию используется `allowedRoots`.
- `argPattern` необязателен; если задан, каждое дополнительное `args` должно ему соответствовать.
- `allowArgs: false` — инструмент принимает только фиксированный `argv`,
  демон отклоняет любой `args` из заявки. Так помечены инструменты, чьё
  поведение полностью описано скриптом (например `e2e_real`: скрипт сам
  создаёт фикстуры, запускает Playwright с нужной конфигурацией и чистит за
  собой — второй канал ввода превратил бы «запусти этот скрипт» в «запусти
  всё, что скрипт готов пробросить»).
- `env` добавляется к хостовому `envAllowlist`; окружение контейнера не передаётся.

Демон **fail closed**: без непустого `tools` он не стартует.

### 3. systemd user service

```bash
mkdir -p ~/.config/systemd/user
cp host-runner/systemd/9r-host-runner.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now 9r-host-runner
systemctl --user status 9r-host-runner
journalctl --user -u 9r-host-runner -f
```

### 4. Контейнер

Используйте готовый overlay `host-runner/docker-compose.hostrunner.yml` — он
добавляет env и два volume к уже существующему сервису **`9router-acp-ui`**
(именно так он называется в `/home/maxim/vpn/docker-compose.yml`; старое имя
`9router-acp` в оверлее создавало бы второй контейнер вместо патча).

Важно: существующие контейнеры/volume созданы под проектом `vpn`. Compose
выводит имя проекта из каталога первого `-f` файла, поэтому без `-p vpn` он
пытается создать второй `gluetun`/`singbox` и новый volume. Всегда задавайте
`-p vpn`.

Рабочие compose‑файлы лежат в `/home/maxim/vpn`:

```bash
cd /home/maxim/vpn

# канал OpenVPN (gluetun):
docker compose -p vpn \
  -f docker-compose.yml \
  -f docker-compose.vpn.yml \
  -f /home/maxim/Projects/personal-projects/9router-max-exp/host-runner/docker-compose.hostrunner.yml \
  up -d 9router-acp-ui

# канал Hysteria2 (singbox) — вместо второго файла:
docker compose -p vpn \
  -f docker-compose.yml \
  -f docker-compose.vpn-hiddify.yml \
  -f /home/maxim/Projects/personal-projects/9router-max-exp/host-runner/docker-compose.hostrunner.yml \
  up -d 9router-acp-ui
```

Overlay добавляется к любому каналу: он только включает stdio MCP-сервер и
монтирует очереди, сетевой namespace и порты остаются от VPN-оверлея.
При переключении канала добавляйте оверлей в обе команды (`down` и `up`),
иначе env/volumes пропадут.

Overlay content:

```yaml
environment:
  NINEROUTER_HOST_RUNNER: "1"
  NINEROUTER_HOST_RUNNER_PLUGIN: /app/host-runner/plugin.mjs
  HOST_RUNNER_IN_DIR: /var/lib/9r-runner/in
  HOST_RUNNER_OUT_DIR: /var/lib/9r-runner/out
volumes:
  - /home/maxim/.9r-host-runner/in:/var/lib/9r-runner/in
  - /home/maxim/.9r-host-runner/out:/var/lib/9r-runner/out:ro
  # тот же каталог под хостовым путём — для ~/.codex/config.toml (см. ниже)
  - /home/maxim/.9r-host-runner/in:/home/maxim/.9r-host-runner/in
  - /home/maxim/.9r-host-runner/out:/home/maxim/.9r-host-runner/out:ro
```

### 5. Доступ к браузерам Playwright на хосте

Если инструмент вроде `e2e_real` указывает `PLAYWRIGHT_BROWSERS_PATH` на
каталог внутри тома Docker (например, `/var/lib/docker/volumes/.../_data/ms-playwright`),
демон работает от обычного пользователя (uid 1000), а Docker по умолчанию
создаёт `/var/lib/docker` и `/var/lib/docker/volumes` с правами `0710`/`0700`
root:root — пользователь демона **не может пройти** по этим каталогам, и
Playwright падает с «Executable doesn't exist», хотя файл на самом деле есть.

Симптом: задача завершается со статусом `failed`, в логе Playwright —
`browserType.launch: Executable doesn't exist at ...`, при этом файл
существует (виден из контейнера в смонтированном томе).

Диагностика (от root):

```bash
namei -l /var/lib/docker/volumes/<volume-name>/_data/ms-playwright/chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell
```

Фикс (от root, один раз):

```bash
chmod 755 /var/lib/docker
chmod 755 /var/lib/docker/volumes
chmod 755 /var/lib/docker/volumes/<volume-name>
chmod 755 /var/lib/docker/volumes/<volume-name>/_data
```

Проверка (от пользователя демона, без sudo):

```bash
su - <user> -c "test -x /var/lib/docker/volumes/<volume-name>/_data/ms-playwright/chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell && echo 'browsers readable OK'"
```

Альтернатива, если трогать Docker-каталоги нельзя — скопировать браузеры в
читаемое место (`~/.cache/ms-playwright`) контейнером от root и указать этот
путь в `PLAYWRIGHT_BROWSERS_PATH`:

```bash
docker run --rm \
  -v <volume-name>:/src:ro \
  -v /home/<user>/.cache:/dst \
  alpine sh -c 'mkdir -p /dst/ms-playwright && cp -a /src/ms-playwright/. /dst/ms-playwright/'
```

Пересоберите образ, чтобы `host-runner/plugin.mjs` попал внутрь
(`Dockerfile` уже содержит `COPY --from=builder /app/host-runner ./host-runner`,
но сейчас запущенный образ собран до этого изменения):

```bash
cd /home/maxim/vpn
docker compose -p vpn \
  -f docker-compose.yml \
  -f docker-compose.vpn.yml \
  -f /home/maxim/Projects/personal-projects/9router-max-exp/host-runner/docker-compose.hostrunner.yml \
  build 9router-acp-ui
```

Проверка после сборки:

```bash
docker run --rm vpn-9router-acp-ui:latest ls -l /app/host-runner/plugin.mjs
```

Пересборка образа нужна только один раз; при смене VPN-канала она не требуется.

---

## Редактирование из веб-интерфейса

Страница `dashboard/host-runner` показывает текущий whitelist и позволяет его
менять. Секрет — **пароль дашборда**: сохранение подписывается ключом `K`,
который существует только на хосте.

Как это устроено:

1. Страница читает снапшот `~/.9r-host-runner/out/config.snapshot.json`
   (его публикует демон) — контейнеру файл конфига не нужен.
2. При сохранении API локально сверяет пароль с bcrypt-хешем дашборда,
   считает `HMAC(K, ts ‖ configText)` и кладёт подписанное сообщение
   `in/<id>.config.json` в очередь.
3. Демон проверяет подпись (`K` = PBKDF2-HMAC-SHA256 от пароля, соль из
   `auth.json`), валидирует конфиг и атомарно переписывает
   `~/.9r-host-runner/tools.json`, затем публикует новый снапшот.

Агенту напрямую недоступны ни файл конфига, ни ключ: и `in/` (rw), и сам
контейнер открыты агенту, а `~/.9r-host-runner/` целиком вне монтирований.
Подделать сообщение нельзя — без пароля оператора MAC не считается.

### Первый запуск

```bash
./host-runner/hostrunner-ctl init            # шаблон → ~/.9r-host-runner/tools.json
./host-runner/hostrunner-ctl set-password    # ключ из пароля дашборда → auth.json
```

`set-password` читает пароль из терминала (или stdin), не из argv — иначе он
попадает в shell history и `ps`.

### Смена пароля дашборда

`K` выводится из пароля, синхронизировать его автоматически нечем: **после
смены пароля дашборда повторите `hostrunner-ctl set-password`**, иначе
сохранения с веб-страницы будут отклоняться с `bad_mac` («ключ на хосте
создан от другого пароля»).

### Отказы

Коды, которые может вернуть сохранение: `rate_limited` (лимит попыток —
защита от перебора из `in/`), `auth_not_configured` (нет `auth.json`),
`stale_timestamp` / `stale_snapshot` (страница устарела — перезагрузите),
`bad_mac` (неверный пароль), `invalid_config`, `write_failed`.

---

## Codex CLI (консоль)

`hostrunner` доступен не только агентам из ACP-сессии, но и codex, запущенному
в терминале. Сервер прописывается в `~/.codex/config.toml` (команда ниже уже
выполнена в этом окружении):

```bash
codex mcp add hostrunner \
  --env HOST_RUNNER_IN_DIR=/home/maxim/.9r-host-runner/in \
  --env HOST_RUNNER_OUT_DIR=/home/maxim/.9r-host-runner/out \
  -- /home/maxim/.nvm/versions/node/v24.19.0/bin/node \
     /home/maxim/Projects/personal-projects/9router-max-exp/host-runner/plugin.mjs
```

Проверить:

```bash
codex mcp list        # должен показать hostrunner (enabled)
codex mcp get hostrunner
```

Убрать: `codex mcp remove hostrunner`.

---

## Kompas3D MCP (мост к живой модели)

Отдельный MCP-сервер `kompas3d` работает через Unix-сокет
`/tmp/kompas-bridge/bridge.sock` (том `kompas-bridge` монтируется в контейнер).
Инструменты: `bridge_status`, `get_active_document`, `get_model_tree`,
`get_model_contents`, `get_build_history`.

Перед использованием нужно один раз активировать «Kompas Bridge» в KOMPAS-3D —
после этого `bridge_status` вернёт `{"success": true, "message": "pong"}`.

### OpenCode

Добавить в `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "kompas3d": {
        "type": "local",
        "command": [
          "/home/maxim/Projects/personal-projects/kompas3d-ai/.venv-mcp/bin/python",
          "/home/maxim/.kompas-3d-ai/server.py"
        ],
        "environment": {
          "KOMPAS_BRIDGE_SOCKET": "/tmp/kompas-bridge/bridge.sock"
        }
      }
    }
  }
}
```

### Codex CLI

```bash
codex mcp add kompas3d \
  --env KOMPAS_BRIDGE_SOCKET=/tmp/kompas-bridge/bridge.sock \
  -- /home/maxim/Projects/personal-projects/kompas3d-ai/.venv-mcp/bin/python \
     /home/maxim/.kompas-3d-ai/server.py
```

### Devin

Добавить в `DEVIN_MCP_SERVERS`:

```json
{
  "kompas3d": {
    "command": "/home/maxim/Projects/personal-projects/kompas3d-ai/.venv-mcp/bin/python",
    "args": ["/home/maxim/.kompas-3d-ai/server.py"],
    "env": {"KOMPAS_BRIDGE_SOCKET": "/tmp/kompas-bridge/bridge.sock"}
  }
}
```

---

## OpenCode

MCP-сервер прописывается в `~/.config/opencode/opencode.json` (файл общий для хоста
и контейнера — пути хостовые):

```json
{
  "mcp": {
    "servers": {
      "hostrunner": {
        "type": "local",
        "command": [
          "/home/maxim/.nvm/versions/node/v24.19.0/bin/node",
          "/home/maxim/Projects/personal-projects/9router-max-exp/host-runner/plugin.mjs"
        ],
        "environment": {
          "HOST_RUNNER_IN_DIR": "/home/maxim/.9r-host-runner/in",
          "HOST_RUNNER_OUT_DIR": "/home/maxim/.9r-host-runner/out"
        }
      }
    }
  }
}
```

После правки перезапустите OpenCode. Плагин сам проверяет наличие каталогов
очереди и отвечает ошибкой, если демон ещё не запущен.

---

## Devin

Devin читает MCP-серверы из переменной окружения `DEVIN_MCP_SERVERS` (JSON).
При запуске через 9router она выставляется автоматически (compose-оверлей
`docker-compose.hostrunner.yml` уже содержит `DEVIN_MCP_SERVERS`). При ручном
запуске devin на хосте:

```bash
export DEVIN_MCP_SERVERS='{"hostrunner":{"command":"/home/maxim/.nvm/versions/node/v24.19.0/bin/node","args":["/home/maxim/Projects/personal-projects/9router-max-exp/host-runner/plugin.mjs"],"env":{"HOST_RUNNER_IN_DIR":"/home/maxim/.9r-host-runner/in","HOST_RUNNER_OUT_DIR":"/home/maxim/.9r-host-runner/out"}}}'
devin
```

Агенты, запущенные через 9router (ACP), получают hostrunner автоматически через
`buildMcpProxyTargets()` — никакой ручной настройки не требуется.

Важные детали:

- `config.toml` общий для хоста и контейнера (`~/.codex` смонтирован в
  `/home/node/.codex`), поэтому пути в нём — **хостовые**. Оверлей дополнительно
  монтирует очереди под теми же путями, чтобы запись работала и внутри
  контейнера.
- Указан абсолютный путь к `node` из nvm: при обновлении Node путь меняется —
  тогда перепропишите сервер командой выше.
- Плагин только пишет/читает файлы очереди, он **не выполняет команды** —
  как и в ACP-варианте, это делает `daemon.py` на хосте.

До создания каталогов очереди и запуска демона плагин отвечает на
`initialize`/`tools/list`, но каждый вызов `hostrunner_run` завершится ошибкой
про недостающие каталоги — это ожидаемо.

---

## Проверка без агента

Можно проверить демона напрямую:

```bash
cat > ~/.9r-host-runner/in/hr_smoke_1.request.json <<'JSON'
{"id":"hr_smoke_1","tool":"e2e_playwright","cwd":"/home/maxim/Projects/personal-projects/9router-max-exp","args":["--list"],"timeoutMs":120000,"requester":"manual-smoke"}
JSON

cat ~/.9r-host-runner/out/hr_smoke_1.json
tail -20 ~/.9r-host-runner/out/hr_smoke_1.log
```

Если `e2e_playwright --list` требует установленный Playwright в проекте — это
ожидаемо; результат всё равно должен появиться в `hr_smoke_1.json` со статусом
`failed` и текстом ошибки в `stderrTail`.

---

## Аудит

Каждое задание пишется в `~/.9r-host-runner/audit.jsonl`:

```json
{"ts":"2026-11-23T...","id":"hr_x","tool":"e2e_playwright","cwd":"...","requester":"acp:codex-acp","status":"failed","exitCode":1,"durationMs":4210}
```

Это единственный надёжный способ потом ответить на вопрос «кто и что именно
запускал на хосте». `requester` приходит от агента и не является аутентификацией —
он нужен только для читаемости лога.

---

## Ограничения и безопасность

- Нет shell, нет `bash -c`, нет произвольных команд из заявки.
- Команда выбирается **именем инструмента** из `tools.json`, а не строкой агента.
- `cwd` проверяется через `realpath` + `commonpath` — `..` и symlink escape не проходят.
- Окружение агента (API keys, proxy, `NODE_OPTIONS`) не попадает в хостовый процесс.
- Вывод ограничен `maxOutputBytes`; лог обрезается, но `<id>.json` содержит `truncated: true`.
- `maxConcurrent` по умолчанию 1 — агент не может заспамить 20 Chrome одновременно.
- `maxPending` по умолчанию 50 — лишние заявки остаются на диске, но не захлёстывают память демона.
- Таймаут убивает всю process group (`SIGTERM` → `SIGKILL`).
- Отмена также убивает process group.
- `out:ro` не даёт агенту подделать результат.

Чего **нет**: изоляции от самого пользователя хоста. Демон работает от вашего
пользователя и запускает whitelisted команды с вашими правами. Это осознанный
компромисс: вы получаете узкий управляемый интерфейс вместо полного root/ssh
доступа из контейнера.

---

## Добавление нового инструмента

1. Добавьте запись в whitelist:
   - через веб-интерфейс `dashboard/host-runner` (с паролем дашборда), либо
   - руками на хосте в `~/.9r-host-runner/tools.json`.
   Репозиторный `host-runner/tools.json` — только шаблон для `hostrunner-ctl init`.
2. Перезапуск демона не нужен: он перечитывает файл по mtime. Если демон
   запущен со старым юнитом без watch — `systemctl --user restart 9r-host-runner`.
3. Пересобирать контейнер не нужно — whitelist живёт на хосте.
4. Попросите агента использовать новое имя `tool` в `hostrunner_run`.

Если инструмент требует переменных окружения, добавьте их либо в глобальный
`envAllowlist`, либо в `env` конкретного инструмента. Не добавляйте секреты в
шаблон `host-runner/tools.json` — он попадает в git; для секретов есть
`~/.9r-host-runner/auth.json` (mode 600).

### Инструмент `e2e_real`

Фиксированный запуск реального E2E-набора science-to-regions без участия
shell и без аргументов от агента:

```json
"e2e_real": {
  "argv": ["/home/maxim/.nvm/versions/node/v24.19.0/bin/node",
           "/home/maxim/Projects/MIPT/science-to-regions/scripts/e2e-real.mjs"],
  "allowedCwd": ["/home/maxim/Projects/MIPT/science-to-regions"],
  "allowArgs": false,
  "timeoutMs": 300000,
  "maxTimeoutMs": 1800000,
  "env": {
    "E2E_HOST_GATEWAY": "172.20.0.1",
    "PLAYWRIGHT_BROWSERS_PATH": "/var/lib/docker/volumes/9router-acp-data/_data/ms-playwright"
  }
}
```

Скрипт сам создаёт фикстуры, запускает Playwright с
`account/playwright.real.config.js` и очищает данные. Общий
`npx playwright test` из корня **намеренно не разрешён** — он захватывает
посторонние тесты монорепозитория. `PLAYWRIGHT_BROWSERS_PATH` указывает на
хостовый путь тома Docker с браузерами (ревизии совпадают с ожидаемыми
Playwright 1.63: `chromium-1243`); `E2E_HOST_GATEWAY` фиксирует шлюз
`vpn_default`, потому что со хоста автоопределение из `/proc/net/route`
могло бы выбрать не тот интерфейс.

Важно: каталог `/var/lib/docker/volumes` по умолчанию недоступен
не-root пользователю. Если Playwright падает с «Executable doesn't exist»,
см. раздел «5. Доступ к браузерам Playwright на хосте».
