#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.texor-data/logs"
PID_DIR="$ROOT_DIR/.texor-data/pids"

mkdir -p "$LOG_DIR" "$PID_DIR"
cd "$ROOT_DIR"

stop_project_processes() {
  local pids
  pids="$(pgrep -f "$ROOT_DIR/node_modules/.bin/tsx watch server/index.ts|$ROOT_DIR/node_modules/.bin/vite|server/index.ts" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
  fi
}

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
  fi
}

stop_project_processes
stop_port 4173
stop_port 4174

start_background() {
  local name="$1"
  local logfile="$2"
  shift 2

  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$logfile" 2>&1 </dev/null &
  else
    nohup "$@" >"$logfile" 2>&1 </dev/null &
  fi
  echo "$!" > "$PID_DIR/$name.pid"
}

start_background server "$LOG_DIR/server.log" npm run dev:server
start_background client "$LOG_DIR/client.log" npm run dev:client

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:4174/api/health >/dev/null 2>&1 && lsof -iTCP:4173 -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS http://127.0.0.1:4174/api/health >/dev/null 2>&1; then
  echo "texor backend did not start. Log:"
  tail -80 "$LOG_DIR/server.log" || true
  exit 1
fi

if ! lsof -iTCP:4173 -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "texor frontend did not start. Log:"
  tail -80 "$LOG_DIR/client.log" || true
  exit 1
fi

cat <<MSG
texor is running.

Browser:
  http://127.0.0.1:4173

Logs:
  $LOG_DIR/server.log
  $LOG_DIR/client.log
MSG
