#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
APP_NAME="TEXOR"
RELEASE_DIR="$ROOT_DIR/release-desktop"
APP_BUILD_DIR="$RELEASE_DIR/mac"
ENTITLEMENTS_PATH="$ROOT_DIR/scripts/entitlements.mac.plist"
IDENTITY="${APPLE_SIGN_IDENTITY:-}"

if [[ -z "$IDENTITY" ]]; then
  echo "APPLE_SIGN_IDENTITY is required, for example:" >&2
  echo "  Developer ID Application: Your Name (TEAMID)" >&2
  exit 1
fi

if [[ "$#" -gt 0 ]]; then
  ARCHS=("$@")
else
  ARCHS=("arm64" "x64")
fi

codesign_one_app() {
  local app_path="$1"

  find "$app_path/Contents/Frameworks" \
    \( -name "*.app" -o -name "*.framework" -o -name "*.dylib" -o -name "*.so" -o -path "*/MacOS/*" \) \
    -print0 \
    | while IFS= read -r -d '' target; do
        codesign --force --options runtime --timestamp --sign "$IDENTITY" "$target"
      done

  codesign \
    --force \
    --deep \
    --options runtime \
    --timestamp \
    --entitlements "$ENTITLEMENTS_PATH" \
    --sign "$IDENTITY" \
    "$app_path"

  codesign --verify --deep --strict --verbose=2 "$app_path"
  spctl --assess --type execute --verbose=2 "$app_path"
}

for arch in "${ARCHS[@]}"; do
  APP_PATH="$APP_BUILD_DIR/$APP_NAME-darwin-$arch/$APP_NAME.app"
  ZIP_PATH="$RELEASE_DIR/texor-desktop-mac-${arch}-${VERSION}.zip"

  if [[ ! -d "$APP_PATH" ]]; then
    echo "Missing packaged app for $arch: $APP_PATH" >&2
    exit 1
  fi

  codesign_one_app "$APP_PATH"

  rm -f "$ZIP_PATH"
  (
    cd "$APP_BUILD_DIR"
    zip -qry "$ZIP_PATH" "$APP_NAME-darwin-$arch"
  )

  echo "Signed macOS app:"
  echo "  $APP_PATH"
  echo "Repacked signed archive:"
  echo "  $ZIP_PATH"
done
