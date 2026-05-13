#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
npm install
npm run typecheck
"$ROOT_DIR/scripts/install-vscode-extension.sh"
"$ROOT_DIR/scripts/start-texor.sh"

cat <<MSG

Done.

Use it:
  1. Reload VSCode window.
  2. Open a project in VSCode.
  3. Run command: Texor: Open
  4. Use the browser workbench at http://127.0.0.1:4173
MSG
