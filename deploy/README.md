# Деплой 9router + ACP-агенты в VPN-контуре

Схема: один контейнер `9router-acp-ui` (дашборд + OpenAI `/v1` + ACP WebSocket
`/api/acp/ws`) работает **в сетевом namespace вашего VPN-контейнера**
(gluetun). Весь egress — и самого роутера, и всех spawned-агентов — идёт
через VPN на сетевом уровне, без proxy-переменных. Хост остаётся чистым.

## Что нужно на машине

- Docker + docker compose v2 (≥ 2.24 — нужен тег `!reset`)
- Чекаут этого репозитория
- **Ваш VPN-контейнер** — файл compose с сервисом `gluetun`
  (qmcgaw/gluetun или аналог). В репозиторий он не входит — это ваши
  credentials. Контейнер должен публиковать порт `20130` на `127.0.0.1`.
- CLI-агенты на хосте (`codex`, `opencode`, `devin`) с их конфигами
  (`~/.codex`, `~/.config/opencode`, `~/.local/share/devin` и т.д.) —
  скрипт подхватит существующие каталоги автоматически.

## Быстрый старт

```bash
# 1. Сгенерировать compose в ~/9router-vpn (детектит агентов и бинари)
./deploy/init.sh

# или с явными параметрами:
PORT=20130 AGENTS=codex-acp,opencode-acp,devin-cli \
  PROJECTS_DIR=$HOME/Projects ./deploy/init.sh /path/to/repo ~/9router-vpn

# 2. Положить свой vpn.yml рядом (сервис обязан называться gluetun)

# 3. Собрать и поднять (два -f: наш сервис + ваш VPN)
cd ~/9router-vpn
docker compose -f docker-compose.yml -f vpn.yml build
docker compose -f docker-compose.yml -f vpn.yml up -d
```

Dashboard: `http://127.0.0.1:20130/dashboard` — пароль сгенерирован
в `.env` (`INITIAL_PASSWORD`).

## Что генерирует init.sh

- `docker-compose.yml` — сервис `9router-acp-ui`:
  - `network_mode: "service:gluetun"` + `ports: !reset []` — netns общий
    с VPN, порты публикует сам gluetun
  - `env_file: .env` — `INITIAL_PASSWORD`, `ACP_PROVIDERS`, `ACP_MODEL_ALLOW`
  - volumes: только существующие каталоги агентов (`~/.codex`,
    `~/.config/opencode`, devin-state и т.д.)
  - бинари монтируются по тем же путям, что на хосте (ro) и попадают в PATH
- `.env` — пароль, порт, провайдеры (chmod 600)
- `devin-state/` — если включён devin-cli: отдельный state-dir, чтобы
  sessions.db контейнерного devin не делить с хостовым.
  **Важно**: контейнер работает под uid `node` (1000). Если ваш uid
  другой — `sudo chown -R 1000:1000 ~/9router-vpn/devin-state` после
  генерации, иначе devin упадёт на создании логов/сессий.

## Агенты

`AGENTS` — список через запятую, значения из реестра
(`open-sse/providers/registry/`): `codex-acp`, `opencode-acp`,
`cursor-acp`, `omp-acp`, `devin-cli` и др.

- **codex-acp**: нужен `codex` CLI + `codex login`; адаптер ставится сам
- **opencode-acp**: `opencode` + `opencode auth login`; маунты
  `~/.config|share|state|cache/opencode` обязательны (иначе 503)
- **devin-cli**: `devin` CLI + `devin auth login`; бинарь из
  `~/.local/share/devin/cli/_versions` (ro — self-update в контейнере
  не сработает, обновляйте на хосте); credentials.toml монтируется rw —
  devin обновляет токены

## Как это работает внутри

```
Zed/OnlyOffice ──► 127.0.0.1:20130 ──► 9router-acp-ui ──(netns gluetun)──► tun0 ──► VPN ──► API
                                      └─ ACP-дети (codex/opencode/devin)
                                         тот же netns → тот же VPN-путь
```

- Прокси-переменные не используются: маршрут гарантирован netns +
  policy routing + iptables (fail-closed: tun0 упал → трафик умирает,
  а не утекает напрямую)
- Дашборд `/dashboard` позволяет включать/выключать провайдеров и
  управлять моделями; выключенные не показываются в топологии Usage

## Если агент не виден в контейнере

1. `docker exec 9router-acp-ui sh -c 'which codex; codex --version'` —
   бинарь в PATH?
2. Маунт конфига агента есть в `docker-compose.yml`?
3. `ACP_PROVIDERS` в `.env` содержит провайдера?
4. В дашборде → провайдер → статус (localAgent проверяется реальным
   запуском бинаря)
