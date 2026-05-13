# TEXOR Design Philosophy

TEXOR is a paper interaction layer for human-Codex collaboration.

It is not the paper-writing model, not the project-understanding agent, and not a fixed prompt workflow. Codex owns project understanding, manuscript writing, experiment execution, figure/table generation, user-intent interpretation, and revision. TEXOR exists to make that collaboration visible, controllable, repeatable, and easy for a researcher to use.

## Core Belief

Writing a paper with AI should feel like reviewing a compiled manuscript, not operating a prompt machine.

The user should spend most of their time looking at the paper PDF, selecting the part that feels wrong, and saying what they want changed. TEXOR should turn that small human judgment into a clear task for Codex, then show what changed after Codex updates the manuscript.

## Product Boundary

TEXOR owns:

- project and manuscript loading
- target journal/conference selection
- LaTeX version storage
- PDF compilation
- before/after PDF diff visualization
- PDF-based annotation and feedback capture
- routing user feedback to Codex
- showing Codex task status at a human-readable level
- preserving paper revision history

Codex owns:

- understanding the code project
- reading existing experiment results
- writing the initial draft when needed
- revising existing LaTeX manuscripts
- interpreting user feedback
- checking global consistency after local edits
- running project code when extra evidence is needed
- regenerating figures, tables, metrics, and visualizations

The implementation rule is simple:

If a feature requires semantic understanding, experiment judgment, or manuscript reasoning, it belongs to Codex. If a feature makes the human-Codex paper loop easier to start, inspect, route, store, or compare, it belongs to TEXOR.

## User Path

The ideal user path is:

1. User opens TEXOR from VSCode.
2. User loads a code project path.
3. User optionally imports an existing `.tex` manuscript.
4. User selects or types the target journal/conference.
5. Codex creates or revises the paper in the project context.
6. TEXOR compiles the paper and shows PDF versions side by side.
7. User selects text, a table, a figure, or a region in the PDF.
8. User writes one natural-language revision note.
9. Codex updates the LaTeX, checks the full manuscript for consistency, and runs code or regenerates figures if needed.
10. TEXOR saves the new version and refreshes the PDF diff.

This loop continues throughout the paper-writing process. TEXOR is not a one-shot generator.

## Project Path vs Paper Path

TEXOR must keep these concepts separate:

- **Project path**: required. This is the code/research workspace Codex uses to understand methods, inspect results, run experiments, control plotting code, and regenerate project artifacts.
- **Paper path**: optional. This is an existing `.tex` file used only as an import source. TEXOR copies it into `<project path>/.texor/manuscript/main.tex`; after that, Codex and TEXOR always use this project-local `main.tex` as the manuscript entrypoint.

The project library is organized around the project path because a TEXOR project is the whole research-writing context, not just one template or one isolated `.tex` file.

TEXOR must never infer the project path from the `.tex` path. A `.tex` path points to a manuscript file; it is not proof of where the experiment code, data scripts, figures, or project context live.

Likewise, TEXOR must not keep editing the user-provided source `.tex` in place. Import means copying that file into the project-local `main.tex`, then treating the copy as the canonical manuscript.

## Codex Session Model

One TEXOR project should correspond to one persistent Codex conversation.

TEXOR stores the Codex session id on the project record and resumes that same session for later manuscript revisions, PDF annotations, experiment requests, figure/table changes, and interrupted-task recovery. The small context attached to each browser request is only the operation coordinate for the current turn: project path, main `.tex` path, target journal, selected version, PDF selection source location, and nearby snippet.

That operation coordinate must not replace Codex's accumulated project understanding. The project understanding lives in the continuing Codex conversation.

## Version Model

Every Codex-completed interaction should create a paper version.

The current right-hand PDF version is the version being modified. TEXOR should not expose unnecessary "base version" language unless the user is explicitly doing version management. The interaction model should feel like:

- left side: previous or selected comparison version
- right side: current selected manuscript version
- feedback applies to the right side
- Codex produces the next version

This keeps the mental model close to paper review: "I am looking at this version; change this part."

## PDF-First Interaction

The PDF is the main workspace.

The user should not need to hunt through LaTeX unless they want to. TEXOR should let the user point at the compiled paper, then map the selection back to source context for Codex whenever possible.

For text, selection should feel like normal PDF text selection. For figures and tables, region selection is acceptable, but the goal is still source localization: TEXOR should provide Codex with enough source path, line, snippet, selected text, or region context to edit the right LaTeX area.

## Local Feedback, Global Revision

A user comment may be local, but Codex's responsibility is global.

When the user asks to change a sentence, table, figure, claim, metric, or term, Codex should also check:

- terminology consistency
- contribution statements
- abstract/introduction/conclusion alignment
- method descriptions
- experiment claims
- figure/table references
- symbols and notation
- related-work positioning
- possible need for new experiments or plots

This is one of TEXOR's most important design claims: the user only marks what bothers them, while Codex handles the surrounding research-writing consequences.

## UI Principles

The interface should be quiet and paper-centered.

The main view should be dominated by the previous/current compiled PDFs. Controls should exist only when they help the paper loop:

- project loading
- `.tex` import
- target journal selection
- Codex start/pause/continue/terminate
- version selection
- PDF annotation
- project deletion

Avoid turning the page into a dashboard of implementation details. Codex status should describe what is happening at a human level, not dump low-level logs unless debugging is explicitly needed.

## Codex Visibility

TEXOR should show enough Codex activity to build trust:

- waiting for Codex
- reading current paper state
- preparing manuscript path
- thinking
- inspecting or modifying project files
- running commands
- saving a new version
- failed, paused, or interrupted states

But the user should not see noisy implementation output such as raw command plumbing, temporary file paths, or stale error messages. If Codex fails, TEXOR should finish the task state clearly and make recovery possible.

## Interruption And Recovery

Long writing tasks must be controllable.

TEXOR should support:

- pause writing and save the partial manuscript
- continue from an interrupted Codex session when possible
- terminate writing and preserve the latest recoverable version
- return to the relevant conversation/task context

The product should not leave the user stuck in an indefinite "queued" or "running" state.

## Template And Journal Strategy

Templates are real journal/conference assets, not arbitrary built-in examples.

TEXOR should eventually maintain a searchable local template library crawled or collected from official sources. Before writing starts, TEXOR asks the target journal/conference and uses that to guide Codex and LaTeX compilation.

Hardcoding one development project or one template into the product is not allowed. Projects such as WPDN are only test fixtures for validating the experience.

## VSCode Direction

TEXOR should be distributed as a VSCode extension because VSCode is where the user's research project already lives and where Codex can operate on files, commands, experiments, and plots.

The browser workbench remains the paper-review surface. The VSCode extension should launch it, bridge browser tasks to Codex, and keep the local services running.

Long term, users should be able to install TEXOR from the VSCode Marketplace and start from one command, without manually cloning the TEXOR repository.

## Non-Goals

TEXOR should not become:

- a generic AI chat app
- a prompt-template library disguised as a product
- a standalone paper generator detached from the user's project
- a LaTeX IDE replacement
- a fake project analyzer with hardcoded examples
- a system that hides Codex's actions completely
- a system that forces users to manually copy/paste versions

## North Star

The best version of TEXOR lets a researcher work like this:

They read the compiled paper, mark the part that is wrong, explain the desired change in plain language, and let Codex repair the manuscript and supporting project artifacts. TEXOR then shows the new paper version against the old one, clearly and calmly.

That is the product.
