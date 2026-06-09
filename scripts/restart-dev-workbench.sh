#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "Rebuilding TEXOR development assets..."
npm run build:extension-dev >/dev/null

echo "Relinking the VS Code development extension..."
npm run install:dev-extension >/dev/null

echo "Restarting the repo development servers..."
npm run start:texor >/dev/null

cat <<'MSG'
TEXOR development environment has been restarted.

Server URLs:
  http://127.0.0.1:4173
  http://127.0.0.1:4174/api/health

Active VS Code dev extension:
  texor-dev.texor@0.3.4-dev
  display name: TEXOR Workbench (Dev)

Next in VS Code:
  1. If the current workspace is restricted, trust it.
  2. Run Ctrl+Shift+P -> Developer: Reload Window
  3. Run Ctrl+Shift+P -> TEXOR: Open Browser Workbench
MSG
