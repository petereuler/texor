#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/vscode-extension"

cd "$ROOT_DIR"

if ! command -v code >/dev/null 2>&1; then
  echo "VSCode CLI 'code' was not found. Install/enable the code command first." >&2
  exit 1
fi

echo "Building TEXOR development extension..."
npm run package:vscode

EXT_NAME="$(node -p "require('$EXT_DIR/package.json').name")"
EXT_VERSION="$(node -p "require('$EXT_DIR/package.json').version")"
VSIX_PATH="$ROOT_DIR/release/${EXT_NAME}-${EXT_VERSION}.vsix"

echo "Removing any previously installed TEXOR extension..."
code --uninstall-extension texor.texor --force >/dev/null 2>&1 || true

echo "Installing development build: $VSIX_PATH"
code --install-extension "$VSIX_PATH" --force

echo
echo "Done."
echo "Use Command+Shift+P in VSCode:"
echo "  TEXOR: Open Browser Workbench"
echo
echo "The development extension starts TEXOR on http://127.0.0.1:4174 by default."
echo "Remote ZeroTier URL: http://172.23.205.253:4174"
