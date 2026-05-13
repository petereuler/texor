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
{"thought":"brief status","tool":"read_file","args":{"path":"relative/path"}}
```

or:

```json
{"thought":"brief status","final":"short summary"}
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

## Why Not Bundle LangGraph Yet

LangGraph is a good conceptual match: explicit state graph, tools, checkpoints, resumable threads.
For the VSCode extension MVP, TEXOR implements the same pattern directly to keep the package small, avoid dependency churn, and make debugging transparent.

Once the tool protocol stabilizes, TEXOR can add a LangGraph adapter without changing the browser UI or paper-version model.
