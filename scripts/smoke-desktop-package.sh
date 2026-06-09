#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
APP_NAME="TEXOR"
RELEASE_DIR="$ROOT_DIR/release-desktop"
STAGE_DIR="$RELEASE_DIR/mac-stage"
RUNTIME_DEPS=("cors" "diff" "express")
DEV_BAGGAGE=("electron" "typescript" "tsx" "vite" "concurrently")
KEY_RUNTIME_FILES=(
  "dist/index.html"
  "dist-electron/electron/main.js"
  "dist-electron/electron/preload.js"
  "dist-electron/server/lib/desktopDiagnostics.js"
  "dist-server/index.js"
  "dist-server/lib/desktopDiagnostics.js"
  "dist-server/lib/desktopServices.js"
  "package.json"
)

if [[ "$#" -gt 0 ]]; then
  ARCHS=("$@")
else
  ARCHS=("arm64" "x64")
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

info() {
  echo "INFO: $*"
}

pass() {
  echo "PASS: $*"
}

require_dir() {
  [[ -d "$1" ]] || fail "Missing directory: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "Missing file: $1"
}

require_nonempty_file() {
  require_file "$1"
  [[ -s "$1" ]] || fail "File is empty: $1"
}

require_absent() {
  [[ ! -e "$1" ]] || fail "Unexpected path present: $1"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  fail "Neither shasum nor sha256sum is available."
}

size_bytes() {
  wc -c < "$1" | tr -d '[:space:]'
}

assert_runtime_manifest() {
  local package_path="$1"
  local label="$2"

  node --input-type=module - "$package_path" "$label" <<'NODE'
import fs from 'node:fs';

const [packagePath, label] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const expectedDeps = ['cors', 'diff', 'express'];
const actualDeps = Object.keys(pkg.dependencies || {}).sort();

if (pkg.main !== 'dist-electron/electron/main.js') {
  throw new Error(`${label}: unexpected runtime main ${JSON.stringify(pkg.main)}`);
}

if (JSON.stringify(actualDeps) !== JSON.stringify(expectedDeps)) {
  throw new Error(`${label}: runtime dependencies drifted to ${actualDeps.join(', ') || '(none)'}`);
}
NODE
}

assert_relative_renderer_assets() {
  local index_path="$1"
  local label="$2"

  node --input-type=module - "$index_path" "$label" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [indexPath, label] = process.argv.slice(2);
const html = fs.readFileSync(indexPath, 'utf8');
const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"'#?]+)[^"']*["']/gi)]
  .map((match) => String(match[1] || '').trim())
  .filter(Boolean);

if (!refs.length) {
  throw new Error(`${label}: no script or stylesheet references found in ${indexPath}`);
}

for (const ref of refs) {
  if (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:')) {
    continue;
  }
  if (ref.startsWith('/')) {
    throw new Error(`${label}: asset ref ${ref} must stay relative for file:// packaging`);
  }
  const resolved = path.resolve(path.dirname(indexPath), ref);
  fs.accessSync(resolved);
}
NODE
}

assert_zip_contains() {
  local zip_path="$1"
  local entry_path="$2"

  if ! command -v unzip >/dev/null 2>&1; then
    info "Skipping zip content verification because unzip is unavailable."
    return
  fi

  unzip -l "$zip_path" "$entry_path" >/dev/null || fail "Zip is missing $entry_path in $zip_path"
}

assert_file_parity() {
  local left_path="$1"
  local right_path="$2"

  require_file "$left_path"
  require_file "$right_path"
  cmp -s "$left_path" "$right_path" || fail "Packaged file drifted from stage: $left_path != $right_path"
}

assert_not_older_than() {
  local target_path="$1"
  local reference_path="$2"
  local label="$3"

  node --input-type=module - "$target_path" "$reference_path" "$label" <<'NODE'
import fs from 'node:fs';

const [targetPath, referencePath, label] = process.argv.slice(2);
const targetStat = fs.statSync(targetPath);
const referenceStat = fs.statSync(referencePath);

if (targetStat.mtimeMs + 1000 < referenceStat.mtimeMs) {
  throw new Error(
    `${label}: ${targetPath} is older than ${referencePath}; rebuild the downstream artifact before release handoff`,
  );
}
NODE
}

verify_bundle_root() {
  local bundle_root="$1"
  local label="$2"

  require_dir "$bundle_root"
  require_dir "$bundle_root/dist"
  require_dir "$bundle_root/dist/assets"
  require_dir "$bundle_root/dist-electron/electron"
  require_dir "$bundle_root/dist-electron/server/lib"
  require_dir "$bundle_root/dist-server/lib"
  require_dir "$bundle_root/node_modules"
  require_nonempty_file "$bundle_root/dist/index.html"
  require_nonempty_file "$bundle_root/dist-electron/electron/main.js"
  require_nonempty_file "$bundle_root/dist-electron/electron/preload.js"
  require_nonempty_file "$bundle_root/dist-electron/server/lib/desktopDiagnostics.js"
  require_nonempty_file "$bundle_root/dist-server/index.js"
  require_nonempty_file "$bundle_root/dist-server/lib/desktopDiagnostics.js"
  require_nonempty_file "$bundle_root/dist-server/lib/desktopServices.js"
  require_nonempty_file "$bundle_root/package.json"
  require_absent "$bundle_root/package-lock.json"
  require_absent "$bundle_root/.git"
  require_absent "$bundle_root/node_modules/.bin"

  for dep in "${RUNTIME_DEPS[@]}"; do
    require_nonempty_file "$bundle_root/node_modules/$dep/package.json"
  done

  for baggage in "${DEV_BAGGAGE[@]}"; do
    require_absent "$bundle_root/node_modules/$baggage"
  done

  require_absent "$bundle_root/node_modules/@electron"
  require_absent "$bundle_root/node_modules/@vitejs"

  if [[ -d "$ROOT_DIR/templates" ]]; then
    require_dir "$bundle_root/templates"
  fi

  if [[ -d "$ROOT_DIR/docs" ]]; then
    require_dir "$bundle_root/docs"
  fi

  assert_runtime_manifest "$bundle_root/package.json" "$label"
  assert_relative_renderer_assets "$bundle_root/dist/index.html" "$label"
  pass "$label runtime layout is complete"
}

print_artifact_metadata() {
  local artifact_path="$1"
  local label="$2"
  local bytes
  local sha

  bytes="$(size_bytes "$artifact_path")"
  sha="$(sha256_file "$artifact_path")"
  echo "ARTIFACT $label"
  echo "  path: $artifact_path"
  echo "  size_bytes: $bytes"
  echo "  sha256: $sha"
}

main() {
  require_dir "$RELEASE_DIR"
  require_dir "$STAGE_DIR"

  verify_bundle_root "$STAGE_DIR" "mac-stage"

  for arch in "${ARCHS[@]}"; do
    local app_root="$RELEASE_DIR/mac/$APP_NAME-darwin-$arch/$APP_NAME.app/Contents/Resources/app"
    local zip_path="$RELEASE_DIR/texor-desktop-mac-${arch}-${VERSION}.zip"
    local dmg_path="$RELEASE_DIR/texor-desktop-mac-${arch}-${VERSION}.dmg"

    info "Checking packaged desktop artifacts for $arch"
    verify_bundle_root "$app_root" "$APP_NAME.app ($arch)"

    for rel_path in "${KEY_RUNTIME_FILES[@]}"; do
      assert_file_parity "$STAGE_DIR/$rel_path" "$app_root/$rel_path"
    done

    require_nonempty_file "$zip_path"
    require_nonempty_file "$dmg_path"
    assert_not_older_than "$zip_path" "$app_root/dist-electron/electron/main.js" "zip freshness ($arch)"
    assert_not_older_than "$dmg_path" "$zip_path" "dmg freshness ($arch)"
    assert_zip_contains "$zip_path" "$APP_NAME-darwin-$arch/$APP_NAME.app/Contents/Resources/app/dist/index.html"
    assert_zip_contains "$zip_path" "$APP_NAME-darwin-$arch/$APP_NAME.app/Contents/Resources/app/dist-electron/electron/main.js"
    print_artifact_metadata "$zip_path" "zip:$arch"
    print_artifact_metadata "$dmg_path" "dmg:$arch"
  done

  pass "Desktop packaging smoke test passed for ${ARCHS[*]}"
}

main
