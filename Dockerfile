# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
ARG ALPINE_MIRROR=dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APP_VERSION=unknown

FROM ${NODE_IMAGE} AS base
ARG ALPINE_MIRROR
WORKDIR /app

# Use the official Alpine mirror by default. A repository variable/build arg can
# override it for environments that require a regional mirror.
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

FROM base AS builder
ARG NPM_REGISTRY

RUN if command -v apk >/dev/null; then \
      apk add --no-cache python3 make g++ linux-headers; \
    else \
      apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*; \
    fi

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000 \
 && npm install --no-save --registry="${NPM_REGISTRY}" ws

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
ARG ALPINE_MIRROR
ARG APP_VERSION
WORKDIR /app

RUN if command -v apk >/dev/null && [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

LABEL org.opencontainers.image.title="9router" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# ACP WebSocket bridge and custom-server import src/lib (DB repos, agent
# settings) and src/sse/services (auth) at runtime; tracing omits them.
COPY --from=builder /app/src/lib ./src/lib
COPY --from=builder /app/src/sse ./src/sse
COPY --from=builder /app/src/shared ./src/shared
COPY --from=builder /app/src/models ./src/models
# Runtime ESM loader that resolves the "@/..." path aliases used by src/lib
# outside the Next bundle (custom-server.js runs as plain Node).
COPY --from=builder /app/alias-loader.mjs ./alias-loader.mjs
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
# src/lib/db repos are imported raw (not bundled) and need their deps present.
COPY --from=builder /app/node_modules/uuid ./node_modules/uuid
COPY --from=builder /app/node_modules/undici ./node_modules/undici
# The ACP WebSocket bridge imports `ws` at runtime; standalone tracing omits it.
COPY --from=builder /app/node_modules/ws ./node_modules/ws

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  # Docker auto-creates missing bind-mount parents as root-owned; opencode
  # needs its state dirs writable (log, db) by the node user at first launch.
  mkdir -p /home/node/.local/share/opencode /home/node/.local/state/opencode /home/node/.config/opencode && chown -R node:node /home/node && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Avoid a full distribution upgrade in the runtime image. It makes builds less
# reproducible and is unrelated to installing the runtime entrypoint helper.
# codex/CLI-агенты ходят через native-tls и зависят от системных CA-корней.
RUN if command -v apk >/dev/null; then \
      apk add --no-cache su-exec ca-certificates python3 py3-pip git; \
      printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh; \
    else \
      apt-get update && apt-get install -y --no-install-recommends gosu ca-certificates python3 python3-pip python3-venv git && rm -rf /var/lib/apt/lists/*; \
      printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec gosu node "$@"\n' > /entrypoint.sh; \
    fi && chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
