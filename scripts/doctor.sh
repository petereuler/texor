#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR_SERVER="$HOME/.vscode-server/extensions/texor.texor-vscode-0.1.0"
EXT_DIR_LOCAL="$HOME/.vscode/extensions/texor.texor-vscode-0.1.0"

echo "texor doctor"
echo

check_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    echo "ok   command: $name"
  else
    echo "miss command: $name"
  fi
}

check_port() {
  local port="$1"
  if lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "ok   port: $port"
  else
    echo "miss port: $port"
  fi
}

check_cmd node
check_cmd npm
check_cmd code
check_cmd pdflatex

if command -v codex >/dev/null 2>&1; then
  echo "ok   command: codex"
else
  codex_path="$(find "$HOME/.vscode-server/extensions" "$HOME/.vscode/extensions" -path '*/bin/*/codex' -type f 2>/dev/null | head -n 1 || true)"
  if [[ -n "$codex_path" ]]; then
    echo "ok   OpenAI extension Codex CLI: $codex_path"
  else
    echo "miss command: codex"
  fi
fi

check_port 4173
check_port 4174

if [[ -d "$EXT_DIR_SERVER" || -d "$EXT_DIR_LOCAL" ]]; then
  echo "ok   VSCode extension installed"
else
  echo "miss VSCode extension installed"
fi

if curl -fsS http://127.0.0.1:4174/api/health >/dev/null 2>&1; then
  echo "ok   backend health"
else
  echo "miss backend health"
fi

echo
echo "Run all setup:"
echo "  npm run setup:codex"
echo
echo "Open TEXOR:"
echo "  Ctrl+Shift+P -> TEXOR: Open Browser Workbench"
