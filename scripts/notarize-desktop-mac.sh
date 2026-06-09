#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
APP_NAME="TEXOR"
RELEASE_DIR="$ROOT_DIR/release-desktop"
APP_BUILD_DIR="$RELEASE_DIR/mac"

APPLE_ID="${APPLE_NOTARY_APPLE_ID:-}"
TEAM_ID="${APPLE_NOTARY_TEAM_ID:-}"
PASSWORD="${APPLE_NOTARY_PASSWORD:-}"
PROFILE="${APPLE_NOTARY_KEYCHAIN_PROFILE:-}"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun is required for notarization." >&2
  exit 1
fi

if [[ "$#" -gt 0 ]]; then
  ARCHS=("$@")
else
  ARCHS=("arm64" "x64")
fi

notarytool_args() {
  if [[ -n "$PROFILE" ]]; then
    printf -- "--keychain-profile\0%s\0" "$PROFILE"
    return
  fi

  if [[ -z "$APPLE_ID" || -z "$TEAM_ID" || -z "$PASSWORD" ]]; then
    echo "Provide either APPLE_NOTARY_KEYCHAIN_PROFILE or all of APPLE_NOTARY_APPLE_ID, APPLE_NOTARY_TEAM_ID, APPLE_NOTARY_PASSWORD." >&2
    exit 1
  fi

  printf -- "--apple-id\0%s\0--team-id\0%s\0--password\0%s\0" "$APPLE_ID" "$TEAM_ID" "$PASSWORD"
}

mapfile -d '' NOTARY_ARGS < <(notarytool_args)

for arch in "${ARCHS[@]}"; do
  ZIP_PATH="$RELEASE_DIR/texor-desktop-mac-${arch}-${VERSION}.zip"
  DMG_PATH="$RELEASE_DIR/texor-desktop-mac-${arch}-${VERSION}.dmg"
  APP_PATH="$APP_BUILD_DIR/$APP_NAME-darwin-$arch/$APP_NAME.app"

  if [[ ! -f "$ZIP_PATH" ]]; then
    echo "Missing signed zip for $arch: $ZIP_PATH" >&2
    exit 1
  fi
  if [[ ! -d "$APP_PATH" ]]; then
    echo "Missing signed app for $arch: $APP_PATH" >&2
    exit 1
  fi
  if [[ ! -f "$DMG_PATH" ]]; then
    echo "Missing dmg for $arch: $DMG_PATH" >&2
    exit 1
  fi

  xcrun notarytool submit "$ZIP_PATH" --wait "${NOTARY_ARGS[@]}"
  xcrun stapler staple "$APP_PATH"

  xcrun notarytool submit "$DMG_PATH" --wait "${NOTARY_ARGS[@]}"
  xcrun stapler staple "$DMG_PATH"

  echo "Notarized macOS artifacts:"
  echo "  $APP_PATH"
  echo "  $DMG_PATH"
done
