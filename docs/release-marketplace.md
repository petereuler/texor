# TEXOR Marketplace Release

Internal release checklist for publishing the VSCode extension.

## Versioning

- Update `vscode-extension/package.json`
- Update `vscode-extension/package-lock.json`
- Update `vscode-extension/CHANGELOG.md`

## Package

Run from the repo root:

```bash
cd /path/to/texor
npm run typecheck
npm run package:vscode
```

Expected output:

```bash
release/texor-x.y.z.vsix
```

## Publish

Run from `vscode-extension/`:

```bash
cd /path/to/texor/vscode-extension
VSCE_PAT=your_marketplace_pat \
NODE_OPTIONS=--require=../scripts/node18-file-polyfill.cjs \
npx --yes @vscode/vsce publish --packagePath ../release/texor-x.y.z.vsix
```

## Checks

```bash
node -v
cd /path/to/texor/vscode-extension
NODE_OPTIONS=--require=../scripts/node18-file-polyfill.cjs npx --yes @vscode/vsce --version
NODE_OPTIONS=--require=../scripts/node18-file-polyfill.cjs npx --yes @vscode/vsce ls-publishers
```
