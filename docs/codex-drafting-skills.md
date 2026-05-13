# Codex Drafting Skills

This note records the drafting principles TEXOR should pass to Codex for initial manuscript creation.

TEXOR should not become a prompt library or paper-writing agent. These skills are short operating principles for Codex when the user asks for an initial draft from a research project.

## Sources Surveyed

- `Imbad0202/academic-research-skills`: broad research pipeline skills covering planning, literature review, paper writing, review, revision, and quality checks.
- `lishix520/academic-paper-skills`: strategist/composer style separation with quality checkpoints for academic manuscripts.
- `OpenDraft`: open-source academic drafting direction with specialized research/drafting/export components and human review emphasis.
- `PaperOrchestra`: multi-agent academic paper writing architecture, useful as inspiration for role separation and quality checks.

These are inspiration sources, not hard dependencies. TEXOR should avoid copying large prompt bodies into browser tasks.

## Initial Draft Principles

When Codex starts a manuscript from zero, it should:

1. Inspect the project workspace before writing claims.
2. Identify the central contribution, method, evidence, and expected target venue.
3. Create a section plan before drafting full prose.
4. Derive figures, tables, metrics, datasets, and baselines from project files or executed code.
5. Avoid invented citations, baselines, results, datasets, or experiments.
6. Prefer comments or TODOs for missing evidence instead of fabricating content.
7. Keep the manuscript entrypoint fixed at `<project path>/.texor/manuscript/main.tex`.
8. Keep LaTeX complete and compilable.
9. Never mention TEXOR, browser routing, extension plumbing, or `.texor` as paper content.
10. Treat user feedback from PDF selection as local by default, then check global consistency.

## Prompt Budget Rule

Browser tasks should carry only compact hints:

- project workspace
- main manuscript path
- target journal
- current version
- selected PDF/source location
- user request verbatim
- a short drafting checklist only for first drafts

The project understanding must live in the continuing Codex session, not in repeated large prompts.
