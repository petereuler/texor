# TEXOR

TEXOR opens a local browser workbench from VSCode and uses TEXOR Agent, Codex CLI, or Claude Code as the actual paper-writing agent.

The workbench is designed for manuscript iteration:

- Load an existing research project or create a new TEXOR project.
- Import an existing `.tex` manuscript as the first paper version.
- Compile and compare previous/current PDF versions.
- Mark text or regions in the PDF, write a natural-language revision note, and let the chosen agent update the LaTeX.
- Keep agent progress visible while TEXOR stores each completed revision as a new version.

## Command

Run one command from the VSCode Command Palette:

```text
TEXOR: Open Browser Workbench
```

The extension starts the local TEXOR web and API services, then prompts you to open the workbench in your browser.

## Requirements

- TEXOR Agent can use any OpenAI-compatible API through `baseUrl + apiKey + model`.
- Codex CLI is optional and can still be used through `texor.codexExecutable` or the OpenAI ChatGPT/Codex VSCode extension.
- Claude Code is optional and can still be used through `texor.claudeExecutable`.
- A LaTeX engine such as `pdflatex` or `lualatex` is required for PDF compilation.

## Agent Backends

TEXOR supports three agent backends:

- `TEXOR Agent`: TEXOR runs its own lightweight state-graph loop, calls the user's OpenAI-compatible model API, and executes explicit tools such as reading project files, writing `main.tex`, listing files, and running non-destructive project commands.
- `Codex CLI`: TEXOR delegates the task to a local Codex CLI session.
- `Claude Code`: TEXOR delegates the task to a local Claude Code session.

The built-in TEXOR Agent is intentionally modeled after LangGraph-style state machines: model step, tool step, state update, checkpoint through the project command/session, then final save. It avoids bundling LangGraph in the extension for now so the VSIX stays small and easy to debug.

## Task Routing

TEXOR Agent now routes work by intent:

- Fast local wording polish for selected PDF text.
- Full-manuscript consistency revision when the request affects structure, claims, terminology, or multiple sections.
- Structure-diagram generation through the configured image model, saved into the project and referenced from `main.tex`.
- Result-figure updates by inspecting and running project-local plotting/code files.
- Reference and related-work support through online paper search metadata and abstracts.

## Project And Manuscript Loading

- `加载项目` opens an existing TEXOR project record, including its Agent conversation and paper version history.
- `新建项目` creates a new TEXOR project record for a code project path.
- `导入当前项目 .tex` imports an existing manuscript into the current project. TEXOR copies it to `<project>/.texor/manuscript/main.tex`; later revisions use that file as the manuscript entrypoint.

The code project path is required. The `.tex` path is optional and only seeds the current project manuscript.

## Templates

TEXOR ships only a small template catalog. Full journal/conference template archives are downloaded on first use into VSCode extension storage.
Supported direct downloads currently include IEEEtran, ACM acmart, Elsevier elsarticle, Elsevier CAS, and ICLR 2026.

## Settings

- `texor.serverUrl`: TEXOR backend URL. Defaults to `http://127.0.0.1:4174`.
- `texor.webUrl`: TEXOR browser workbench URL. Defaults to `http://127.0.0.1:4174`.
- `texor.appPath`: optional override for the bundled TEXOR application directory.
- `texor.targetJournal`: optional default target journal or conference.
- `texor.codexExecutable`: Codex CLI executable path.
- `texor.claudeExecutable`: Claude Code CLI executable path.
- `texor.claudeModel`: optional Claude model override.
- `texor.agentProvider`: provider label for TEXOR Agent.
- `texor.agentBaseUrl`: OpenAI-compatible base URL for TEXOR Agent.
- `texor.agentModel`: model name for TEXOR Agent.
- `texor.agentImageModel`: image model used for structure diagrams, for example `gpt-image-1`.
- `texor.agentApiKey`: API key for TEXOR Agent.
