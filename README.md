# texor

`texor` is a paper interaction tool for Codex workflows.

Codex understands the project, writes the paper, understands user feedback, and revises the LaTeX.
texor stores LaTeX versions, compiles PDFs, and shows before/after PDF diffs.

See [TEXOR Design Philosophy](docs/design-philosophy.md) for the product principles and boundary between TEXOR and Codex.
See [Codex Drafting Skills](docs/codex-drafting-skills.md) for the compact first-draft principles used by the Codex bridge.

## One Command Setup

```bash
npm run setup:codex
```

Then reload VSCode:

```text
Ctrl+Shift+P -> Developer: Reload Window
```

## Daily Use

1. Open your research project in VSCode.
2. Run `Texor: Open`.
3. Use the browser workbench to enter the project path, target journal, and what Codex CLI should do.
4. Click `交给 Codex`.
5. Codex CLI writes or revises `.texor/manuscript/main.tex` inside that project.
6. Click `收取版本` in the browser.
7. In the texor PDF view, use `批注` to send feedback from the paper back to Codex CLI.
8. After Codex revises the `.tex`, click `收取版本` again.

texor will show the previous PDF on the left and the current PDF on the right.
When Codex submits a new version, the web workbench refreshes automatically.

## URLs

- Browser: `http://127.0.0.1:4174`

## Useful Commands

```bash
npm run start:texor
npm run stop:texor
npm run doctor
npm run install:vscode-extension
```

## Live Codex Loop

- Browser actions are queued through `/api/bridge/commands`.
- The VSCode extension polls bridge commands and executes them with Codex CLI.
- Web feedback is stored through `/api/codex/feedback`.
- Codex CLI writes the main manuscript to `.texor/manuscript/main.tex`.
- Feedback and browser tasks can still be mirrored as Markdown under `.texor/codex-feedback/` for manual Codex sidebar use.
- When a revised `.tex` version is submitted, texor marks the active feedback as done.

## Boundary

texor does not understand the project and does not write the paper.
That is Codex's job.
