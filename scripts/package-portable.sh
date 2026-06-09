#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
PACKAGE_NAME="texor-portable-${VERSION}"
RELEASE_DIR="$ROOT_DIR/release"
PACKAGE_DIR="$RELEASE_DIR/$PACKAGE_NAME"
ARCHIVE_PATH="$RELEASE_DIR/${PACKAGE_NAME}.tar.gz"
ZIP_PATH="$RELEASE_DIR/${PACKAGE_NAME}.zip"

rm -rf "$PACKAGE_DIR" "$ARCHIVE_PATH" "$ZIP_PATH"
mkdir -p "$PACKAGE_DIR" "$RELEASE_DIR"

npm run build
npm run build:vscode

cp package.json package-lock.json "$PACKAGE_DIR/"
cp README.md pipeline.md "$PACKAGE_DIR/"
cp -R dist dist-server docs fixtures templates "$PACKAGE_DIR/"

mkdir -p "$PACKAGE_DIR/scripts" "$PACKAGE_DIR/vscode-extension"
cp -R vscode-extension/dist "$PACKAGE_DIR/vscode-extension/dist"
cp vscode-extension/package.json vscode-extension/README.md vscode-extension/CHANGELOG.md vscode-extension/LICENSE "$PACKAGE_DIR/vscode-extension/"

(
  cd "$PACKAGE_DIR"
  npm ci --omit=dev --ignore-scripts
)

rm -rf "$PACKAGE_DIR/node_modules/.cache" "$PACKAGE_DIR/node_modules/.vite"
rm -f "$PACKAGE_DIR/package-lock.json"

node - "$ROOT_DIR/package.json" "$PACKAGE_DIR/package.json" <<'NODE'
const fs = require('fs');
const [sourcePath, targetPath] = process.argv.slice(2);
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const pkg = {
  name: source.name,
  version: source.version,
  private: true,
  type: source.type,
  description: source.description,
  scripts: {
    start: 'NODE_ENV=production node dist-server/index.js',
    'start:texor': 'bash scripts/start-texor.sh',
    'stop:texor': 'bash scripts/stop-texor.sh',
    'start:texor:windows': 'powershell -ExecutionPolicy Bypass -File scripts/start-texor.ps1',
    'stop:texor:windows': 'powershell -ExecutionPolicy Bypass -File scripts/stop-texor.ps1',
    doctor: 'bash scripts/doctor.sh',
    'doctor:windows': 'powershell -ExecutionPolicy Bypass -File scripts/doctor.ps1',
  },
  dependencies: source.dependencies,
};
fs.writeFileSync(targetPath, `${JSON.stringify(pkg, null, 2)}\n`);
NODE

cat > "$PACKAGE_DIR/scripts/start-texor.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.texor-data/logs"
PID_DIR="$ROOT_DIR/.texor-data/pids"
PORT="${PORT:-4174}"

mkdir -p "$LOG_DIR" "$PID_DIR"
cd "$ROOT_DIR"

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
  fi
}

if [[ -f "$PID_DIR/server.pid" ]]; then
  old_pid="$(cat "$PID_DIR/server.pid" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
  fi
  rm -f "$PID_DIR/server.pid"
fi

stop_port "$PORT"

if command -v setsid >/dev/null 2>&1; then
  setsid env NODE_ENV=production PORT="$PORT" node dist-server/index.js >"$LOG_DIR/server.log" 2>&1 </dev/null &
else
  nohup env NODE_ENV=production PORT="$PORT" node dist-server/index.js >"$LOG_DIR/server.log" 2>&1 </dev/null &
fi
echo "$!" > "$PID_DIR/server.pid"

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "TEXOR did not start. Log:"
  tail -120 "$LOG_DIR/server.log" || true
  exit 1
fi

echo "TEXOR is running."
echo
echo "Browser:"
echo "  http://127.0.0.1:$PORT"
if command -v hostname >/dev/null 2>&1; then
  for ip in $(hostname -I 2>/dev/null || true); do
    echo "  http://$ip:$PORT"
  done
fi
echo
echo "Log:"
echo "  $LOG_DIR/server.log"
EOF

cat > "$PACKAGE_DIR/scripts/stop-texor.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.texor-data/pids"
PORT="${PORT:-4174}"

if [[ -f "$PID_DIR/server.pid" ]]; then
  pid="$(cat "$PID_DIR/server.pid" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_DIR/server.pid"
fi

pids="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
if [[ -n "$pids" ]]; then
  kill $pids 2>/dev/null || true
fi

echo "TEXOR stopped."
EOF

cat > "$PACKAGE_DIR/scripts/doctor.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4174}"

echo "TEXOR doctor"
echo

check_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    echo "ok   command: $name"
  else
    echo "miss command: $name"
  fi
}

detect_platform_codex() {
  local os_name
  local arch_name
  case "$(uname -s)" in
    Linux) os_name="linux" ;;
    Darwin) os_name="darwin" ;;
    *) os_name="" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch_name="x64" ;;
    arm64|aarch64) arch_name="arm64" ;;
    *) arch_name="" ;;
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

check_cmd node
check_cmd npm

if command -v pdflatex >/dev/null 2>&1 || command -v lualatex >/dev/null 2>&1; then
  echo "ok   LaTeX engine"
else
  echo "miss LaTeX engine: install TeX Live, MiKTeX, or MacTeX"
fi

if command -v codex >/dev/null 2>&1; then
  echo "ok   command: codex"
else
  codex_path="$(detect_platform_codex || true)"
  if [[ -n "$codex_path" ]]; then
    echo "ok   OpenAI extension Codex binary: $codex_path"
  else
    echo "miss Codex CLI: install OpenAI/Codex in VSCode or set texor.codexExecutable"
  fi
fi

if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "ok   backend health: http://127.0.0.1:$PORT"
else
  echo "miss backend health: run ./start.sh"
fi

if [[ -d "$HOME/.vscode-server/extensions/texor.texor-vscode-0.1.0" || -d "$HOME/.vscode/extensions/texor.texor-vscode-0.1.0" ]]; then
  echo "ok   VSCode extension installed"
else
  echo "miss VSCode extension: run ./install.sh"
fi

echo
echo "App path:"
echo "  $ROOT_DIR"
EOF

cat > "$PACKAGE_DIR/scripts/start-texor.ps1" <<'EOF'
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Port = if ($env:PORT) { [int]$env:PORT } else { 4174 }
$LogDir = Join-Path $RootDir ".texor-data\logs"
$PidDir = Join-Path $RootDir ".texor-data\pids"
$PidFile = Join-Path $PidDir "server.pid"
$StdoutLog = Join-Path $LogDir "server.out.log"
$StderrLog = Join-Path $LogDir "server.err.log"

New-Item -ItemType Directory -Force -Path $LogDir, $PidDir | Out-Null

function Stop-TexorProcess {
  param([int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  } catch {}
}

if (Test-Path $PidFile) {
  $oldPidText = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($oldPidText -match '^\d+$') {
    Stop-TexorProcess -ProcessId ([int]$oldPidText)
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

try {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-TexorProcess -ProcessId ([int]$_) }
} catch {}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js was not found. Install Node.js first, then run .\install.ps1 again."
}

$env:NODE_ENV = "production"
$env:PORT = "$Port"
$process = Start-Process -FilePath $node.Source `
  -ArgumentList @("dist-server/index.js") `
  -WorkingDirectory $RootDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru
Set-Content -Path $PidFile -Value $process.Id

$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $healthy = $true
    break
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

if (-not $healthy) {
  Write-Host "TEXOR did not start. Logs:"
  Write-Host "  $StdoutLog"
  Write-Host "  $StderrLog"
  if (Test-Path $StderrLog) { Get-Content $StderrLog -Tail 80 }
  exit 1
}

Write-Host "TEXOR is running."
Write-Host ""
Write-Host "Browser:"
Write-Host "  http://127.0.0.1:$Port"
try {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^169\.254\.' -and $_.IPAddress -ne '127.0.0.1' } |
    Select-Object -ExpandProperty IPAddress -Unique |
    ForEach-Object { Write-Host "  http://$($_):$Port" }
} catch {}
Write-Host ""
Write-Host "Logs:"
Write-Host "  $StdoutLog"
Write-Host "  $StderrLog"
EOF

cat > "$PACKAGE_DIR/scripts/stop-texor.ps1" <<'EOF'
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Port = if ($env:PORT) { [int]$env:PORT } else { 4174 }
$PidFile = Join-Path $RootDir ".texor-data\pids\server.pid"

function Stop-TexorProcess {
  param([int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  } catch {}
}

if (Test-Path $PidFile) {
  $pidText = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidText -match '^\d+$') {
    Stop-TexorProcess -ProcessId ([int]$pidText)
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

try {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-TexorProcess -ProcessId ([int]$_) }
} catch {}

Write-Host "TEXOR stopped."
EOF

cat > "$PACKAGE_DIR/scripts/doctor.ps1" <<'EOF'
$ErrorActionPreference = "Continue"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Port = if ($env:PORT) { [int]$env:PORT } else { 4174 }

Write-Host "TEXOR doctor"
Write-Host ""

function Check-Command {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    Write-Host "ok   command: $Name"
  } else {
    Write-Host "miss command: $Name"
  }
}

Check-Command "node"
Check-Command "npm"

if ((Get-Command pdflatex -ErrorAction SilentlyContinue) -or (Get-Command lualatex -ErrorAction SilentlyContinue)) {
  Write-Host "ok   LaTeX engine"
} else {
  Write-Host "miss LaTeX engine: install TeX Live, MiKTeX, or TinyTeX"
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($codex) {
  Write-Host "ok   command: codex"
} else {
  $roots = @(
    (Join-Path $HOME ".vscode\extensions"),
    (Join-Path $HOME ".vscode-server\extensions")
  )
  $found = $null
  foreach ($root in $roots) {
    if (Test-Path $root) {
      $found = Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'openai\.chatgpt' -and $_.Name -in @('codex.exe', 'codex.cmd', 'codex') } |
        Select-Object -First 1
      if ($found) { break }
    }
  }
  if ($found) {
    Write-Host "ok   OpenAI extension Codex binary: $($found.FullName)"
  } else {
    Write-Host "miss Codex CLI: install OpenAI/Codex in VSCode or set texor.codexExecutable"
  }
}

try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
  Write-Host "ok   backend health: http://127.0.0.1:$Port"
} catch {
  Write-Host "miss backend health: run .\start.ps1"
}

$extensionPaths = @(
  (Join-Path $HOME ".vscode\extensions\texor.texor-vscode-0.1.0"),
  (Join-Path $HOME ".vscode-server\extensions\texor.texor-vscode-0.1.0")
)
if ($extensionPaths | Where-Object { Test-Path $_ }) {
  Write-Host "ok   VSCode extension installed"
} else {
  Write-Host "miss VSCode extension: run .\install.ps1"
}

Write-Host ""
Write-Host "App path:"
Write-Host "  $RootDir"
EOF

cat > "$PACKAGE_DIR/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC="$ROOT_DIR/vscode-extension"
EXT_ID="texor.texor-vscode-0.1.0"
PORT="${PORT:-4174}"
SERVER_URL="http://127.0.0.1:$PORT"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm is required before installing TEXOR."
  echo "Install Node.js LTS, then rerun this script."
  exit 1
fi

if [[ -d "$HOME/.vscode-server/extensions" ]]; then
  EXT_PARENT="$HOME/.vscode-server/extensions"
elif [[ -d "$HOME/.vscode/extensions" ]]; then
  EXT_PARENT="$HOME/.vscode/extensions"
else
  EXT_PARENT="$HOME/.vscode-server/extensions"
fi

EXT_DIR="$EXT_PARENT/$EXT_ID"
mkdir -p "$EXT_PARENT"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp "$EXT_SRC/package.json" "$EXT_SRC/README.md" "$EXT_SRC/CHANGELOG.md" "$EXT_SRC/LICENSE" "$EXT_DIR/"
cp -R "$EXT_SRC/dist" "$EXT_DIR/dist"

CODEX_CLI="$(detect_platform_codex || true)"
if [[ -z "$CODEX_CLI" ]]; then
  CODEX_CLI="$(command -v codex || true)"
fi
if [[ -n "$CODEX_CLI" ]]; then
  chmod +x "$CODEX_CLI" 2>/dev/null || true
fi

SETTINGS_PATHS=()
SETTINGS_PATHS+=("$HOME/.vscode-server/data/Machine/settings.json")
SETTINGS_PATHS+=("$HOME/.config/Code/User/settings.json")
SETTINGS_PATHS+=("$HOME/Library/Application Support/Code/User/settings.json")

node - "$ROOT_DIR" "$SERVER_URL" "${CODEX_CLI:-}" "${SETTINGS_PATHS[@]}" <<'NODE'
const fs = require('fs');
const path = require('path');
const [appPath, serverUrl, codexPath, ...settingsPaths] = process.argv.slice(2);
for (const settingsPath of settingsPaths) {
  const dir = path.dirname(settingsPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if (fs.existsSync(settingsPath)) {
      const backup = `${settingsPath}.texor-backup-${Date.now()}`;
      try {
        fs.copyFileSync(settingsPath, backup);
      } catch {}
    }
  }
  settings['texor.appPath'] = appPath;
  settings['texor.serverUrl'] = serverUrl;
  settings['texor.webUrl'] = serverUrl;
  if (codexPath) {
    settings['texor.codexExecutable'] = codexPath;
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
NODE

"$ROOT_DIR/scripts/start-texor.sh"

cat <<MSG

TEXOR portable package is installed.

VSCode extension:
  $EXT_DIR

Browser:
  $SERVER_URL

Next:
  1. Reload VSCode: Ctrl+Shift+P -> Developer: Reload Window
  2. Run: TEXOR: Open Browser Workbench

Codex CLI:
  ${CODEX_CLI:-not found; install OpenAI/Codex in VSCode or set texor.codexExecutable}
MSG
EOF

cat > "$PACKAGE_DIR/install.ps1" <<'EOF'
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtSrc = Join-Path $RootDir "vscode-extension"
$ExtId = "texor.texor-vscode-0.1.0"
$Port = if ($env:PORT) { [int]$env:PORT } else { 4174 }
$ServerUrl = "http://127.0.0.1:$Port"

function Has-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Has-Command "node") -or -not (Has-Command "npm")) {
  throw "Node.js/npm is required before installing TEXOR. Install Node.js LTS from https://nodejs.org/, then rerun .\install.ps1."
}

$ExtParentCandidates = @(
  (Join-Path $HOME ".vscode\extensions"),
  (Join-Path $HOME ".vscode-server\extensions")
)
$ExtParent = $ExtParentCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ExtParent) {
  $ExtParent = Join-Path $HOME ".vscode\extensions"
}
$ExtDir = Join-Path $ExtParent $ExtId
New-Item -ItemType Directory -Force -Path $ExtParent | Out-Null
if (Test-Path $ExtDir) {
  Remove-Item -Recurse -Force $ExtDir
}
New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null

Copy-Item (Join-Path $ExtSrc "package.json") $ExtDir
Copy-Item (Join-Path $ExtSrc "README.md") $ExtDir
Copy-Item (Join-Path $ExtSrc "CHANGELOG.md") $ExtDir
Copy-Item (Join-Path $ExtSrc "LICENSE") $ExtDir
Copy-Item -Recurse (Join-Path $ExtSrc "dist") (Join-Path $ExtDir "dist")

$CodexCli = $null
$codexCommand = Get-Command codex -ErrorAction SilentlyContinue
if ($codexCommand) {
  $CodexCli = $codexCommand.Source
}
if (-not $CodexCli) {
  foreach ($root in $ExtParentCandidates) {
    if (Test-Path $root) {
      $found = Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'openai\.chatgpt' -and $_.Name -in @('codex.exe', 'codex.cmd', 'codex') } |
        Select-Object -First 1
      if ($found) {
        $CodexCli = $found.FullName
        break
      }
    }
  }
}

$settingsPaths = @()
if ($env:APPDATA) {
  $settingsPaths += (Join-Path $env:APPDATA "Code\User\settings.json")
  $settingsPaths += (Join-Path $env:APPDATA "Code - Insiders\User\settings.json")
}
$settingsPaths += (Join-Path $HOME ".vscode-server\data\Machine\settings.json")

$settingsScript = Join-Path $RootDir ".texor-data\configure-vscode-settings.cjs"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $settingsScript) | Out-Null
Set-Content -Path $settingsScript -Encoding UTF8 -Value @'
const fs = require('fs');
const path = require('path');
const [appPath, serverUrl, codexPath, ...settingsPaths] = process.argv.slice(2);
for (const settingsPath of settingsPaths) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if (fs.existsSync(settingsPath)) {
      try {
        fs.copyFileSync(settingsPath, `${settingsPath}.texor-backup-${Date.now()}`);
      } catch {}
    }
  }
  settings['texor.appPath'] = appPath;
  settings['texor.serverUrl'] = serverUrl;
  settings['texor.webUrl'] = serverUrl;
  if (codexPath) {
    settings['texor.codexExecutable'] = codexPath;
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
'@
& node $settingsScript $RootDir $ServerUrl "$CodexCli" @settingsPaths

& (Join-Path $RootDir "scripts\start-texor.ps1")

Write-Host ""
Write-Host "TEXOR portable package is installed."
Write-Host ""
Write-Host "VSCode extension:"
Write-Host "  $ExtDir"
Write-Host ""
Write-Host "Browser:"
Write-Host "  $ServerUrl"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Reload VSCode: Ctrl+Shift+P -> Developer: Reload Window"
Write-Host "  2. Run: TEXOR: Open Browser Workbench"
Write-Host ""
Write-Host "Codex CLI:"
if ($CodexCli) {
  Write-Host "  $CodexCli"
} else {
  Write-Host "  not found; install OpenAI/Codex in VSCode or set texor.codexExecutable"
}
EOF

cat > "$PACKAGE_DIR/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$ROOT_DIR/scripts/start-texor.sh"
EOF

cat > "$PACKAGE_DIR/start.ps1" <<'EOF'
$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $RootDir "scripts\start-texor.ps1")
EOF

cat > "$PACKAGE_DIR/stop.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$ROOT_DIR/scripts/stop-texor.sh"
EOF

cat > "$PACKAGE_DIR/stop.ps1" <<'EOF'
$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $RootDir "scripts\stop-texor.ps1")
EOF

cat > "$PACKAGE_DIR/doctor.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$ROOT_DIR/scripts/doctor.sh"
EOF

cat > "$PACKAGE_DIR/doctor.ps1" <<'EOF'
$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $RootDir "scripts\doctor.ps1")
EOF

cat > "$PACKAGE_DIR/README_FIRST.md" <<'EOF'
# TEXOR Portable

## Windows

先安装这些前置环境：

- Node.js LTS: https://nodejs.org/
- VSCode: https://code.visualstudio.com/
- LaTeX 引擎：MiKTeX、TeX Live 或 TinyTeX
- VSCode 中安装 OpenAI/Codex 扩展，并完成登录

然后在 PowerShell 中进入解压后的目录，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

之后常用命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
powershell -ExecutionPolicy Bypass -File .\stop.ps1
powershell -ExecutionPolicy Bypass -File .\doctor.ps1
```

## Linux / macOS

先安装这些前置环境：

- Node.js LTS 和 npm
- VSCode
- LaTeX 引擎：TeX Live、MacTeX、BasicTeX 或 TinyTeX
- VSCode 中安装 OpenAI/Codex 扩展，并完成登录

然后在终端进入解压后的目录，执行：

```bash
bash install.sh
```

安装脚本会完成这些事：

1. 检查 Node.js/npm 是否可用。
2. 把 TEXOR VSCode 插件复制到 VSCode 扩展目录。
3. 把 `texor.appPath`、`texor.serverUrl`、`texor.webUrl` 写入 VSCode settings。
4. 启动本地 TEXOR 网页。

启动后浏览器地址：

```text
http://127.0.0.1:4174
```

VSCode 中执行：

```text
Ctrl+Shift+P -> TEXOR: Open Browser Workbench
```

依赖要求：

- Node.js 和 npm
- LaTeX 引擎：`pdflatex` 或 `lualatex`
- Codex CLI：来自 OpenAI/Codex VSCode 插件，或系统 PATH 中的 `codex`

常用命令：

```bash
bash start.sh
bash stop.sh
bash doctor.sh
```
EOF

chmod +x "$PACKAGE_DIR/install.sh" "$PACKAGE_DIR/start.sh" "$PACKAGE_DIR/stop.sh" "$PACKAGE_DIR/doctor.sh" "$PACKAGE_DIR/scripts/"*.sh

tar -czf "$ARCHIVE_PATH" -C "$RELEASE_DIR" "$PACKAGE_NAME"
(
  cd "$RELEASE_DIR"
  zip -qr "$ZIP_PATH" "$PACKAGE_NAME"
)

echo
echo "Portable package created:"
du -sh "$PACKAGE_DIR" "$ARCHIVE_PATH" "$ZIP_PATH"
echo
echo "Folder:"
echo "  $PACKAGE_DIR"
echo "Archive:"
echo "  $ARCHIVE_PATH"
echo "  $ZIP_PATH"
