# Change Log

## 0.3.4

- Polish the browser workbench around manuscript authoring: streamline the project hub, improve the Overleaf-like LaTeX/PDF split view, and reduce distracting always-on chrome.
- Improve PDF and LaTeX interaction fidelity with pane-local zoom, forward/reverse sync refinements, and more accurate Ctrl+click navigation between source and compiled output.
- Strengthen initial drafting, template retrieval, and agent workflow controls so TEXOR is more reliable both for creating a first draft from project code and for continuing iterative manuscript revision.

## 0.3.3

- Stream more raw Codex stdout/stderr text into the TEXOR observer so users can inspect the actual CLI interaction instead of only high-level summaries.
- Preserve trailing stderr text and fallback raw lines when structured event parsing does not cover a Codex output fragment.
- Keep the staged drafting, template verification, failure diagnosis, and failed-draft preservation improvements from the 0.3 series.

## 0.3.2

- Show richer Codex interaction details in the TEXOR observer instead of collapsing most execution into abstract status text.
- Preserve more command output for both successful and failed turns so users and developers can inspect what Codex actually said or ran.
- Keep the template-source verification, staged drafting, and failure-draft preservation work from the previous releases intact.

## 0.3.1

- Remove internal Marketplace publishing instructions from the user-facing VSCode extension README and move them into a repo-internal release note.
- Improve template UX by auto-downloading immediately after selection, softening manual-download wording, and exposing an official-page fallback button when automatic retrieval is not yet available.
- Differentiate user-model API authentication failures from Codex login failures, and add a template-source verification script plus structured source metadata for high-frequency venues.

## 0.3.0

- Reshape initial manuscript drafting into a staged pipeline: bootstrap project analysis, generate a baseline draft workspace, seed a compilable manuscript scaffold when needed, then let Codex or TEXOR Agent continue from that foundation.
- Preserve failure diagnostics, failed draft snapshots, and queue recovery behavior introduced in the previous series, so long-running first-draft tasks fail more gracefully when they still cannot finish in one pass.
- Keep automatic template downloading, platform-aware Codex discovery, and plugin-bundled Codex compatibility in the same release line.

## 0.2.9

- Add failure diagnosis summaries so users can see why a run failed instead of only seeing a generic failed state.
- Preserve intermediate manuscript drafts on failed runs under `.texor/manuscript/failed-drafts/` when TEXOR can recover partial LaTeX output.
- Reduce queue deadlocks by letting the browser archive stale failed/queued tasks before starting a new run, and by making bridge polling skip over blocked queued entries more gracefully.

## 0.2.8

- Fix Windows template extraction by invoking `Expand-Archive` through a safer PowerShell parameter block.
- Expand Codex binary discovery with broader platform folder aliases and a one-shot fallback that attempts to install the OpenAI/Codex VSCode extension before retrying discovery.
- Keep tightening cross-platform startup behavior for plugin-bundled Codex without requiring a separate CLI install.

## 0.2.7

- Improve Codex discovery so TEXOR can more reliably use the Codex binary bundled inside the OpenAI/Codex VSCode extension, even when no separate CLI install exists.
- Reject stale or cross-platform Codex paths more defensively, and align install/doctor/portable scripts with the same platform-aware lookup logic.
- Upgrade template fetching from a fixed-link downloader to a source-resolving template catalog with local caching and automatic first-use downloads for supported venues.

## 0.2.6

- Fix Codex executable discovery on Windows so TEXOR no longer picks Linux or macOS binaries from the OpenAI/Codex extension bundle.
- Keep preferring `codex.cmd` or `codex.exe` over the npm `codex.ps1` shim when Windows launchers are available.
- Refine the project-loading sidebar row so `Agent 后端` and `期刊` align more cleanly, and remove the extra backend helper captions.

## 0.2.5

- Fix Windows Codex CLI startup by preferring `codex.cmd` or `codex.exe` over the npm `codex.ps1` shim when available.
- Decode Windows CLI stderr with a `gb18030` fallback so PowerShell failures are readable in the TEXOR observer.
- Refine the project-loading sidebar layout and remove the extra "给 Agent" field for a cleaner launch flow.

## 0.1.0

- Open the local TEXOR browser workbench from VSCode.
- Bridge browser-submitted manuscript tasks to Codex CLI.
- Support importing an existing `.tex` manuscript into the TEXOR version workflow.
- Save Codex-completed revisions as paper versions for PDF comparison.
