#!/bin/sh
# Renor container entrypoint.
#   (no arguments)      the HTTP server: MCP over HTTP with OAuth sign-in for one owner (node dist/mvp/cli.js)
#   <anything else>     the command-line tool with those arguments, e.g. `mcp` for the stdio server
# Everything Renor keeps lives under RENOR_DATA_DIR (default /data), the one volume to persist.
set -eu

DATA="${RENOR_DATA_DIR:-/data}"

# Started as root (the default): give the volume to the unprivileged `node` user, then run as that user. A platform
# volume (Fly, Render, Railway) is mounted root-owned, so the image cannot simply start as `node`. `docker run --user`
# skips this branch.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA"
  [ "$(stat -c %u "$DATA")" = "$(id -u node)" ] || chown -R node:node "$DATA"
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all -- "$0" "$@"
fi

umask 077

if [ "$#" -gt 0 ]; then
  export VAULT_PATH="${VAULT_PATH:-$DATA/vault}"
  exec node /app/dist/cli.js "$@"
fi

export MVP_MEMORY_DIR="${MVP_MEMORY_DIR:-$DATA/memory}"
export MVP_AUTH_STATE_PATH="${MVP_AUTH_STATE_PATH:-$DATA/auth/clients.json}"
export MVP_PORT="${MVP_PORT:-${PORT:-3471}}"
# Loopback unless MVP_HOST says otherwise: inside a container that is reachable only from the container itself, so a
# `docker run -p` or a platform proxy needs MVP_HOST=0.0.0.0 (render.yaml, railway.toml and fly.toml set it). A bind
# beyond loopback is refused at start unless MVP_BASE_URL is https (or names localhost).
export MVP_HOST="${MVP_HOST:-127.0.0.1}"

# The public URL agents connect to. Set it yourself, or let the platform name it.
if [ -z "${MVP_BASE_URL:-}" ]; then
  if [ -n "${RENDER_EXTERNAL_URL:-}" ]; then MVP_BASE_URL="$RENDER_EXTERNAL_URL"
  elif [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then MVP_BASE_URL="https://$RAILWAY_PUBLIC_DOMAIN"
  elif [ -n "${FLY_APP_NAME:-}" ]; then MVP_BASE_URL="https://$FLY_APP_NAME.fly.dev"
  else MVP_BASE_URL="http://localhost:$MVP_PORT"
  fi
  export MVP_BASE_URL
fi

mkdir -p "$MVP_MEMORY_DIR" "$(dirname "$MVP_AUTH_STATE_PATH")"
chmod 0700 "$MVP_MEMORY_DIR" "$(dirname "$MVP_AUTH_STATE_PATH")"

exec node /app/dist/mvp/cli.js
