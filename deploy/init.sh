#!/usr/bin/env bash
# Генерирует docker-compose.yml + .env для развёртывания 9router с
# ACP-агентами в общем netns с вашим VPN-контейнером (gluetun).
#
# Использование:
#   ./deploy/init.sh [REPO_DIR] [OUT_DIR]
#
#   REPO_DIR — чекаут 9router-max-exp (default: репозиторий этого скрипта)
#   OUT_DIR  — куда писать compose (default: ~/9router-vpn)
#
# Переменные окружения:
#   PORT=20130            порт, который опубликует ваш VPN-контейнер
#   AGENTS=codex-acp,opencode-acp,devin-cli
#   PROJECTS_DIR=$HOME/Projects   каталог проектов, видимый агентам
#
# Скрипт детектит каталоги агентов в $HOME и включает маунты только для
# существующих. Бинарники ищет в стандартных местах; если ваш CLI лежит
# elsewhere — добавьте его каталог в BIN_PATHS вручную в .env не выйдет,
# PATH собирается здесь: поправьте секцию volumes/PATH в результате.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${1:-$SCRIPT_DIR/..}" && pwd)"
OUT_DIR="$(mkdir -p "${2:-$HOME/9router-vpn}" && cd "${2:-$HOME/9router-vpn}" && pwd)"
PORT="${PORT:-20130}"
AGENTS="${AGENTS:-codex-acp,opencode-acp}"
PROJECTS_DIR="${PROJECTS_DIR:-$HOME/Projects}"
IMAGE="vpn-9router-acp-ui:latest"

[ -f "$REPO_DIR/Dockerfile" ] || { echo "error: $REPO_DIR/Dockerfile not found" >&2; exit 1; }
[ -d "$PROJECTS_DIR" ] || echo "warn: PROJECTS_DIR $PROJECTS_DIR does not exist — agents will see an empty dir" >&2

# --- mounts ---------------------------------------------------------------
# mount <host-path> <container-path> [ro] — добавляет строку volume,
# только если host-путь существует.
volumes=()
mount() {
  local src="$1" dst="$2" mode="${3:-rw}"
  [ -e "$src" ] || return 0
  if [ "$mode" = "ro" ]; then
    volumes+=("      - $src:$dst:ro")
  else
    volumes+=("      - $src:$dst")
  fi
}

has_agent() { [[ ",$AGENTS," == *",$1,"* ]]; }

# Базовое
volumes+=("      - 9router-acp-data:/app/data")
mount "$PROJECTS_DIR" "$PROJECTS_DIR"

# codex
if has_agent codex-acp; then
  mount "$HOME/.codex" /home/node/.codex
  mount "$HOME/.cache/codex-runtimes" "$HOME/.cache/codex-runtimes" ro
fi

# opencode
if has_agent opencode-acp; then
  mount "$HOME/.config/opencode" /home/node/.config/opencode
  mount "$HOME/.local/share/opencode" /home/node/.local/share/opencode
  mount "$HOME/.local/state/opencode" /home/node/.local/state/opencode
  mount "$HOME/.cache/opencode" /home/node/.cache/opencode
fi

# devin-cli: state отделён от хостового devin (своя sessions.db),
# credentials и бинарь монтируются из ~/.local/share/devin.
DEVIN_STATE="$OUT_DIR/devin-state"
if has_agent devin-cli; then
  if [ -f "$HOME/.local/share/devin/credentials.toml" ]; then
    mkdir -p "$DEVIN_STATE"
    mount "$DEVIN_STATE" /home/node/.local/share/devin
    mount "$HOME/.local/share/devin/credentials.toml" /home/node/.local/share/devin/credentials.toml
    mount "$HOME/.local/share/devin/cli/_versions" /home/node/.local/share/devin/cli/_versions ro
    mount "$HOME/.config/devin" /home/node/.config/devin
    echo "devin-cli: state dir -> $DEVIN_STATE"
  else
    echo "warn: devin-cli в AGENTS, но $HOME/.local/share/devin/credentials.toml не найден — маунты devin пропущены" >&2
  fi
fi

# Бинари хоста: монтируем по ТОМУ ЖЕ пути, что на хосте (ro), и добавляем
# в PATH — так CLI, установленные через npm -g/nvm, видны внутри контейнера.
# nvm монтируем ЦЕЛИКОМ: bin/* — симлинки на ../lib/node_modules, без lib
# глобально установленные CLI не запустятся.
bin_paths=()
mount "$HOME/.local/bin" "$HOME/.local/bin" ro
mount "$HOME/.opencode/bin" "$HOME/.opencode/bin" ro
[ -d "$HOME/.nvm" ] && mount "$HOME/.nvm" "$HOME/.nvm" ro
for d in "$HOME/.local/bin" "$HOME/.opencode/bin" "$HOME/.nvm/versions/node"/*/bin; do
  [ -d "$d" ] && bin_paths+=("$d")
done
BIN_PATHS="$(IFS=:; echo "${bin_paths[*]:-/nonexistent}")"

# --- ACP_MODEL_ALLOW -------------------------------------------------------
# По умолчанию разрешаем все модели каждого включённого агента.
# opencode-acp — особый случай: child-id вида "opencode/<model>", поэтому
# qualified id = "opencode-acp/opencode/<model>" (как в проде).
allow=""
for a in ${AGENTS//,/ }; do
  [ -n "$allow" ] && allow+=","
  if [ "$a" = "opencode-acp" ]; then
    allow+="opencode-acp/opencode/*"
  else
    allow+="$a/*"
  fi
done

# --- .env ------------------------------------------------------------------
PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 20)"
cat > "$OUT_DIR/.env" <<EOF
# Сгенерировано deploy/init.sh — не коммитьте.
INITIAL_PASSWORD=$PASSWORD
PORT=$PORT
ACP_PROVIDERS=$AGENTS
ACP_MODEL_ALLOW=$allow
EOF
chmod 600 "$OUT_DIR/.env"

# --- docker-compose.yml ----------------------------------------------------
cat > "$OUT_DIR/docker-compose.yml" <<EOF
# Сгенерировано deploy/init.sh ($(date -u +%Y-%m-%dT%H:%M:%SZ)).
# VPN-сервис (gluetun) сюда НЕ входит — добавьте свой файлом:
#   docker compose -f docker-compose.yml -f /path/to/vpn.yml up -d
services:
  9router-acp-ui:
    build:
      context: $REPO_DIR
      dockerfile: $REPO_DIR/Dockerfile
      args:
        NODE_IMAGE: node:22-bookworm-slim
        APP_VERSION: vpn-agents
    image: $IMAGE
    container_name: 9router-acp-ui
    security_opt:
      - seccomp=unconfined
    network_mode: "service:gluetun"
    depends_on:
      - gluetun
    ports: !reset []
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
      HOSTNAME: "0.0.0.0"
      DATA_DIR: /app/data
      HOME: /home/node
      NODE_OPTIONS: "--experimental-loader /app/alias-loader.mjs"
      PATH: /app/data/npm-global/bin:/usr/local/bin:/usr/bin:/bin:$BIN_PATHS
      PYTHONUSERBASE: /app/data/pylocal
      PIP_USER: "1"
      PIP_BREAK_SYSTEM_PACKAGES: "1"
      NPM_CONFIG_PREFIX: /app/data/npm-global
      NINEROUTER_TRUSTED_PEERS: "172.20.0.1"
      GIT_CONFIG_COUNT: "1"
      GIT_CONFIG_KEY_0: safe.directory
      GIT_CONFIG_VALUE_0: "*"
    volumes:
$(printf '%s\n' "${volumes[@]}")

volumes:
  9router-acp-data:
    name: 9router-acp-data
EOF

cat <<EOF

Готово:
  $OUT_DIR/docker-compose.yml
  $OUT_DIR/.env            (пароль дашборда внутри, chmod 600)

Дальше:
  1. Добавьте свой VPN-сервис (gluetun) отдельным compose-файлом — он должен
     называться сервисом \`gluetun\` и публиковать порт $PORT на 127.0.0.1.
  2. docker compose -f $OUT_DIR/docker-compose.yml -f /path/to/vpn.yml build
  3. docker compose -f $OUT_DIR/docker-compose.yml -f /path/to/vpn.yml up -d

Dashboard: http://127.0.0.1:$PORT/dashboard  (пароль — в .env)
EOF
