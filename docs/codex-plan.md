# Codex Plan

This document is the persisted Codex plan requested in chat.

It is the working plan for making TEXOR desktop usable, observable, and eventually competitive with tools like Cursor, while still staying paper-first instead of code-first.

When this plan changes, update this file instead of rewriting the plan only in conversation.

## North Star

TEXOR should feel like a real research-writing IDE:

- the paper is the primary surface,
- Codex is a first-class runtime, not a bolted-on prompt box,
- code, experiments, figures, and terminal work stay available but subordinate to the paper workflow,
- desktop behavior must be stable enough that startup, recovery, and packaging are boring.

## Product Position

TEXOR is not “Cursor with a PDF preview”.

TEXOR should be:

- paper-first,
- PDF-centered,
- manuscript-versioned,
- region-aware,
- experiment-capable,
- multi-project and multi-window safe,
- compatible with Codex-native interaction instead of forcing TEXOR-specific hardcoded flows for every task.

## Current Reality

Desktop V1 exists, but it is still below the expected quality bar.

Recent failures that must not recur:

- app launches with no visible UI,
- white-screen startup caused by incorrect static asset paths,
- front-end loads but cannot reach the embedded API,
- packaged app accidentally includes development-state junk and oversized runtime baggage,
- errors fail silently instead of surfacing actionable diagnostics.

Additional startup trap now explicitly covered:

- local built desktop runs must not be mistaken for Vite dev-server mode just because the app is not packaged yet.

These are not polish issues. They are trust issues.

## Core Requirements

### 1. Startup Reliability

Desktop startup must be deterministic.

Requirements:

- packaged renderer assets must always resolve correctly under `file://`,
- packaged renderer must always know the embedded server base URL,
- Electron main process must fail loudly and log to disk,
- app startup must validate critical packaged paths before opening the main window,
- user-facing failure state must replace silent blank screens.

Exit criteria:

- no white-screen or no-op startup failures without an error surface,
- launch succeeds repeatedly on clean macOS installs,
- startup logs are discoverable from the UI or a clearly documented path.

### 2. Desktop Observability

TEXOR desktop must be debuggable like a real product.

Requirements:

- persistent logs for Electron main, preload, renderer, and embedded server,
- visible startup diagnostics page when boot fails,
- explicit status for renderer asset load, embedded server boot, and workspace restore,
- copyable diagnostic bundle for bug reports.

Exit criteria:

- every launch failure becomes classifiable within minutes,
- user can report failures without using terminal-only workflows.

### 3. Runtime Architecture

Desktop mode must be structural, not prompt-based.

Requirements:

- one authoritative desktop bootstrap contract,
- one authoritative server URL injection path,
- one authoritative packaged resource root,
- browser mode and desktop mode should differ by runtime wiring, not by scattered conditionals,
- no hidden dependence on dev-server assumptions.

Exit criteria:

- the same front-end can run in browser and desktop with explicit environment wiring,
- no desktop-only hacks that require guessing resource locations.

### 4. Codex-Native Mode

Codex-native mode must feel like a real Codex workspace with TEXOR’s paper affordances layered on top.

Requirements:

- native question-answering must work even without making edits,
- Codex process visibility must show meaningful progress and summaries,
- PDF selection and compile hooks must work without forcing TEXOR-specific rewrite logic,
- Codex-native turns must support fast vs long-running lanes structurally,
- session continuity must be preserved per project window.

Exit criteria:

- user can ask, revise, inspect, and continue naturally,
- Codex-native mode does not feel like a broken fallback.

### 5. Paper-Centered UX

The desktop shell must reinforce the product philosophy.

Requirements:

- main window defaults to the paper view,
- code tree, editor, and terminal stay available but secondary,
- post-revision PDF should reopen at the changed region,
- PDF selection must behave like true text selection,
- top bar and chat layout should remain minimal and coherent.

Exit criteria:

- the user spends most of the session looking at the paper, not fighting the shell.

### 6. Multi-Window And Project Isolation

Parallel research work must be safe.

Requirements:

- each window has its own project context,
- each window has its own Codex session binding,
- restoring a version or undoing a change must not leak prior branch state into later edits,
- multiple papers can run concurrently without cross-contaminating versions or session memory.

Exit criteria:

- opening a second paper feels native, not experimental.

### 7. Packaging And Distribution

Desktop distribution must be reproducible and low-risk.

Requirements:

- minimal runtime packaging,
- deterministic macOS `.dmg` production,
- architecture-specific artifacts for `arm64` and `x64`,
- clear checksum output,
- later: signing and notarization path for macOS release builds.

Exit criteria:

- every package can be traced to a known build process,
- package size stays reasonable,
- distribution failures are diagnosable.

## Execution Phases

### Phase A: Stop The Bleeding

Priority:

- fix blank startup,
- fix white screen,
- fix embedded API routing,
- shrink packaged runtime,
- add disk logs for launch failure.

Success means the app reliably opens and renders.

### Phase B: Make Failure Legible

Priority:

- startup diagnostics screen,
- renderer/server health checks,
- visible logs entrypoint,
- copyable bug-report bundle.

Success means failures are visible and actionable.

Current progress:

- desktop startup now performs a self-check for preload, renderer entry, embedded server entry, and packaged renderer asset paths before opening the main window,
- desktop startup now verifies the embedded server health endpoint before continuing,
- renderer readiness is now treated as an explicit startup handshake instead of assuming `index.html` load means success,
- startup failures now open a visible diagnostics window and write to a persistent desktop main-process log,
- desktop UI now exposes the diagnostics log path so failures are reportable without terminal spelunking,
- preload, renderer, and embedded server now write into separate persistent desktop log channels,
- desktop mode can now export a copyable diagnostics bundle for bug reports instead of relying on manual log gathering.

### Phase C: Codex-Native Parity

Priority:

- native chat usable for ask-only turns,
- meaningful process trace and summaries,
- stable session continuity,
- structural fast-lane vs long-lane behavior.

Success means native Codex mode feels intentional instead of fragile.

Current progress:

- native Codex already preserves ask-only turns structurally by returning answers without auto-saving manuscript versions,
- native Codex session reuse is now scoped by project window instead of only by project root, so parallel windows for the same repo do not silently collapse into the same conversation thread,
- the browser-side native conversation timeline now filters Codex-native turns by the active window session key, which keeps per-window chat history coherent after refresh or parallel work,
- active command status and observer state now follow the current window-scoped native thread instead of being polluted by sibling windows for the same project,
- native Codex process logs now surface explicit answer-vs-edit mode and quick-vs-deep strategy hints, so the user can tell what lane the runtime actually chose.
- native Codex answer extraction is now unified across bridge result paths, so ask-only turns prefer a clean assistant answer instead of whichever raw output fragment happened to win a fallback branch,
- native assistant reply text is no longer duplicated as generic stdout log noise, which keeps the conversation bubble and technical detail panes from competing with each other for the same final answer.

### Phase D: Paper-First Polish

Priority:

- PDF selection quality,
- changed-region jump after compile,
- compact writing-page chrome,
- stronger undo/version branching correctness,
- smoother multi-window entry from the home surface.

Success means the product starts to feel like a coherent writing IDE.

Current progress:

- restoring an older manuscript version now creates a new current version instead of destructively truncating later history, which makes rollback behavior match the UI promise and preserves a safer Cursor-like revision trail.
- version-change PDF jumps now preserve per-version page hints through the forward-search path, so post-edit and post-restore focus is more likely to reopen near the actual changed region instead of drifting to another matching location.
- PDF jumps now prefer highlighting the matched changed text itself when `selectedText` is available, instead of always falling back to a coarse region box, which makes post-edit focus feel more intentional and easier to visually parse.
- the writing workspace can now collapse its left comparison/tools pane and defaults to a current-paper-first layout on desktop, which makes the manuscript the primary surface while still keeping Previous, LaTeX, and Files one click away.
- the history drawer now drives the main compare state instead of acting like a disconnected second workspace, and restoring a historical version closes the drawer so focus returns to the current manuscript view.
- the history drawer now behaves like a true auxiliary overlay with backdrop and `Esc` / outside-click dismissal, which reduces the feeling of a second competing workspace layered over the paper view.
- secondary workspace actions now live behind a compact overflow menu in the top bar, which trims always-visible chrome and keeps the writing stage closer to a paper-first primary surface.
- the home-surface manuscript cards now treat multi-window work as a first-class desktop action instead of a hidden affordance: each card exposes an explicit “open in new window” action, supports modifier-key or middle-click new-window opening, and surfaces failures instead of silently swallowing them.
- per-window session identity is now surfaced in the desktop launchpad and workspace toolbar, so multi-window Codex isolation is not just implemented under the hood but also visible and easy to sanity-check while running parallel paper sessions.
- the active workspace can now branch the current manuscript into a new desktop window directly from the top-bar overflow, so multi-window writing no longer requires returning to the home surface before splitting work.
- the observer header and version-history drawer now also show the current window session marker, which reduces context mixups when comparing chat progress or revision history across parallel desktop windows.
- the browser fallback for “open in new window” now forces a fresh `windowSessionKey` instead of inheriting the current URL state, so multi-window Codex isolation stays correct even outside the Electron shell.
- continuation metadata now reuses prior Codex commands only within the active project and, for native Codex, within the active window session, which closes another cross-window leakage path in parallel desktop workflows.
- workspace refresh cadence, version-sync reactions, and fallback runtime-config inference now all read from the same window-scoped native command slice, which prevents sibling windows for the same project from spuriously accelerating polling, hijacking version focus, or backfilling the wrong Codex runtime state.
- manuscript version appends are now non-destructive even when a window continues from an older base version: later versions stay in history, the new revision keeps its explicit `basedOnVersionId`, and the default compare view now opens against that true base instead of pretending the history is a single linear chain.
- when another window advances the same paper, the current window now keeps its active version in view, silently refreshes the underlying history/runtime metadata, and surfaces a lightweight “follow latest version” banner instead of forcibly jumping the PDF and compare state to the sibling window’s new current revision.
- the history drawer now distinguishes the version currently in view from the latest current revision, marks sibling-window updates inline, and surfaces each revision’s true `basedOnVersionId` lineage, so parallel-window branch state is readable instead of being flattened into an ambiguous “Current” label.
- the history drawer now adds lightweight intent filters for `All`, `Checkpoints`, `Edits`, and `Drafts`, so users can collapse noise and focus on high-signal revision types without losing the current preview or branch context they are already inspecting.
- the history drawer now treats those intent buckets more like a real revision browser by showing per-filter counts, allowing groups to collapse, and force-expanding whichever group currently contains the active preview, working view, latest revision, or sibling-window update so high-signal state does not disappear behind organizational chrome.
- compare headers and version context cards now surface compact lineage breadcrumbs plus pairwise branch-relationship labels derived from each version’s `basedOnVersionId` chain, so a user can tell at a glance whether the right-hand manuscript directly continues the left, descends from it later, or split from a shared checkpoint.
- those lineage and branch cues are now navigable instead of static: context-card breadcrumbs, observer submission-base chips, and saved-version notices can all jump straight into the history drawer on the referenced revision, which makes the revision graph feel closer to a working browser than a passive annotation layer.
- the compare surface now also adds a lightweight revision-path banner (`left -> ancestor -> right`) across the two-pane workspace, and history-drawer jumps temporarily highlight the whole lineage path that led to the selected revision so branch navigation reads as a connected route instead of a single isolated destination.
- that revision-path layer now reuses the same interaction language across surfaces: the compare banner’s path segments are clickable, and observer turns now surface branch-relationship chips (for example direct continuation vs branch split) alongside the submission base, so the chat timeline and compare view describe revision structure in the same vocabulary.
- observer save feedback now also emits a compact `base -> result` revision note, and history-drawer lineage highlights now mark semantic roles such as origin, split point, and focus target, so following a revision path reads more like tracing a branch route than just spotting highlighted cards.
- those semantic branch cues now also start turning into actions: observer revision notes reuse the same `continues to` / `split at` wording as the compare banner, and a highlighted `Split point` in history can now immediately pivot the compare view to “split vs current focus” without manual version picking.
- ancestor and base references now also act as compare shortcuts instead of pure navigation: the compare banner can jump straight into “ancestor vs current focus”, and observer save notes can open a base-vs-result comparison directly, which keeps revision inspection one click away from the branch narrative itself.
- observer branch-relationship chips now prefer launching a compare from the referenced base into the current focus instead of only opening history, and highlighted history roles now carry compact explanations (origin, split point, focus, lineage) so the revision path reads like an explained route rather than a set of colored badges.
- those route explanations now also start distinguishing actions by intent: history-path roles such as origin and split point expose compare-to-focus shortcuts, while observer save feedback labels its compare button explicitly as “base vs saved” to separate saved-result inspection from the relation chip’s “base vs current focus” branch check.
- the revision-browser language is now more compare-aware instead of speaking in isolation: highlighted history-path hints mention the active left/right compare pair when relevant, so a user can tell whether the focused node is already the compare target or an alternate branch waypoint before clicking.
- observer revision affordances now also separate branch inspection from save-result inspection visually: relation chips read as lightweight “base vs current focus” checks, while saved-result compare actions render as dedicated compare pills and history jumps stay secondary links, which makes the two revision intents feel less interchangeable.
- the history drawer now follows that same working-view contract in its default compare behavior: clicking a historical revision compares it against the revision currently in the right-hand focus when one is active, instead of silently snapping back to the latest manuscript, so branch inspection stays anchored to the revision line the user is already exploring.
- branch relationship copy is now symmetric instead of assuming the right-hand focus must always be newer: compare cards, observer chips, and revision-path helpers can now distinguish “direct base”, “ancestor of”, and “descends from” cases, so looking backward to an older checkpoint no longer gets mislabeled as a branch split.
- version context cards are now starting to behave like lightweight revision inspectors instead of static summaries: branch-relationship chips inside Previous/Current/history preview cards can launch the relevant compare directly, and the cards expose compact actions such as comparing the version to the current focus or reopening the split point against that focus.
- those card-level revision actions now also respect compare direction explicitly instead of inferring it from whichever card is visible: Previous/Current/history preview cards pass a concrete `reference -> focus` pair into their compare actions, so tapping a Current-context relation chip still checks the left revision against the right-hand working view instead of accidentally flipping the panes.
- observer save feedback now also reuses that same explicit revision-path presentation instead of dropping back to plain prose: saved-result notices render the `base -> ... -> saved` path as clickable version segments, so observer history, context cards, and the compare banner all navigate revisions through the same visual language.
- observer submission metadata now also closes the loop on the “before” side of that path language: user turns render the submission base and current focus as a clickable `Submission path`, so the branch line is visible not only after a save but already at the moment a task was launched.
- that observer submission path is now anchored to the versions that were actually in focus at submit time instead of re-deriving from the current compare UI later, so older chat turns keep their original branch context even after the user pivots the working view to another revision line.
- observer relation chips now read from that same submission-time focus snapshot instead of borrowing the live right-hand pane, so each historical turn keeps one coherent branch context: the `Submission path` and its branch-check chip now describe the same `reference -> focus` pair even after the user has navigated elsewhere.
- observer user turns now consume one shared submit-time compare context instead of deriving the base chip, relation chip, and path separately, which keeps their branch wording, clickable targets, and compare actions aligned with the exact same `base -> focus` pair.
- that observer context is now more action-oriented like a lightweight revision inspector: user turns expose explicit `Submit base` / `Submit focus` chips plus direct compare actions such as “compare submit pair” and “compare at split”, so branch inspection can start from the chat timeline without reconstructing revision intent by hand.
- the active compare workspace now also consumes one shared left/right compare context for its path banner, relation copy, and banner actions, which keeps the main paper view speaking the same revision language as the observer-side inspector instead of recomputing branch semantics in parallel.
- the history drawer’s highlighted lineage nodes now also consume structured route context instead of only role hints: origin / split / lineage items can show their own `route -> focus`, branch relation label, and direct compare action, so branch browsing starts to feel like inspecting a connected revision route rather than reading annotations on isolated cards.
- history drawer cards now also separate preview from revision actions more explicitly: a card can be opened as the preview target while still exposing dedicated `compare to focus` / `compare at split` actions, which makes ordinary history browsing feel closer to Cursor’s branch inspector instead of forcing every click through one overloaded card button.
- compare vocabulary is now starting to converge across surfaces instead of drifting per component: observer submit actions, compare-banner shortcuts, history-lineage actions, and context-card compare pills now reuse the same compare/split wording, so the user sees one revision-inspection language no matter where a branch shortcut is launched from.
- revision-inspector explanations are now converging too, not just the button labels: observer chips, compare-banner headings, save-result compare titles, and history-route labels now read from shared path/relation/title helpers, which reduces the UI’s habit of describing the same branch concept as “revision path”, “route to focus”, or “check relation” depending on which surface you clicked.
- save-result feedback is now also moving away from a plain notice string toward a lightweight revision inspector: completed edit turns expose the saved/base relation chip, explicit revision path, and compare/split actions in the same structural language as observer submission metadata and history cards, so the “after save” branch story reads like part of the same inspector rather than a separate toast.
- observer turns are now starting to read more like a two-stage revision event instead of separate ad hoc fragments: the submission-side branch context and the saved-result branch context both flow through the same stage renderer, so a single turn can tell a more coherent before/after revision story closer to Cursor’s branch inspector model.
- those observer turns are now also less redundant internally: top-level submission chips no longer duplicate the same version links already present inside the submission stage, which makes a turn read more like one cohesive revision-event card instead of a bubble plus a second mini-inspector stacked underneath it.
- the observer stage container is now also named and styled more like a neutral revision stage instead of a “saved notice”, which makes the submission-side branch context and saved-result branch context feel like two peers in the same event card rather than one real inspector plus one recycled toast style.
- the outer observer turn is now also starting to move from “two opposing chat bubbles” toward one revision-event shell: the user-side submission context and assistant-side result context sit inside a shared event container, which reduces the feeling that TEXOR is merely chatting about revisions and nudges the timeline closer to a branch-event inspector.
- that event shell now also owns the high-level source/time/status metadata instead of repeating it inside each bubble, so the observer timeline reads less like alternating messages and more like a sequence of revision events with shared headers and staged internals.
- the assistant side of that event shell is now also beginning to read like a structured result section instead of one long bubble body: answer/status, process-or-detail traces, and revision-result/rollback actions are split into clearer subsections, which makes the event body feel closer to a real inspector pane than a chat reply with extra widgets appended below it.
- the submission side of that same event shell is now also partitioned more like an inspector card than a user chat bubble: the prompt itself sits inside a dedicated `Submission` pane and any selected-text quote is broken into a separate `Evidence` pane, so the “before” state reads like a captured revision context rather than an informal message plus attachment.
- observer event sections now also expose explicit pane headings across both sides (`Submission`, `Evidence`, `Result`, `Process` / `Technical log`, `Revision actions`), which further shifts the timeline from chat phrasing toward a staged revision-event inspector closer to Cursor’s branch/revision workflow.
- the observer event body now also uses shared before/after panes instead of asymmetric “user bubble” and “assistant bubble” wrappers: submission/evidence and result/process/actions both live inside the same pane grammar, with only lightweight tonal differences for pre- vs post-save state, so the timeline structure itself starts reading like a revision record rather than a conversation transcript.
- each observer event now also surfaces a compact event-level `Revision flow` strip above the staged panes, summarizing the submit-time branch path and saved-result branch path in one scannable place, so users can skim command history more like Cursor’s revision timeline without opening every individual inspector section.
- those observer event stages now also declare their role more explicitly instead of relying on generic “submission/result” wording: turns classify the left pane as `Before revision` (understand / draft / discuss / edit) and the right pane as `After revision` (saved / pending / discussion / failed / no save), so a user can tell whether a command actually landed a manuscript revision before reading the full pane body.
- saved outcomes in that event summary now also expose the identity of the produced revision instead of only the fact that a save happened: completed turns lift the saved version’s type and summary (for example Edit / Draft / Checkpoint plus its label and summary) into the event-level strip, so scanning the timeline starts to feel more like browsing concrete revision mutations than reading generic status badges.
- that event-level strip now also starts prioritizing the mutation itself instead of only adjacent metadata: when a run saves a new manuscript version, the summary leads with a direct `base -> saved revision` row that can open the compare, so observer history reads more like a sequence of concrete revision mutations than a pair of nearby path descriptors.
- saved observer events now also surface a compact changed-region summary alongside that mutation row by lifting the saved version’s `touchedRegions` into the event strip, so the timeline starts to answer not just “which revision was produced” but also “which manuscript areas this mutation touched” without opening the full history drawer.
- those changed-region summaries now also act like real revision-browser entry points instead of static tags: clicking a region chip opens the saved version in the history preview and auto-focuses the matching manuscript block, so observer history can pivot straight from “this mutation touched Related Work” to the corresponding saved-paper context.
- the saved-revision stage itself now also carries that same impact-first navigation instead of leaving region access only in the outer summary strip: a completed turn’s inline saved-stage inspector exposes `Changed regions` chips that jump into the saved version preview, so both the event shell and the stage body behave like revision-browser entry points around impact, not just version identity.
- those saved-stage impact chips now also begin flowing directly into compare inspection instead of stopping at static preview: when the saved stage already knows both base and saved versions, choosing a changed region opens the base-vs-saved compare and carries that region name forward as the right-pane jump query, so impact-first navigation leads straight into diff inspection around the affected manuscript area.
- compare jumps launched from those observer changed-region chips now also preserve their entry reason after navigation: the compare banner records that the view was opened from observer impact inspection, names the changed region that triggered the jump, and keeps one-click access back to the saved revision preview focused on that same manuscript area, so users do not lose the mutation context once they land in diff view.
- that observer-origin compare context now also survives the paper-first single-column workflow instead of living only in the two-pane banner: the Current pane header and Current-context inspector carry the same “opened from observer” region cue and jump back into the saved revision focus, so collapsing auxiliary chrome does not hide why the active diff is centered on a particular manuscript area.
- observer-driven region focus now also carries its intent into the history drawer instead of degrading into a bare scroll target: when the user opens a saved revision preview around a changed region, the drawer preview explains that the focus came from observer impact inspection and offers a direct path back into compare on that same region, so previewing the saved paper still feels like one continuous revision-inspector flow.
- that history-drawer observer focus now also preserves the original compare reference instead of rebuilding a generic preview-to-current compare: whether the user arrived from a saved-stage region chip, a compare-surface observer cue, or the `Revision flow` changed-region summary, the active history card, the drawer’s preview summary card, and the preview pane remember which revision pair launched the inspection and route “back to compare” through that same reference, so `base -> saved` impact review stays on one coherent branch relation even after detouring through preview mode.
- that preserved history-preview reference is now also explicit in the action layer instead of being hidden behind generic region chips: the drawer’s preview summary card, the active timeline card, and the preview pane expose a dedicated compare action for the remembered revision pair while leaving the region chip focused on refinding the manuscript area itself, so region focus and revision-pair inspection read as two distinct but connected intents.
- the main compare surface now carries the same branch-aware context inline: Previous/Current pane headers and context cards expose whether the viewed revision is the latest or a historical branch, and show the real `basedOnVersionId` parent so users do not need to open history just to understand which revision line they are editing against.
- the action layer now follows that same branch-aware contract: sidebar edits and PDF-grounded revisions submit against the version currently in the right-hand working view instead of silently snapping back to the latest current revision, and the composer explicitly shows the active submission base so multi-window branch edits are visible before the task is sent.
- resume/continue flows now follow that same right-pane working-view contract instead of reviving an older command with stale version bindings: continuing a task inherits the revision line currently in focus, which keeps retrying or extending a branch consistent with what the user is actually looking at.
- observer timeline bubbles now surface the revision base for each task alongside source context, so command history itself is branch-aware and a user can see whether a run was submitted from the latest manuscript state or from a historical branch without reconstructing that context from memory.
- completed edit turns now close that loop by explicitly reporting which new manuscript version was saved and which prior version it was based on, so the revision line stays visible not just at submission time but also in the final result feedback.
- restore and undo actions now explain their non-destructive consequences inline: both the observer rollback action and the history-drawer restore action explicitly state that TEXOR will create a new current version while preserving later history, which makes the version model feel safer and more Cursor-like during exploratory branching.
- restore/undo-generated versions now get clearer checkpoint-style summaries (for example “Checkpoint from vN” or “Rewind to vN from vM”) instead of generic restore phrasing, which makes the revision trail easier to scan like a real editing timeline rather than a raw event log.
- history and context surfaces now also classify versions by lightweight type tags such as Edit, Checkpoint, Rewind, and Draft, which helps the revision trail read more like a deliberate checkpoint timeline and less like an undifferentiated stack of saves.
- the history drawer now groups versions by intent-first buckets such as Checkpoints & Rewinds, Draft Origins, and Edits, so scanning the revision trail feels closer to browsing meaningful checkpoints than scrolling a purely chronological save log.

### Phase E: Release Discipline

Priority:

- signing/notarization path,
- reproducible release scripts,
- packaged smoke tests,
- desktop regression checklist.

Success means desktop releases are sustainable.

Current progress:

- desktop packaging now has a dedicated smoke-test script that validates `mac-stage` and packaged `.app` runtime entrypoints, checks that renderer asset references stay relative under `file://`, and verifies staged-vs-packaged parity for the key runtime files that previously caused blank-screen style regressions.
- packaged smoke output now emits per-artifact size and SHA256 for desktop `zip` and `dmg` builds, which makes release handoff more traceable even before signing and notarization are wired in.
- desktop release discipline now includes a concrete regression checklist covering launch trust, Codex-native ask/edit turns, PDF-grounded revision jumps, version-restore safety, diagnostics bundle export, and multi-window isolation before a candidate build is handed off.
- macOS desktop release now has a concrete signing and notarization path: hardened-runtime entitlements, a signing script for the packaged `.app`, a notarization/stapling script for signed `zip` and `dmg` artifacts, and a release runbook that spells out the required Apple credentials and command order.

## Immediate Active Checklist

These are the items that should be treated as active until closed:

- eliminate desktop startup blank/white screen regressions,
- add startup self-check before main window render,
- add persistent desktop logs and a visible diagnostics path,
- verify packaged app loads renderer assets through relative paths,
- verify renderer API requests use injected embedded-server URL,
- preserve Codex-native paper workflow without breaking plain Q&A turns,
- run the packaged smoke test and desktop regression checklist before release handoff,
- keep package contents limited to runtime necessities.

## Quality Bar

TEXOR does not need to copy Cursor’s product surface.

But it does need to match or exceed Cursor on:

- startup trust,
- session continuity,
- failure clarity,
- packaging discipline,
- interaction smoothness.

And it must beat Cursor on:

- paper-centered workflow,
- PDF-grounded revision,
- manuscript versioning,
- source-to-paper roundtrip,
- code-and-paper co-iteration.

## Update Rule

If a new desktop or Codex-native problem is discovered, add it here under:

- `Current Reality` if it is a recurring product truth,
- `Immediate Active Checklist` if it is currently blocking,
- `Execution Phases` if it changes priority or sequencing.

This file is the canonical saved Codex plan for TEXOR desktop and Codex-native product quality.
