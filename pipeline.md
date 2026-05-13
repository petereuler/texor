# texor Interaction Pipeline

`texor` is a paper interaction surface for humans and Codex.

For the product philosophy behind this pipeline, see [TEXOR Design Philosophy](docs/design-philosophy.md).
For the compact initial-draft guidance used by the Codex bridge, see [Codex Drafting Skills](docs/codex-drafting-skills.md).

It is not the project-understanding agent.
It is not the paper-writing agent.
It is not the user-intent-understanding agent.
It is not the revision agent.

Codex owns those jobs continuously.
texor only makes the interaction, review, feedback routing, versioning, LaTeX compilation, and PDF diff workflow easier.

## Core user path

1. User opens the research project in VSCode.
2. User runs `Texor: Open`.
3. The browser becomes the main interaction surface.
4. User chooses or types the target journal/conference and writes a task for Codex.
5. texor queues the browser task for the VSCode extension.
6. The VSCode extension runs Codex CLI for the task.
7. Codex CLI writes or revises `.texor/manuscript/main.tex` inside the project.
8. User clicks `收取版本` in the browser.
9. The VSCode extension submits that manuscript version to texor.
10. texor stores the version, compiles it, and shows the PDF.
11. User marks an unsatisfying region in texor and writes feedback.
12. texor queues that feedback for Codex CLI, and the loop continues.

## Product focus

The core features are:

- Codex-to-texor paper handoff
- inline feedback collection
- live feedback queue from texor to VSCode
- browser-to-VSCode command queue
- manuscript versioning
- clear before/after diff visualization
- target journal/template lookup

Everything else is secondary.

## Current implementation

- `server/lib/codexHandoff.ts` accepts Codex-authored LaTeX versions
- `server/lib/feedbackStore.ts` stores feedback for Codex as a queue
- `/api/codex/feedback` is the live feedback bridge
- `server/lib/projectScanner.ts` remains legacy/demo-only and should not define the product direction
- `server/lib/paperBuilder.ts` remains legacy/demo-only and should not define the product direction
- `server/lib/revisionEngine.ts` remains legacy/demo-only and should not define the product direction
- `src/components/QuickIssueBar.tsx` supports compact inline feedback
- `src/App.tsx` keeps the interface centered on PDF comparison plus compact feedback
- `vscode-extension/` starts texor, runs Codex CLI tasks, submits Codex-authored versions, and stores visible CLI logs

## What should not be hardcoded into the product

- a specific research project
- a specific paper template
- a fixed prompt workflow exposed as the product itself

Projects like `WPDN` are only development examples for testing the experience.

## Near-term goal

Make it feel natural for a user to:

- start from a project,
- get an AI draft,
- mark up what they dislike,
- and inspect what changed after each revision.

## VSCode/Codex direction

The product should be a VSCode extension plus the existing texor review surface.

VSCode is the better place for:

- reading the active workspace
- letting Codex CLI inspect files and results
- letting Codex CLI write and revise the paper
- letting Codex CLI interpret the user's feedback

texor remains the better place for:

- target journal/template selection
- paper version storage
- LaTeX/PDF compilation
- before/after PDF diff review
- passing user feedback back to Codex

The bridge extension should run Codex CLI tasks and send Codex-authored LaTeX versions and user feedback to the texor backend.

## Implementation rule

Never turn texor back into the AI writer.
Any feature that sounds like project understanding, prompt planning, paper generation, or semantic revision belongs to Codex.
texor should only make those Codex actions easier to start, route, review, and compare.
