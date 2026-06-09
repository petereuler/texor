#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
APP_NAME="TEXOR"
RELEASE_DIR="$ROOT_DIR/release-desktop"
APP_DIR="$RELEASE_DIR/mac"
ARCHS=("arm64" "x64")
STAGE_DIR="$RELEASE_DIR/mac-stage"
RUNTIME_DEPS=("cors" "diff" "express")

rm -rf "$APP_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$APP_DIR"
mkdir -p "$STAGE_DIR"

npm run build:desktop

mkdir -p "$STAGE_DIR/dist-server"
mkdir -p "$STAGE_DIR/dist-electron"
rsync -a --delete dist/ "$STAGE_DIR/dist/"
rsync -a --delete dist-server/ "$STAGE_DIR/dist-server/"
rsync -a --delete dist-electron/ "$STAGE_DIR/dist-electron/"

if [[ -d "$ROOT_DIR/templates" ]]; then
  rsync -a "$ROOT_DIR/templates/" "$STAGE_DIR/templates/"
fi

if [[ -d "$ROOT_DIR/docs" ]]; then
  rsync -a "$ROOT_DIR/docs/" "$STAGE_DIR/docs/"
fi

cat > "$STAGE_DIR/package.json" <<EOF
{
  "name": "texor-desktop-runtime",
  "version": "$VERSION",
  "private": true,
  "type": "module",
  "main": "dist-electron/electron/main.js",
  "dependencies": {
    "cors": "$(node -p "require('./package.json').dependencies.cors")",
    "diff": "$(node -p "require('./package.json').dependencies.diff")",
    "express": "$(node -p "require('./package.json').dependencies.express")"
  }
}
EOF

npm install \
  --prefix "$STAGE_DIR" \
  --omit=dev \
  --ignore-scripts \
  --no-package-lock

rm -rf "$STAGE_DIR/node_modules/.bin"

for ARCH in "${ARCHS[@]}"; do
  ZIP_PATH="$RELEASE_DIR/texor-desktop-mac-${ARCH}-${VERSION}.zip"
  rm -f "$ZIP_PATH"

  npx @electron/packager "$STAGE_DIR" "$APP_NAME" \
    --platform=darwin \
    --arch="$ARCH" \
    --out="$APP_DIR" \
    --overwrite \
    --prune=true \
    --ignore='^/\\.git($|/)' \
    --ignore='^/node_modules/\\.cache($|/)'

  (
    cd "$APP_DIR"
    zip -qry "$ZIP_PATH" "$APP_NAME-darwin-$ARCH"
  )

  echo "Desktop macOS package created:"
  echo "  $ZIP_PATH"
done
