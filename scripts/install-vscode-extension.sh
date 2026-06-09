#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_SRC="$ROOT_DIR/vscode-extension"
EXT_ID="texor.texor-vscode-0.1.0"

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

if [[ -d "$HOME/.vscode-server/extensions" ]]; then
  EXT_DIR="$HOME/.vscode-server/extensions/$EXT_ID"
elif [[ -d "$HOME/.vscode/extensions" ]]; then
  EXT_DIR="$HOME/.vscode/extensions/$EXT_ID"
else
  EXT_DIR="$HOME/.vscode-server/extensions/$EXT_ID"
  mkdir -p "$(dirname "$EXT_DIR")"
fi

cd "$ROOT_DIR"
npm run build:vscode >/dev/null

rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp "$EXT_SRC/package.json" "$EXT_DIR/package.json"
cp "$EXT_SRC/README.md" "$EXT_DIR/README.md"
cp "$EXT_SRC/CHANGELOG.md" "$EXT_DIR/CHANGELOG.md"
cp "$EXT_SRC/LICENSE" "$EXT_DIR/LICENSE"
cp -R "$EXT_SRC/dist" "$EXT_DIR/dist"

CODEX_CLI="$(detect_platform_codex || true)"
if [[ -z "$CODEX_CLI" ]]; then
  CODEX_CLI="$(command -v codex || true)"
fi

if [[ -n "$CODEX_CLI" ]]; then
  chmod +x "$CODEX_CLI" 2>/dev/null || true
  SETTINGS_FILE="$HOME/.vscode-server/data/Machine/settings.json"
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  node - "$SETTINGS_FILE" "$CODEX_CLI" <<'NODE'
const fs = require('fs');
const [settingsPath, codexPath] = process.argv.slice(2);
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch {}
settings['texor.codexExecutable'] = codexPath;
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE

  for dir in "$HOME"/.vscode-server/cli/servers/Stable-*/server/bin/remote-cli; do
    if [[ -d "$dir" ]]; then
      ln -sf "$CODEX_CLI" "$dir/codex"
    fi
  done
fi

cat <<MSG
texor VSCode extension installed:
  $EXT_DIR

Codex CLI:
  ${CODEX_CLI:-not found}

Next:
  1. Reload VSCode window: Ctrl+Shift+P -> Developer: Reload Window
  2. Open Command Palette and run: TEXOR: Open Browser Workbench
MSG
