#!/usr/bin/env bash
# Start OpenFARS using only project-local runtimes and state directories.
set -euo pipefail

BASE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$BASE/.runtime/node/bin"
NODE="$NODE_BIN/node"
SERVER_ENTRY="$BASE/server/dist/src/index.js"
CODEX_BIN_DIR="$BASE/.runtime/codex/node_modules/.bin"
INSPIRE_BIN_DIR="$BASE/.runtime/inspire-venv/bin"
PID_FILE="$BASE/.runtime/state/openfars.pid"
LOG_DIR="$BASE/.runtime/diagnostics/openfars"
LOG_FILE="$LOG_DIR/daemon.log"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4310}"
OPENFARS_FOREGROUND="${OPENFARS_FOREGROUND:-0}"
OPENFARS_STARTUP_TIMEOUT_SECONDS="${OPENFARS_STARTUP_TIMEOUT_SECONDS:-120}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

if [[ ! "$OPENFARS_STARTUP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPENFARS_STARTUP_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 1
fi

if [[ ! -x "$NODE" ]]; then
  echo "Project-local Node.js is missing: $NODE" >&2
  exit 1
fi
if [[ ! -f "$SERVER_ENTRY" ]]; then
  echo "OpenFARS build output is missing: $SERVER_ENTRY" >&2
  echo "Run: npm run build" >&2
  exit 1
fi
if [[ ! -x "$BASE/.runtime/codex/node_modules/.bin/codex" ]]; then
  echo "Project-local Codex CLI is missing: $BASE/.runtime/codex/node_modules/.bin/codex" >&2
  exit 1
fi
if [[ ! -f "$BASE/.env" ]]; then
  echo "Project environment file is missing: $BASE/.env" >&2
  exit 1
fi

mkdir -p "$BASE/.home" "$BASE/.cache" "$BASE/.runtime/state" "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]]; then
    if "$NODE" "$BASE/scripts/check-service-process.mjs" "$existing_pid" "$SERVER_ENTRY"; then
      if curl --noproxy '*' -fs --max-time 2 "$HEALTH_URL" >/dev/null; then
        echo "already_running pid=$existing_pid host=$HOST port=$PORT"
        echo "health=$HEALTH_URL"
        echo "log=$LOG_FILE"
        exit 0
      fi
      echo "startup_pending pid=$existing_pid host=$HOST port=$PORT"
      echo "health=$HEALTH_URL"
      echo "log=$LOG_FILE"
      exit 2
    else
      process_check_status=$?
      if [[ "$process_check_status" != "1" ]]; then
        echo "Recorded service process cannot be verified; no replacement started: pid=$existing_pid" >&2
        exit 2
      fi
    fi
  fi
fi

export PATH="$NODE_BIN:$CODEX_BIN_DIR:$INSPIRE_BIN_DIR:$PATH"
export HOME="$BASE/.home"
export CODEX_HOME="$BASE/.codex"
export XDG_CACHE_HOME="$BASE/.cache"
export NPM_CONFIG_CACHE="$BASE/.cache/npm"
export PLAYWRIGHT_BROWSERS_PATH="$BASE/.runtime/playwright"
export INSPIRE_PLAYWRIGHT_CHROMIUM_EXECUTABLE="$BASE/.runtime/playwright/chromium-1234/chrome-linux64/chrome"
export INSPIRE_SKIP_UPDATE_CHECK=1
export HOST PORT

cd "$BASE"
nohup "$NODE" "$SERVER_ENTRY" >> "$LOG_FILE" 2>&1 < /dev/null &
started_pid=$!
printf "%s\n" "$started_pid" > "$PID_FILE"

for ((attempt=0; attempt<OPENFARS_STARTUP_TIMEOUT_SECONDS; attempt++)); do
  if ! kill -0 "$started_pid" 2>/dev/null; then
    break
  fi
  if curl --noproxy '*' -fs --max-time 2 "$HEALTH_URL" >/dev/null; then
    echo "started pid=$started_pid host=$HOST port=$PORT"
    echo "health=$HEALTH_URL"
    echo "log=$LOG_FILE"
    if [[ "$OPENFARS_FOREGROUND" == "1" ]]; then
      wait "$started_pid"
    fi
    exit 0
  fi
  sleep 1
done

# Initialization can outlast this observation window. Keep the original PID
# while it is alive or uncertain; a second start must observe that same process.
# This is lifecycle bookkeeping, never an Agent/task completion decision.
if "$NODE" "$BASE/scripts/check-service-process.mjs" "$started_pid" "$SERVER_ENTRY"; then
  if curl --noproxy '*' -fs --max-time 2 "$HEALTH_URL" >/dev/null; then
    echo "started pid=$started_pid host=$HOST port=$PORT"
    echo "health=$HEALTH_URL"
    echo "log=$LOG_FILE"
    if [[ "$OPENFARS_FOREGROUND" == "1" ]]; then
      wait "$started_pid"
    fi
    exit 0
  fi
  echo "startup_pending pid=$started_pid host=$HOST port=$PORT"
  echo "health=$HEALTH_URL"
  echo "log=$LOG_FILE"
  exit 2
else
  process_check_status=$?
  if [[ "$process_check_status" != "1" ]]; then
    echo "Started service process cannot be verified; PID retained: pid=$started_pid" >&2
    exit 2
  fi
fi

if [[ "$(tr -d '[:space:]' < "$PID_FILE")" == "$started_pid" ]]; then
  rm -f "$PID_FILE"
fi
tail -n 80 "$LOG_FILE" >&2 || true
exit 1
