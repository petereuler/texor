# TEXOR Agent Runtime

TEXOR Agent is the built-in agent backend for TEXOR. It lets users bring their own OpenAI-compatible model API instead of relying on Codex CLI.

## Architecture

The runtime follows a lightweight LangGraph-style state machine:

1. `prepare`: load project path, manuscript path, selected PDF/source context, target journal, and current paper version.
2. `model`: call the configured model with the current state.
3. `tool`: execute one explicit tool requested by the model.
4. `state update`: append model/tool results to the task state.
5. `finalize`: save `<project>/.texor/manuscript/main.tex` as a TEXOR paper version.

The first implementation keeps this graph local to the VSCode extension so project reads, file writes, and command execution happen on the user's machine.

## Model Provider

TEXOR Agent uses an OpenAI-compatible `/chat/completions` endpoint:

- `baseUrl`
- `apiKey`
- `model`
- optional provider label

This supports OpenAI and providers that expose compatible APIs, such as DeepSeek or local gateways like LM Studio/Ollama adapters.

## Tool Contract

The model must return exactly one JSON object per step:

```json
{"process":"brief user-facing writing step","tool":"read_file","args":{"path":"relative/path"}}
```

or:

```json
{"process":"brief user-facing writing step","final":"short summary"}
```

Current tools:

- `list_files`: list files under a project-relative directory.
- `read_file`: read a project-relative file.
- `write_file`: write a project-relative file, especially `.texor/manuscript/main.tex`.
- `run_command`: run a non-destructive command inside the project root.
- `generate_image`: call an OpenAI-compatible image endpoint and save a structure diagram under the project.
- `search_papers`: query OpenAlex for related papers, metadata, DOI/URL, and available abstracts.

The runtime rejects paths outside the project and obvious destructive commands.

## Task Routing

TEXOR Agent classifies each browser request before entering the graph:

- `quick-polish`: selected text wording, grammar, concision, or local academic phrasing. It reads only the needed manuscript/source context and edits the localized span.
- `full-revision`: full-paper consistency, structure, logic, abstract/introduction/method/conclusion changes. It inspects the manuscript and checks related sections after editing.
- `structure-diagram`: architecture, workflow, pipeline, or schematic figures. It can generate an image asset with the configured image model or fall back to project-local figure code/TikZ.
- `result-figure`: plots, result figures, charts, and visualization updates. It inspects project code/data, modifies plotting scripts, runs them when feasible, and updates manuscript figure references.
- `references`: citations, related work, and bibliography. It searches paper metadata/abstracts online and summarizes only inspected sources.
- `general`: the default route, using the smallest adequate workflow.

The routing keeps simple paragraph edits fast while still allowing careful multi-step work for experiments, figures, and full-manuscript consistency.

## Execution Policy

Routing is only the first layer. TEXOR now derives an execution policy before choosing the runtime path.

Execution profiles:

- `quick-local-edit`: front-end, single-span manuscript editing for wording/polish tasks. It avoids project scanning, avoids long-lived session reuse, forbids project commands, and prefers the direct local replace path.
- `manuscript-edit`: lightweight manuscript revision without code execution. It can read the current manuscript and optional saved project context, but it stays in a foreground writing lane.
- `reference-research`: reference/citation work with paper search enabled, but still without project execution by default.
- `diagram-generation`: figure-oriented writing work that can generate diagram assets without turning every task into a long-running repo workflow.
- `project-execution`: long-running repository work for tasks like source understanding, initial drafting from code, rerunning experiments, updating result figures, or other requests that truly require grounded project commands.

Each execution policy controls more than prompt wording:

- whether the task runs in a foreground fast lane or a background long-running lane
- whether saved project context is skipped, read-only, or refreshed/seeded
- whether prior conversation memory is loaded
- whether Codex/Claude sessions are resumed or treated as isolated turns
- whether ephemeral Codex sessions are used for short tasks
- whether `run_command`, `generate_image`, or `search_papers` are even available
- which project paths are writable in that lane
- whether post-run changed files are audited against the lane policy
- timeout caps and multi-step budgets

Examples of structural enforcement already handled below the prompt layer:

- quick wording lanes cannot resume the project’s long-lived Codex session and use ephemeral CLI sessions when available
- source-understanding turns can refresh only the persistent project-context file, while manuscript saves are restored/blocked
- TEXOR Agent tool calls can write only to policy-approved paths such as `main.tex`, `.texor/agent/project-context.md`, approved figure outputs, or bibliography targets for reference work
- external CLI runs are audited after completion so lane-forbidden file writes fail even if the model ignored the prompt
- manuscript version saving rejects obviously broken outputs such as non-LaTeX fragments, severe truncation, or leaked internal control text

This mirrors how Codex-like agents distinguish short interactive edits from background agentic work: the separation lives in orchestration, session policy, tool permissions, and context loading, not only in the natural-language prompt.

The same direction now applies to revision APIs too: localized wording feedback is moving from whole-block regeneration toward structured patching, so narrow edits are resolved as bounded replacements before TEXOR falls back to broader block rewriting.

## Why Not Bundle LangGraph Yet

LangGraph is a good conceptual match: explicit state graph, tools, checkpoints, resumable threads.
For the VSCode extension MVP, TEXOR implements the same pattern directly to keep the package small, avoid dependency churn, and make debugging transparent.

Once the tool protocol stabilizes, TEXOR can add a LangGraph adapter without changing the browser UI or paper-version model.
