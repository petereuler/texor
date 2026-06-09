# TEXOR Development Plugin Workflow

During development we only keep the local development plugin.

The Marketplace/VSIX plugin should stay uninstalled on the development machine so it does not open stale bundled resources.

## Build And Run Locally

Use this when you want the development workbench to run from the current local build:

```bash
npm run build:extension-dev
npm run start:dev-extension
```

Open `http://172.23.205.253:4174` remotely, or `http://127.0.0.1:4174` locally.

This is the most stable development path because it uses the exact built assets under `vscode-extension/web` and `vscode-extension/dist-server`.

## Command Palette Option

If you want the command to appear in the normal VSCode Command Palette, run:

```bash
npm run install:dev-extension
```

This now installs a separate local development extension:

```text
texor-dev.texor@<repo-version>-dev
display name: TEXOR Workbench (Dev)
```

It is generated from the current repository and replaces the Marketplace TEXOR
entry in the active remote extension registry, so `Ctrl+Shift+P` uses this
repo's development build instead of a stale Marketplace/VSIX copy.

For the normal repo-level dev workflow (`npm run start:texor`), the installer
also points `texor.serverUrl` and `texor.webUrl` at `http://127.0.0.1:4173`
so the command palette opens the live Vite frontend from the current repo.

The installer also clears TEXOR-related VS Code extension caches so stale VSIX
entries do not hide the current development command.

Then reload VSCode and use `Ctrl+Shift+P`:

```text
TEXOR: Open Browser Workbench
```

If the command still does not appear, make sure the current workspace is
trusted first. In Restricted Mode VS Code can hide extension commands.

For the full restart flow you can also use:

```bash
npm run restart:dev-workbench
```

## After UI Changes

For frontend/server changes, rebuild and restart:

```bash
npm run build:extension-dev
npm run start:dev-extension
```

For extension command changes, rebuild the extension bundle and reload VSCode.
You normally do not need to reinstall because the extension directory is
symlinked to this repo:

```bash
npm run build:vscode
```

## Remote Access

If you are using ZeroTier, open:

```text
http://172.23.205.253:4174
```

when the development plugin has started the workbench.
