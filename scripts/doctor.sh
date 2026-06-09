#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR_SERVER="$HOME/.vscode-server/extensions/texor.texor-vscode-0.1.0"
EXT_DIR_LOCAL="$HOME/.vscode/extensions/texor.texor-vscode-0.1.0"

detect_platform_codex() {
  local os_name
  local arch_name
  case "$(uname -s)" in
    Linux) os_name="linux" ;;
    Darwin) os_name="darwin" ;;
    *) os_name="" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch_name="x64" ;;
    arm64|aarch64) arch_name="arm64" ;;
    *) arch_name="" ;;
  esac
  local platform_dir=""
  if [[ -n "$os_name" && -n "$arch_name" ]]; then
    platform_dir="${os_name}-${arch_name}"
  fi

  local roots=("$HOME/.vscode-server/extensions" "$HOME/.vscode/extensions")
  local root
  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || continue
    if [[ -n "$platform_dir" ]]; then
      find "$root" -path "*/openai.chatgpt-*/bin/${platform_dir}/codex" -type f 2>/dev/null | head -n 1 && return 0
    fi
    find "$root" -path '*/openai.chatgpt-*/bin/*/codex' -type f 2>/dev/null | head -n 1 && return 0
  done
  return 1
}

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
  codex_path="$(detect_platform_codex || true)"
  if [[ -n "$codex_path" ]]; then
    echo "ok   OpenAI extension Codex binary: $codex_path"
  else
    echo "miss Codex: install the OpenAI/Codex VSCode extension or set texor.codexExecutable"
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
