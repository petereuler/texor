#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_SRC="$ROOT_DIR/vscode-extension"
EXT_ID="texor.texor-vscode-0.1.0"

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

CODEX_CLI="$(find "$HOME/.vscode-server/extensions" "$HOME/.vscode/extensions" -path '*/openai.chatgpt-*/bin/*/codex' -type f 2>/dev/null | head -n 1 || true)"
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
