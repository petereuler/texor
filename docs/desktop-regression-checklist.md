# Desktop Regression Checklist

Use this checklist for every desktop release candidate after packaging artifacts are built.

## Package Preflight

1. Run `npm run package:desktop:mac`.
2. If this is a release candidate, run `npm run sign:desktop:mac`.
3. Run `npm run package:desktop:dmg:mac`.
4. If release credentials are available, run `npm run notarize:desktop:mac`.
5. Run `npm run smoke:desktop:package`.
6. Record the `zip` and `dmg` SHA256 hashes from the smoke-test output with the release note or handoff ticket.

## Launch Trust

1. Open the packaged `arm64` app from `release-desktop/mac/TEXOR-darwin-arm64/TEXOR.app`.
2. Confirm a visible window appears within a normal launch delay and there is no blank or white screen.
3. Confirm the launchpad or workspace loads instead of a silent failure.
4. If startup fails intentionally or unexpectedly, confirm the diagnostics window appears and shows the desktop log path.

## Paper-First Workspace

1. Open a representative paper workspace.
2. Confirm the manuscript or PDF remains the primary surface and the left compare/tools pane starts collapsed on desktop.
3. Confirm the top-bar overflow menu opens and its secondary actions still work.
4. Confirm the history drawer opens, dismisses with outside click or `Esc`, and does not feel like a separate competing workspace.

## Codex-Native Workflow

1. Run an ask-only native Codex turn.
2. Confirm the answer appears as a clean assistant reply without duplicated stdout noise.
3. Refresh or reopen the same window and confirm the native conversation history stays attached to that window session.
4. Run a small edit turn and confirm progress is visible, the manuscript updates, and a new version entry appears.

## Paper Revision Loop

1. Select text directly in the PDF and trigger a revision flow.
2. Confirm the manuscript recompiles and the PDF reopens near the changed region.
3. Confirm changed-region focus prefers precise matched text highlighting when the selected text still exists.
4. Restore an older manuscript version from the history drawer and confirm the restore creates a new latest version instead of deleting later history.

## Multi-Window Isolation

1. Open the same project in a second window.
2. Confirm each window keeps its own native Codex turn history and active command state.
3. Open a different project in another window and confirm versions, chat history, and workspace context do not bleed across windows.

## Diagnostics And Recovery

1. Export the desktop diagnostics bundle from the UI.
2. Confirm the downloaded archive contains `desktop-diagnostics.json`, `README.md`, and the captured log files.
3. Confirm the log path shown in the launchpad matches the runtime environment for the packaged app.

## Release Notes

1. Attach the smoke-test output, artifact hashes, and any launch screenshots needed for signoff.
2. Note whether signing and notarization were run or intentionally skipped for this candidate, and link the notarization log or `notarytool` output when available.
3. If the only warnings are the known Vite chunk-size warning and the `pdfjs-dist/build/pdf.js` eval warning, record them explicitly instead of treating them as new regressions.
