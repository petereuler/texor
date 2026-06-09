#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_SRC="$ROOT_DIR/vscode-extension"
DEV_EXT_SRC="$ROOT_DIR/.texor-data/dev-vscode-extension"
BACKUP_DIR="$ROOT_DIR/.texor-data/dev-extension-backups"

detect_platform_codex() {
  local os_name=""
  local arch_name=""
  case "$(uname -s)" in
    Linux) os_name="linux" ;;
    Darwin) os_name="darwin" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch_name="x64" ;;
    arm64|aarch64) arch_name="arm64" ;;
  esac

  local platform_dir=""
  if [[ -n "$os_name" && -n "$arch_name" ]]; then
    platform_dir="${os_name}-${arch_name}"
  fi

  local roots=("$HOME/.vscode-server/extensions" "$HOME/.vscode/extensions")
  local root
  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || continue
    if [[ -n "$platform_dir" ]]; then
      find "$root" -path "*/openai.chatgpt-*/bin/${platform_dir}/codex" -type f 2>/dev/null | head -n 1 && return 0
    fi
    find "$root" -path '*/openai.chatgpt-*/bin/*/codex' -type f 2>/dev/null | head -n 1 && return 0
  done
  return 1
}

configure_vscode_settings() {
  local settings_file="$1"
  local codex_cli="$2"
  mkdir -p "$(dirname "$settings_file")"

  node - "$settings_file" "$ROOT_DIR" "$codex_cli" <<'NODE'
const fs = require('fs');
const [settingsPath, rootPath, codexPath] = process.argv.slice(2);

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch {}

settings['texor.serverUrl'] = 'http://127.0.0.1:4173';
settings['texor.webUrl'] = 'http://127.0.0.1:4173';
settings['texor.appPath'] = rootPath;
if (codexPath) {
  settings['texor.codexExecutable'] = codexPath;
}

fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
}

clear_texor_vscode_caches() {
  local cache_root
  for cache_root in "$HOME/.vscode-server/data" "$HOME/.config/Code/User"; do
    [[ -d "$cache_root" ]] || continue

    find "$cache_root" -path '*/CachedExtensionVSIXs/texor.texor-*' -print -exec rm -rf {} + 2>/dev/null || true
    find "$cache_root" -path '*/CachedExtensionVSIXs/texor-dev.texor-*' -print -exec rm -rf {} + 2>/dev/null || true
    find "$cache_root" -path '*/CachedProfilesData/*/extensions.user.cache' -print -exec rm -f {} + 2>/dev/null || true
  done

  local obsolete_file
  for obsolete_file in "$HOME/.vscode-server/extensions/.obsolete" "$HOME/.vscode/extensions/.obsolete"; do
    [[ -f "$obsolete_file" ]] || continue
    node - "$obsolete_file" <<'NODE'
const fs = require('fs');
const obsoletePath = process.argv[2];

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(obsoletePath, 'utf8'));
} catch {
  process.exit(0);
}

let changed = false;
for (const key of Object.keys(parsed)) {
  if (
    key.startsWith('texor.texor-') ||
    key.startsWith('texor.texor-vscode-') ||
    key.startsWith('texor-dev.texor-')
  ) {
    delete parsed[key];
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(obsoletePath, `${JSON.stringify(parsed)}\n`);
}
NODE
  done
}

prepare_dev_extension_bundle() {
  local dev_publisher="$1"
  local dev_version="$2"
  local dev_display_name="$3"

  rm -rf "$DEV_EXT_SRC"
  mkdir -p "$DEV_EXT_SRC"
  cp -R "$EXT_SRC"/. "$DEV_EXT_SRC"/

  node - "$DEV_EXT_SRC/package.json" "$dev_publisher" "$dev_version" "$dev_display_name" <<'NODE'
const fs = require('fs');
const [packagePath, devPublisher, devVersion, devDisplayName] = process.argv.slice(2);

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.publisher = devPublisher;
pkg.version = devVersion;
pkg.displayName = devDisplayName;
pkg.description = `${pkg.description} [Local development build]`;

fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
NODE
}

backup_existing_texor_extensions() {
  local ext_parent="$1"
  local timestamp="$2"
  local pattern

  mkdir -p "$BACKUP_DIR"
  for pattern in "$ext_parent"/texor.texor-* "$ext_parent"/texor.texor-vscode-* "$ext_parent"/texor-dev.texor-*; do
    [[ -e "$pattern" || -L "$pattern" ]] || continue

    local backup_path="$BACKUP_DIR/$(basename "$pattern").$timestamp"
    echo "Backing up existing TEXOR extension:"
    echo "  $pattern"
    mv "$pattern" "$backup_path"
  done
}

rewrite_extension_registry() {
  local registry_file="$1"
  local dev_id="$2"
  local target_ext_dir="$3"
  local target_ext_name="$4"
  local dev_version="$5"
  local dev_publisher="$6"

  mkdir -p "$(dirname "$registry_file")"

  node - "$registry_file" "$dev_id" "$target_ext_dir" "$target_ext_name" "$dev_version" "$dev_publisher" <<'NODE'
const fs = require('fs');
const path = require('path');

const [registryPath, devId, targetExtDir, targetExtName, devVersion, devPublisher] = process.argv.slice(2);

let entries = [];
try {
  entries = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(entries)) {
    entries = [];
  }
} catch {
  entries = [];
}

entries = entries.filter((entry) => {
  const id = entry?.identifier?.id;
  return id !== 'texor.texor' && id !== devId;
});

entries.push({
  identifier: { id: devId },
  version: devVersion,
  location: {
    $mid: 1,
    path: targetExtDir,
    scheme: 'file',
  },
  relativeLocation: targetExtName,
  metadata: {
    isMachineScoped: true,
    pinned: true,
    source: 'development',
    publisherDisplayName: devPublisher,
    installedTimestamp: Date.now(),
  },
});

fs.writeFileSync(registryPath, `${JSON.stringify(entries)}\n`);
NODE
}

EXT_NAME="$(node -p "require('$EXT_SRC/package.json').name")"
EXT_PUBLISHER="$(node -p "require('$EXT_SRC/package.json').publisher")"
EXT_VERSION="$(node -p "require('$EXT_SRC/package.json').version")"
EXT_DISPLAY_NAME="$(node -p "require('$EXT_SRC/package.json').displayName")"
DEV_PUBLISHER="${EXT_PUBLISHER}-dev"
DEV_VERSION="${EXT_VERSION}-dev"
DEV_DISPLAY_NAME="${EXT_DISPLAY_NAME} (Dev)"
DEV_EXTENSION_ID="${DEV_PUBLISHER}.${EXT_NAME}"
EXT_DIR_NAME="${DEV_EXTENSION_ID}-${DEV_VERSION}"

if [[ -d "$HOME/.vscode-server/extensions" ]]; then
  EXT_PARENT="$HOME/.vscode-server/extensions"
elif [[ -d "$HOME/.vscode/extensions" ]]; then
  EXT_PARENT="$HOME/.vscode/extensions"
else
  EXT_PARENT="$HOME/.vscode-server/extensions"
  mkdir -p "$EXT_PARENT"
fi

TARGET_EXT_DIR="$EXT_PARENT/$EXT_DIR_NAME"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT_DIR"

echo "Building TEXOR development extension assets from current repo..."
npm run build:extension-dev >/dev/null

prepare_dev_extension_bundle "$DEV_PUBLISHER" "$DEV_VERSION" "$DEV_DISPLAY_NAME"

backup_existing_texor_extensions "$EXT_PARENT" "$TIMESTAMP"

rm -rf "$TARGET_EXT_DIR"
ln -s "$DEV_EXT_SRC" "$TARGET_EXT_DIR"

rewrite_extension_registry "$EXT_PARENT/extensions.json" "$DEV_EXTENSION_ID" "$TARGET_EXT_DIR" "$EXT_DIR_NAME" "$DEV_VERSION" "$DEV_PUBLISHER"

clear_texor_vscode_caches

CODEX_CLI="$(detect_platform_codex || true)"
if [[ -z "$CODEX_CLI" ]]; then
  CODEX_CLI="$(command -v codex || true)"
fi

if [[ -f "$HOME/.vscode-server/data/Machine/settings.json" || -d "$HOME/.vscode-server/data/Machine" ]]; then
  configure_vscode_settings "$HOME/.vscode-server/data/Machine/settings.json" "${CODEX_CLI:-}"
fi

if [[ -f "$HOME/.config/Code/User/settings.json" || -d "$HOME/.config/Code/User" ]]; then
  configure_vscode_settings "$HOME/.config/Code/User/settings.json" "${CODEX_CLI:-}"
fi

if [[ -n "${CODEX_CLI:-}" ]]; then
  chmod +x "$CODEX_CLI" 2>/dev/null || true
  for dir in "$HOME"/.vscode-server/cli/servers/Stable-*/server/bin/remote-cli; do
    if [[ -d "$dir" ]]; then
      ln -sf "$CODEX_CLI" "$dir/codex"
    fi
  done
fi

cat <<MSG
TEXOR local development extension is now installed from the current repo:
  $TARGET_EXT_DIR -> $DEV_EXT_SRC

Repo root:
  $ROOT_DIR

Extension id:
  $DEV_EXTENSION_ID@$DEV_VERSION

Codex CLI:
  ${CODEX_CLI:-not found}

Next:
  1. If this workspace is in Restricted Mode, trust it first.
  2. Reload VSCode window: Ctrl+Shift+P -> Developer: Reload Window
  3. Open Command Palette and run: TEXOR: Open Browser Workbench

This development install is intentionally separate from the Marketplace plugin.
The Marketplace TEXOR entry is removed from the active extension registry so
Ctrl+Shift+P uses the current repo's local development build.
MSG
