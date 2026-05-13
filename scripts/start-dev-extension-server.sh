#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/vscode-extension"
PORT="${PORT:-4174}"

cd "$ROOT_DIR"

if [[ ! -f "$EXT_DIR/dist-server/index.js" || ! -f "$EXT_DIR/web/index.html" ]]; then
  npm run build:extension-dev
fi

pids="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
if [[ -n "$pids" ]]; then
  kill $pids 2>/dev/null || true
  sleep 0.4
fi

echo "Starting TEXOR development workbench from local build:"
echo "  root: $EXT_DIR"
echo "  url:  http://127.0.0.1:$PORT"
echo "  zt:   http://172.23.205.253:$PORT"

exec env NODE_ENV=production PORT="$PORT" TEXOR_APP_ROOT="$EXT_DIR" node "$EXT_DIR/dist-server/index.js"
