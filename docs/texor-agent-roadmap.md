# TEXOR Agent Roadmap

This document is the working plan for turning `texor-agent` into the default research-paper and scientific-writing agent inside TEXOR.

The goal is not to build a generic coding agent. The goal is to build a paper-grounded agent that can:

- understand a research codebase,
- derive manuscript claims from evidence,
- draft and revise LaTeX safely,
- run project-local experiment and plotting workflows when needed,
- keep manuscript history and project context stable across iterations.

## Product Direction

`texor-agent` should become the primary paper workflow runtime.

- `texor-agent` owns task routing, project understanding, evidence grounding, manuscript state, and paper-specific tools.
- `Codex CLI` and `Claude Code` remain optional backends for users who want external coding agents.
- User-supplied model APIs remain important, but model choice is not the product moat.
- The moat is the research-writing workflow and its safety constraints.

## Principles

1. Evidence before prose.
2. Manuscript safety before model freedom.
3. Small fast paths for local wording edits; deeper paths for experiment and structure work.
4. Project-specific memory beats repeated prompt bulk.
5. TEXOR should prefer explicit tools and inspectable state over hidden agent magic.

## Current Baseline

Already present:

- lightweight task routing (`quick`, `deep`, route classification),
- local manuscript entrypoint management,
- versioned paper save flow,
- explicit tools for reading, writing, running commands, image generation, and paper search,
- initial draft bootstrap from project scan,
- quick local polish path for PDF-selected text.

Current gaps:

- project scan is still too shallow for strong manuscript grounding,
- no first-class evidence dossier for recurring agent turns,
- no structured claim-to-evidence guardrails,
- experiment/figure workflows are still generic rather than paper-aware,
- manuscript state is mostly flat text instead of section/claim/result objects.

## Phases

### Phase 1: Evidence Dossier

Goal:
Turn lightweight project scan output into a reusable research dossier for drafting and revision.

Deliverables:

- richer `ProjectAnalysis` structure,
- entrypoint and experiment-file detection,
- dataset/metric/figure-script hints,
- runnable command hints from README/scripts,
- open questions and risk markers,
- compact `agentBrief` for repeated agent grounding,
- dossier consumed by initial draft generation and `texor-agent`.

Success criteria:

- initial drafts are less generic,
- agent requests can reference project evidence without re-scanning manually,
- missing evidence is surfaced as TODO/risk instead of fabricated prose.

### Phase 2: Manuscript State Model

Goal:
Move from “one LaTeX blob” toward a paper-aware working state.

Deliverables:

- section map,
- figure/table/reference inventory,
- tracked TODOs and unresolved evidence gaps,
- per-task change summaries tied to manuscript regions.

Success criteria:

- safer multi-step revisions,
- better consistency checks across sections,
- clearer resume/recovery after interruption.

### Phase 3: Experiment And Figure Execution

Goal:
Make `texor-agent` capable of paper-specific project actions, not just generic file editing.

Deliverables:

- experiment script discovery,
- safer experiment command routing,
- figure regeneration/update workflow,
- result-table extraction helpers,
- manuscript reference update flow for regenerated artifacts.

Success criteria:

- “run/refresh this experiment or plot and update the paper” becomes a first-class task,
- less manual copy-paste from project outputs into the manuscript.

### Phase 4: Claim-Evidence Guardrails

Goal:
Reduce hallucinated claims and improve manuscript trustworthiness.

Deliverables:

- explicit evidence tags or summaries for drafted claims,
- unsupported-claim detection,
- stronger refusal/TODO behavior for missing evidence,
- revision-time consistency checks for numbers, datasets, and citations.

Success criteria:

- unsupported claims are surfaced instead of silently written,
- paper revisions preserve factual grounding across sections.

### Phase 5: Citation And Related Work Workbench

Goal:
Upgrade references from raw paper search into a usable academic workflow.

Deliverables:

- better related-work prompts,
- citation candidate capture,
- conservative BibTeX placeholder generation,
- manuscript insertion guidance tied to sections and claims.

Success criteria:

- related work becomes structured assistance rather than ad hoc search output.

### Phase 6: Backend Specialization

Goal:
Keep `texor-agent` as the orchestration layer while allowing multiple reasoning engines.

Deliverables:

- stable backend abstraction,
- consistent session semantics across `texor-agent`, `Codex CLI`, and `Claude Code`,
- backend-aware diagnostics and recovery behavior,
- model/backbone selection rules by task type.

Success criteria:

- backend choice changes execution style, not product architecture.

## Execution Order

Implementation should follow this order:

1. Phase 1 `Evidence Dossier`
2. Phase 2 `Manuscript State Model`
3. Phase 3 `Experiment And Figure Execution`
4. Phase 4 `Claim-Evidence Guardrails`
5. Phase 5 `Citation And Related Work Workbench`
6. Phase 6 `Backend Specialization`

## Current Active Track

Completed recently:

- Phase 1 `Evidence Dossier`
  - scan output now captures entrypoints, experiment files, figure scripts, dataset/metric hints, command hints, and open evidence questions,
  - initial draft bootstrapping consumes the dossier for more project-aware first drafts,
  - `texor-agent` and browser-backed agent prompts now receive a compact dossier summary for repeated grounding.
- Phase 2 foundation
  - every saved paper version now derives a `manuscriptState` with section map, figure/table inventory, labels, citations, TODO/TBD markers, and unresolved evidence gaps,
  - version lineage now stores a compact `changeSummary` tied to touched manuscript regions,
  - agent prompts and the browser workbench now receive compact manuscript-state grounding in addition to the project dossier.
  - revision prompts now include a region-aware edit plan with primary manuscript region, related consistency regions, and nearby open evidence gaps.
  - review UI now surfaces per-version touched regions, open evidence gaps, and manuscript stats in both compare view overlays and the version-history drawer.
  - figure/table inventory now tracks linked manuscript asset paths, missing linked assets, and asset-aware open gaps,
  - historical versions are auto-normalized to the latest manuscript-state schema so older snapshots also expose linked asset context,
  - `texor-agent`, browser prompts, and revision plans now surface linked figure/table assets so result-figure and diagram tasks can prefer existing manuscript references instead of inventing new ones.
- Phase 3 early execution helpers
  - `texor-agent` now exposes an `inspect_result_table` tool for structured CSV/TSV/JSON/JSONL result inspection,
  - project dossier grounding now includes compact result-artifact previews in addition to command hints,
  - `run_command` now routes through safer grounding checks so deep execution must match stored command hints or inspected experiment/figure scripts instead of arbitrary shell usage,
  - command execution now reports whether any manuscript-linked asset paths were actually updated during the run,
  - lightweight project scan now previews JSON result tables more accurately for both draft generation and later agent turns.

We are actively implementing:

- Phase 3 `Experiment And Figure Execution`

Immediate next changes:

- tie completed project-local run outputs back into the exact manuscript-linked asset refs they regenerate,
- strengthen section-level consistency checks before saving deeper revisions,
- add result-table-to-manuscript insertion helpers so inspected numeric evidence can update LaTeX tables and nearby claims with less manual prompting.

## Non-Goals For This Pass

- replacing the whole runtime with LangGraph right now,
- rewriting TEXOR around a single third-party CLI,
- turning TEXOR into a general IDE agent,
- inventing automatic academic quality scoring before evidence grounding is solid.
