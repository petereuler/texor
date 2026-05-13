#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.texor-data/pids"

cd "$ROOT_DIR"

for name in server client; do
  pid_file="$PID_DIR/$name.pid"
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
done

project_pids="$(pgrep -f "$ROOT_DIR/node_modules/.bin/tsx watch server/index.ts|$ROOT_DIR/node_modules/.bin/vite|server/index.ts" 2>/dev/null || true)"
if [[ -n "$project_pids" ]]; then
  kill $project_pids 2>/dev/null || true
fi

for port in 4173 4174; do
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
  fi
done

echo "texor stopped."
