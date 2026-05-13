#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/vscode-extension"

cd "$ROOT_DIR"

npm run build
npm run build:vscode

rm -rf "$EXT_DIR/dist-server" "$EXT_DIR/web" "$EXT_DIR/templates" "$EXT_DIR/node_modules" "$EXT_DIR/package-lock.json"
cp -R "$ROOT_DIR/dist" "$EXT_DIR/web"
cp -R "$ROOT_DIR/dist-server" "$EXT_DIR/dist-server"
mkdir -p "$EXT_DIR/templates"
cp "$ROOT_DIR/templates/catalog.json" "$EXT_DIR/templates/catalog.json"
printf '{\n  "type": "module"\n}\n' > "$EXT_DIR/dist-server/package.json"

(
  cd "$EXT_DIR"
  npm install --omit=dev --ignore-scripts
  rm -rf node_modules/.cache node_modules/.vite
  NODE_OPTIONS=--require="$ROOT_DIR/scripts/node18-file-polyfill.cjs" npx --yes @vscode/vsce package --allow-missing-repository
)

mkdir -p "$ROOT_DIR/release"
EXT_NAME="$(node -p "require('$EXT_DIR/package.json').name")"
EXT_VERSION="$(node -p "require('$EXT_DIR/package.json').version")"
cp "$EXT_DIR/${EXT_NAME}-${EXT_VERSION}.vsix" "$ROOT_DIR/release/"

du -sh "$ROOT_DIR/release/${EXT_NAME}-${EXT_VERSION}.vsix"
