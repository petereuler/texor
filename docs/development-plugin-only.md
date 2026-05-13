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

Then reload VSCode and use `Command+Shift+P`:

## After UI Changes

For frontend/server changes, rebuild and restart:

```bash
npm run build:extension-dev
npm run start:dev-extension
```

For extension command changes, reinstall:

```bash
npm run install:dev-extension
```

## Remote Access

If you are using ZeroTier, open:

```text
http://172.23.205.253:4174
```

when the development plugin has started the workbench.
