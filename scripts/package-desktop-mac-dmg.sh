#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
APP_NAME="TEXOR"
APP_VOLUME_NAME="TEXOR-1"
RELEASE_DIR="$ROOT_DIR/release-desktop"
APP_BUILD_DIR="$RELEASE_DIR/mac"
TOOLS_DIR="$ROOT_DIR/.texor-data/desktop-tools/libdmg-hfsplus"

if [[ "$#" -gt 0 ]]; then
  ARCHS=("$@")
else
  ARCHS=("arm64" "x64")
fi

ensure_packaged_apps() {
  local arch
  for arch in "${ARCHS[@]}"; do
    if [[ ! -d "$APP_BUILD_DIR/$APP_NAME-darwin-$arch/$APP_NAME.app" ]]; then
      npm run package:desktop:mac
      return
    fi
  done
}

ensure_dmg_tools() {
  if [[ -x "$TOOLS_DIR/build/hfs/hfsplus" && -x "$TOOLS_DIR/build/dmg/dmg" ]]; then
    return
  fi

  rm -rf "$TOOLS_DIR"
  mkdir -p "$(dirname "$TOOLS_DIR")"
  git clone --depth 1 https://github.com/mozilla/libdmg-hfsplus.git "$TOOLS_DIR"
  cmake -S "$TOOLS_DIR" -B "$TOOLS_DIR/build"
  cmake --build "$TOOLS_DIR/build" -j4
}

patch_volume_name() {
  local hfs_path="$1"
  python3 - "$hfs_path" "$APP_VOLUME_NAME" <<'PY'
from pathlib import Path
import sys

hfs_path = Path(sys.argv[1])
volume_name = sys.argv[2]
template_name = "Firefox"

if len(volume_name) != len(template_name):
    raise SystemExit(f"volume name must be exactly {len(template_name)} characters: {volume_name!r}")

data = hfs_path.read_bytes()
source = template_name.encode("utf-16-be")
target = volume_name.encode("utf-16-be")

occurrences = data.count(source)
if occurrences < 2:
    raise SystemExit(f"unexpected template volume-name occurrences: {occurrences}")

hfs_path.write_bytes(data.replace(source, target))
PY
}

build_one_dmg() {
  local arch="$1"
  local app_root="$APP_BUILD_DIR/$APP_NAME-darwin-$arch"
  local app_path="$app_root/$APP_NAME.app"
  local dmg_path="$RELEASE_DIR/texor-desktop-mac-${arch}-${VERSION}.dmg"
  local tmp_dir
  local stage_dir
  local image_hfs
  local verify_hfs
  local app_bytes
  local image_bytes
  local min_padding_bytes=$((256 * 1024 * 1024))
  local max_image_bytes=$((1024 * 1024 * 1024))
  local hfsplus_bin="$TOOLS_DIR/build/hfs/hfsplus"
  local dmg_bin="$TOOLS_DIR/build/dmg/dmg"

  if [[ ! -d "$app_path" ]]; then
    echo "Missing packaged app for $arch: $app_path" >&2
    exit 1
  fi

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN
  stage_dir="$tmp_dir/stage"
  image_hfs="$tmp_dir/${APP_NAME}-${arch}.hfs"
  verify_hfs="$tmp_dir/${APP_NAME}-${arch}-verify.hfs"

  mkdir -p "$stage_dir"
  cp -a "$app_path" "$stage_dir/"

  cp "$TOOLS_DIR/test/empty.hfs" "$image_hfs"
  patch_volume_name "$image_hfs"

  app_bytes="$(du -sb "$app_path" | cut -f1)"
  image_bytes=$((app_bytes + min_padding_bytes))
  if (( image_bytes > max_image_bytes )); then
    echo "App is too large for the current Linux DMG packer limit: $app_bytes bytes" >&2
    exit 1
  fi

  "$hfsplus_bin" "$image_hfs" grow "$image_bytes" >/dev/null
  "$hfsplus_bin" --symlinks=clone_link --special-modes=no "$image_hfs" addall "$stage_dir" / >/dev/null
  "$hfsplus_bin" "$image_hfs" symlink /Applications /Applications >/dev/null

  rm -f "$dmg_path"
  "$dmg_bin" -c zlib -l 9 build "$image_hfs" "$dmg_path" >/dev/null

  "$dmg_bin" extract "$dmg_path" "$verify_hfs" >/dev/null
  "$hfsplus_bin" "$verify_hfs" ls / >/dev/null
  "$hfsplus_bin" "$verify_hfs" ls "/$APP_NAME.app" >/dev/null

  echo "Desktop macOS DMG created:"
  echo "  $dmg_path"
  echo "  volume: $APP_VOLUME_NAME"
}

mkdir -p "$RELEASE_DIR"
ensure_packaged_apps
ensure_dmg_tools

for arch in "${ARCHS[@]}"; do
  build_one_dmg "$arch"
done
