#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/vscode-extension"

cd "$ROOT_DIR"

npm run build
npm run build:vscode

rm -rf "$EXT_DIR/dist-server" "$EXT_DIR/web" "$EXT_DIR/templates"
cp -R "$ROOT_DIR/dist" "$EXT_DIR/web"
cp -R "$ROOT_DIR/dist-server" "$EXT_DIR/dist-server"
mkdir -p "$EXT_DIR/templates"
cp "$ROOT_DIR/templates/catalog.json" "$EXT_DIR/templates/catalog.json"
printf '{\n  "type": "module"\n}\n' > "$EXT_DIR/dist-server/package.json"

echo "TEXOR development extension assets are ready."
echo "To use it from Command+Shift+P, run:"
echo "  npm run install:dev-extension"
echo "Then choose:"
echo "  TEXOR: Open Browser Workbench"
echo "Workbench listens through the extension on http://127.0.0.1:4174 by default."
