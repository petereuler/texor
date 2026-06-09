import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentBackend, PaperRecord, PaperVersion, StoreState, WorkspaceSnapshot, WorkspaceSummary } from '../types.js';
import { dataPath } from './appPaths.js';
import { CURRENT_MANUSCRIPT_STATE_SCHEMA_VERSION, enrichPaperVersion } from './manuscriptState.js';

const dataDir = dataPath();
const indexFile = dataPath('workspace-index.json');

interface WorkspaceIndexState {
  projectRoots: string[];
}

async function ensureGlobalIndex(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(indexFile);
  } catch {
    await fs.writeFile(indexFile, JSON.stringify({ projectRoots: [] } satisfies WorkspaceIndexState, null, 2));
  }
}

async function loadIndex(): Promise<WorkspaceIndexState> {
  await ensureGlobalIndex();
  const raw = await fs.readFile(indexFile, 'utf8').catch(() => '{"projectRoots":[]}');
  try {
    const parsed = JSON.parse(raw) as WorkspaceIndexState;
    return { projectRoots: Array.isArray(parsed.projectRoots) ? parsed.projectRoots : [] };
  } catch {
    return { projectRoots: [] };
  }
}

async function saveIndex(state: WorkspaceIndexState): Promise<void> {
  await ensureGlobalIndex();
  const roots = [...new Set(state.projectRoots.map((entry) => path.resolve(entry)))].sort();
  await fs.writeFile(indexFile, JSON.stringify({ projectRoots: roots } satisfies WorkspaceIndexState, null, 2));
}

function workspaceProjectRoot(paper: PaperRecord): string | undefined {
  return paper.projectRoot || paper.analysis?.rootPath;
}

function resolvedExecutionTarget(paper: PaperRecord): PaperRecord['executionTarget'] | undefined {
  if (!paper.executionTarget) {
    return undefined;
  }
  if (paper.executionTarget.kind === 'local') {
    return {
      kind: 'local',
      rootPath: path.resolve(paper.executionTarget.rootPath),
    };
  }
  return {
    ...paper.executionTarget,
    remoteRoot: paper.executionTarget.remoteRoot,
    mirrorRoot: paper.executionTarget.mirrorRoot ? path.resolve(paper.executionTarget.mirrorRoot) : paper.executionTarget.mirrorRoot,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function storeFileForProject(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.texor', 'state.json');
}

async function ensureProjectStore(projectRoot: string): Promise<void> {
  const storeFile = storeFileForProject(projectRoot);
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  try {
    await fs.access(storeFile);
  } catch {
    const initialState: StoreState = { papers: {}, versions: {} };
    await fs.writeFile(storeFile, JSON.stringify(initialState, null, 2));
  }
}

async function loadProjectState(projectRoot: string): Promise<StoreState> {
  await ensureProjectStore(projectRoot);
  const raw = await fs.readFile(storeFileForProject(projectRoot), 'utf8');
  try {
    return reconcilePortableState(projectRoot, JSON.parse(raw) as StoreState);
  } catch {
    const backup = path.join(path.resolve(projectRoot), '.texor', `state.corrupt-${Date.now()}.json`);
    await fs.writeFile(backup, raw).catch(() => undefined);
    const initialState: StoreState = { papers: {}, versions: {} };
    await saveProjectState(projectRoot, initialState);
    return initialState;
  }
}

async function saveProjectState(projectRoot: string, state: StoreState): Promise<void> {
  await ensureProjectStore(projectRoot);
  await fs.writeFile(storeFileForProject(projectRoot), JSON.stringify(state, null, 2));
}

function currentVersionForState(state: StoreState, paperId: string, versions: PaperVersion[]): PaperVersion | undefined {
  if (!versions.length) {
    return undefined;
  }
  const currentVersionId = state.currentVersionIds?.[paperId];
  return versions.find((version) => version.id === currentVersionId) || versions[versions.length - 1];
}

function versionIndexById(versions: PaperVersion[], versionId?: string): number {
  if (!versionId) {
    return -1;
  }
  return versions.findIndex((version) => version.id === versionId);
}

function rebaseStoredPath(entry: string | undefined, fromRoot: string | undefined, toRoot: string): string | undefined {
  if (!entry) {
    return undefined;
  }
  const resolvedToRoot = path.resolve(toRoot);
  if (!path.isAbsolute(entry)) {
    return path.resolve(resolvedToRoot, entry);
  }
  const resolvedEntry = path.resolve(entry);
  if (!fromRoot) {
    return resolvedEntry;
  }
  const resolvedFromRoot = path.resolve(fromRoot);
  if (resolvedEntry === resolvedFromRoot) {
    return resolvedToRoot;
  }
  if (resolvedEntry.startsWith(`${resolvedFromRoot}${path.sep}`)) {
    return path.join(resolvedToRoot, path.relative(resolvedFromRoot, resolvedEntry));
  }
  return resolvedEntry;
}

function uniqueResolvedPathList(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((entry): entry is string => Boolean(entry)).map((entry) => path.resolve(entry)))];
}

function reconcilePortableState(projectRoot: string, state: StoreState): StoreState {
  const resolvedProjectRoot = path.resolve(projectRoot);
  let changed = false;
  const nextPapers: StoreState['papers'] = {};
  const nextVersions: StoreState['versions'] = {};

  for (const [paperId, paper] of Object.entries(state.papers)) {
    const recordedRoot = workspaceProjectRoot(paper);
    const nextPaper: PaperRecord = {
      ...paper,
      projectRoot: resolvedProjectRoot,
      executionTarget: resolvedExecutionTarget({
        ...paper,
        projectRoot: resolvedProjectRoot,
      }),
      assetRoots: uniqueResolvedPathList([
        ...(paper.assetRoots || []).map((entry) => rebaseStoredPath(entry, recordedRoot, resolvedProjectRoot)),
        path.join(resolvedProjectRoot, '.texor', 'manuscript'),
        resolvedProjectRoot,
      ]),
      analysis: paper.analysis
        ? {
            ...paper.analysis,
            rootPath: resolvedProjectRoot,
            importantFiles: paper.analysis.importantFiles.map((file) => ({
              ...file,
              path: rebaseStoredPath(file.path, recordedRoot, resolvedProjectRoot) || file.path,
            })),
            resultArtifacts: paper.analysis.resultArtifacts.map((artifact) => ({
              ...artifact,
              path: rebaseStoredPath(artifact.path, recordedRoot, resolvedProjectRoot) || artifact.path,
            })),
            dossier: {
              ...paper.analysis.dossier,
              entryPoints: paper.analysis.dossier.entryPoints.map((entry) => rebaseStoredPath(entry, recordedRoot, resolvedProjectRoot) || entry),
              experimentFiles: paper.analysis.dossier.experimentFiles.map((entry) => rebaseStoredPath(entry, recordedRoot, resolvedProjectRoot) || entry),
              figureScripts: paper.analysis.dossier.figureScripts.map((entry) => rebaseStoredPath(entry, recordedRoot, resolvedProjectRoot) || entry),
            },
          }
        : paper.analysis,
    };
    nextPapers[paperId] = nextPaper;
    if (JSON.stringify(nextPaper) !== JSON.stringify(paper)) {
      changed = true;
    }

    const versions = state.versions[paperId] || [];
    const nextPaperVersions = versions.map((version) => {
      const nextVersion: PaperVersion = {
        ...version,
        sourcePath:
          rebaseStoredPath(version.sourcePath, recordedRoot, resolvedProjectRoot) ||
          path.join(resolvedProjectRoot, '.texor', 'manuscript', 'main.tex'),
        manuscriptState: version.manuscriptState
          ? {
              ...version.manuscriptState,
              figures: version.manuscriptState.figures.map((figure) => ({
                ...figure,
                assetPath: rebaseStoredPath(figure.assetPath, recordedRoot, resolvedProjectRoot),
                assetPaths: figure.assetPaths?.map((entry) => rebaseStoredPath(entry, recordedRoot, resolvedProjectRoot) || entry),
                missingAssetPaths: figure.missingAssetPaths?.map((entry) => rebaseStoredPath(entry, recordedRoot, resolvedProjectRoot) || entry),
              })),
              tables: version.manuscriptState.tables.map((table) => ({
                ...table,
                assetPath: rebaseStoredPath(table.assetPath, recordedRoot, resolvedProjectRoot),
                assetPaths: table.assetPaths?.map((entry) => rebaseStoredPath(entry, recordedRoot, resolvedProjectRoot) || entry),
                missingAssetPaths: table.missingAssetPaths?.map((entry) => rebaseStoredPath(entry, recordedRoot, resolvedProjectRoot) || entry),
              })),
            }
          : version.manuscriptState,
      };
      if (JSON.stringify(nextVersion) !== JSON.stringify(version)) {
        changed = true;
      }
      return nextVersion;
    });
    nextVersions[paperId] = nextPaperVersions;
  }

  for (const [paperId, versions] of Object.entries(state.versions)) {
    if (!(paperId in nextVersions)) {
      nextVersions[paperId] = versions;
    }
  }

  if (!changed) {
    return state;
  }

  return {
    papers: nextPapers,
    versions: nextVersions,
    currentVersionIds: state.currentVersionIds,
  };
}

function versionStateReady(version: PaperVersion): boolean {
  return Boolean(
    version.manuscriptState?.schemaVersion === CURRENT_MANUSCRIPT_STATE_SCHEMA_VERSION &&
      version.manuscriptState?.sectionMap &&
      version.changeSummary?.summary,
  );
}

function normalizeVersions(
  versions: PaperVersion[],
  options?: { projectRoot?: string; assetRoots?: string[] },
): { versions: PaperVersion[]; changed: boolean } {
  const enriched: PaperVersion[] = [];
  let changed = false;

  for (const version of versions) {
    const explicitBase = version.basedOnVersionId ? enriched.find((entry) => entry.id === version.basedOnVersionId) : undefined;
    const baseVersion = explicitBase || enriched[enriched.length - 1];
    const normalized = versionStateReady(version)
      ? version
      : enrichPaperVersion(version, baseVersion, {
          projectRoot: options?.projectRoot,
          assetRoots: options?.assetRoots,
          sourcePath: version.sourcePath,
        });
    if (normalized !== version) {
      changed = true;
    }
    enriched.push(normalized);
  }

  return { versions: enriched, changed };
}

async function normalizeStateVersions(projectRoot: string, state: StoreState): Promise<StoreState> {
  let changed = false;
  const nextVersions: StoreState['versions'] = {};

  for (const [paperId, versions] of Object.entries(state.versions)) {
    const paper = state.papers[paperId];
    const normalized = normalizeVersions(Array.isArray(versions) ? versions : [], {
      projectRoot: workspaceProjectRoot(paper),
      assetRoots: paper?.assetRoots,
    });
    nextVersions[paperId] = normalized.versions;
    if (normalized.changed) {
      changed = true;
    }
  }

  if (!changed) {
    return state;
  }

  const nextState: StoreState = {
    ...state,
    versions: nextVersions,
  };
  await saveProjectState(projectRoot, nextState);
  return nextState;
}

async function registerProjectRoot(projectRoot?: string): Promise<void> {
  if (!projectRoot) {
    return;
  }
  const index = await loadIndex();
  index.projectRoots.push(path.resolve(projectRoot));
  await saveIndex(index);
}

async function unregisterProjectRoot(projectRoot?: string): Promise<void> {
  if (!projectRoot) {
    return;
  }
  const resolved = path.resolve(projectRoot);
  const index = await loadIndex();
  await saveIndex({ projectRoots: index.projectRoots.filter((entry) => path.resolve(entry) !== resolved) });
}

function sameProjectRoot(left?: string, right?: string): boolean {
  return Boolean(left && right && path.resolve(left) === path.resolve(right));
}

function inferredSessionBackend(sessionId?: string): AgentBackend | undefined {
  if (!sessionId) {
    return undefined;
  }
  if (sessionId.startsWith('texor-agent:')) {
    return 'texor-agent';
  }
  if (sessionId.startsWith('claude-code:')) {
    return 'claude-code';
  }
  return undefined;
}

function paperSessionBackend(paper: PaperRecord): AgentBackend | undefined {
  return paper.codexSessionBackend || inferredSessionBackend(paper.codexSessionId);
}

function withPaperSessionBackend(paper: PaperRecord): PaperRecord {
  const backend = paperSessionBackend(paper);
  return backend && paper.codexSessionBackend !== backend
    ? { ...paper, codexSessionBackend: backend }
    : paper;
}

function paperWithInheritedCodexSession(state: StoreState, paper: PaperRecord): PaperRecord {
  const normalized = withPaperSessionBackend(paper);
  if (normalized.codexSessionId && normalized.runtimeConfig) {
    return normalized;
  }

  const existing = state.papers[paper.id];
  if (existing?.codexSessionId || existing?.runtimeConfig) {
    return {
      ...normalized,
      codexSessionId: normalized.codexSessionId || existing.codexSessionId,
      codexSessionBackend: normalized.codexSessionBackend || paperSessionBackend(existing),
      codexSessionUpdatedAt: normalized.codexSessionUpdatedAt || existing.codexSessionUpdatedAt,
      runtimeConfig: normalized.runtimeConfig || existing.runtimeConfig,
    };
  }

  const root = workspaceProjectRoot(normalized);
  const backend = paperSessionBackend(normalized);
  const sibling = Object.values(state.papers).find((candidate) => {
    return candidate.codexSessionId && sameProjectRoot(workspaceProjectRoot(candidate), root) && (!backend || paperSessionBackend(candidate) === backend);
  });
  if (!sibling?.codexSessionId && !sibling?.runtimeConfig) {
    return normalized;
  }

  return {
    ...normalized,
    codexSessionId: normalized.codexSessionId || sibling.codexSessionId,
    codexSessionBackend: normalized.codexSessionBackend || paperSessionBackend(sibling),
    codexSessionUpdatedAt: normalized.codexSessionUpdatedAt || sibling.codexSessionUpdatedAt,
    runtimeConfig: normalized.runtimeConfig || sibling.runtimeConfig,
  };
}

async function loadAllProjectStates(): Promise<Array<{ projectRoot: string; state: StoreState }>> {
  const index = await loadIndex();
  const seen = new Set<string>();
  const states: Array<{ projectRoot: string; state: StoreState }> = [];
  for (const rawRoot of index.projectRoots) {
    const projectRoot = path.resolve(rawRoot);
    if (seen.has(projectRoot)) {
      continue;
    }
    seen.add(projectRoot);
    const storeFile = storeFileForProject(projectRoot);
    try {
      await fs.access(storeFile);
      const loaded = await loadProjectState(projectRoot);
      states.push({ projectRoot, state: await normalizeStateVersions(projectRoot, loaded) });
    } catch {
      // Missing projects are ignored; deleting from the UI also removes them from the index.
    }
  }
  return states;
}

export async function openWorkspaceForProjectRoot(projectRoot: string): Promise<WorkspaceSnapshot | null> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  try {
    await fs.access(storeFileForProject(resolvedProjectRoot));
  } catch {
    return null;
  }

  const loaded = await loadProjectState(resolvedProjectRoot);
  const state = await normalizeStateVersions(resolvedProjectRoot, loaded);
  await saveProjectState(resolvedProjectRoot, state);
  await registerProjectRoot(resolvedProjectRoot);

  const snapshots = Object.values(state.papers).flatMap((paper): WorkspaceSnapshot[] => {
    const versions = state.versions[paper.id];
    const currentVersion = versions ? currentVersionForState(state, paper.id, versions) : undefined;
    if (!versions?.length) {
      return [];
    }
    return [
      {
        paper,
        currentVersion: currentVersion || versions[versions.length - 1],
        versions,
      },
    ];
  });

  snapshots.sort((left, right) => right.currentVersion.createdAt.localeCompare(left.currentVersion.createdAt));
  return snapshots[0] || null;
}

export async function saveWorkspace(snapshot: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
  const projectRoot = workspaceProjectRoot(snapshot.paper);
  if (!projectRoot) {
    throw new Error('projectRoot is required to save a TEXOR workspace.');
  }
  const state = await loadProjectState(projectRoot);
  const paper = paperWithInheritedCodexSession(state, snapshot.paper);
  const normalizedVersions = normalizeVersions(snapshot.versions, {
    projectRoot: workspaceProjectRoot(paper),
    assetRoots: paper.assetRoots,
  });
  const currentVersion =
    normalizedVersions.versions.find((version) => version.id === snapshot.currentVersion.id) ||
    normalizedVersions.versions[normalizedVersions.versions.length - 1] ||
    snapshot.currentVersion;
  state.papers[paper.id] = paper;
  state.versions[snapshot.paper.id] = normalizedVersions.versions;
  state.currentVersionIds = {
    ...(state.currentVersionIds || {}),
    [paper.id]: currentVersion.id,
  };
  await saveProjectState(projectRoot, state);
  await registerProjectRoot(projectRoot);
  return {
    ...snapshot,
    paper,
    currentVersion,
    versions: normalizedVersions.versions,
  };
}

export async function appendVersion(paper: PaperRecord, version: PaperVersion): Promise<WorkspaceSnapshot> {
  const projectRoot = workspaceProjectRoot(paper);
  if (!projectRoot) {
    throw new Error('projectRoot is required to append a TEXOR paper version.');
  }
  const state = await loadProjectState(projectRoot);
  const storedPaper = paperWithInheritedCodexSession(state, paper);
  state.papers[storedPaper.id] = storedPaper;
  const existingVersions = normalizeVersions(state.versions[storedPaper.id] || [], {
    projectRoot: workspaceProjectRoot(storedPaper),
    assetRoots: storedPaper.assetRoots,
  }).versions;
  const baseVersion =
    (version.basedOnVersionId ? existingVersions.find((entry) => entry.id === version.basedOnVersionId) : undefined) ||
    existingVersions[existingVersions.length - 1];
  const versionLabel = version.label?.match(/^v\d+$/i) ? `v${existingVersions.length + 1}` : version.label;
  const nextVersion = enrichPaperVersion(version, baseVersion, {
    projectRoot: workspaceProjectRoot(storedPaper),
    assetRoots: storedPaper.assetRoots,
    sourcePath: version.sourcePath,
  });
  const versions = [...existingVersions, { ...nextVersion, label: versionLabel }];
  state.versions[storedPaper.id] = versions;
  state.currentVersionIds = {
    ...(state.currentVersionIds || {}),
    [storedPaper.id]: nextVersion.id,
  };
  await saveProjectState(projectRoot, state);
  await registerProjectRoot(projectRoot);
  return {
    paper: storedPaper,
    currentVersion: versions[versions.length - 1],
    versions,
  };
}

export async function readWorkspace(paperId: string): Promise<WorkspaceSnapshot | null> {
  const states = await loadAllProjectStates();
  for (const { state } of states) {
    const paper = state.papers[paperId];
    const versions = state.versions[paperId];
    const currentVersion = versions ? currentVersionForState(state, paperId, versions) : undefined;
    if (paper && versions && versions.length > 0) {
      return {
        paper,
        currentVersion: currentVersion || versions[versions.length - 1],
        versions,
      };
    }
  }
  return null;
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const states = await loadAllProjectStates();
  const summaries = states
    .flatMap(({ state }): WorkspaceSummary[] => {
      return Object.values(state.papers).flatMap((paper): WorkspaceSummary[] => {
        const versions = state.versions[paper.id] || [];
        const currentVersion = currentVersionForState(state, paper.id, versions);
        if (!currentVersion) {
          return [];
        }
        return [
          {
            paperId: paper.id,
            title: paper.title,
            targetJournal: paper.targetJournal,
            projectRoot: workspaceProjectRoot(paper),
            executionTarget: resolvedExecutionTarget(paper),
            sourcePath: currentVersion.sourcePath,
            codexSessionId: paper.codexSessionId,
            codexSessionBackend: paperSessionBackend(paper),
            codexSessionUpdatedAt: paper.codexSessionUpdatedAt,
            currentVersionId: currentVersion.id,
            currentVersionLabel: currentVersion.label,
            versionCount: versions.length,
            createdAt: paper.createdAt,
            updatedAt: currentVersion.createdAt,
          },
        ];
      });
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const grouped = new Map<string, WorkspaceSummary>();
  for (const summary of summaries) {
    const key = summary.projectRoot || summary.paperId;
    if (!grouped.has(key)) {
      grouped.set(key, summary);
    }
  }
  return [...grouped.values()];
}

export async function deleteWorkspaceGroup(paperId: string): Promise<{ deletedPaperIds: string[]; projectRoot?: string } | null> {
  const states = await loadAllProjectStates();
  for (const { projectRoot, state } of states) {
    const target = state.papers[paperId];
    if (!target) {
      continue;
    }

    const targetRoot = workspaceProjectRoot(target);
    const targetPaperIds = Object.values(state.papers)
      .filter((paper) => {
        if (!targetRoot) {
          return paper.id === paperId;
        }
        return sameProjectRoot(workspaceProjectRoot(paper), targetRoot);
      })
      .map((paper) => paper.id);

    for (const id of targetPaperIds) {
      delete state.papers[id];
      delete state.versions[id];
      if (state.currentVersionIds) {
        delete state.currentVersionIds[id];
      }
    }

    await saveProjectState(projectRoot, state);
    if (Object.keys(state.papers).length === 0) {
      await unregisterProjectRoot(projectRoot);
    }
    return { deletedPaperIds: targetPaperIds, projectRoot: targetRoot };
  }

  return null;
}

export async function updateWorkspaceCodexSession(
  paperId: string,
  sessionId: string,
  backend?: AgentBackend,
): Promise<WorkspaceSnapshot | null> {
  const states = await loadAllProjectStates();
  for (const { projectRoot, state } of states) {
    const target = state.papers[paperId];
    if (!target) {
      continue;
    }

    const targetRoot = workspaceProjectRoot(target);
    const updatedAt = new Date().toISOString();
    const sessionBackend = backend || inferredSessionBackend(sessionId);
    for (const [id, paper] of Object.entries(state.papers)) {
      const sameProject = targetRoot ? sameProjectRoot(workspaceProjectRoot(paper), targetRoot) : id === paperId;
      if (!sameProject) {
        continue;
      }
      state.papers[id] = {
        ...paper,
        codexSessionId: sessionId,
        codexSessionBackend: sessionBackend,
        codexSessionUpdatedAt: updatedAt,
      };
    }

    await saveProjectState(projectRoot, state);
    const paper = state.papers[paperId];
    const versions = state.versions[paperId];
    const currentVersion = versions ? currentVersionForState(state, paperId, versions) : undefined;
    if (!paper || !versions || versions.length === 0) {
      return null;
    }
    return {
      paper,
      currentVersion: currentVersion || versions[versions.length - 1],
      versions,
    };
  }
  return null;
}

export async function updateWorkspaceRuntimeConfig(
  paperId: string,
  runtimeConfig: PaperRecord['runtimeConfig'],
): Promise<WorkspaceSnapshot | null> {
  const states = await loadAllProjectStates();
  for (const { projectRoot, state } of states) {
    const target = state.papers[paperId];
    if (!target) {
      continue;
    }

    const targetRoot = workspaceProjectRoot(target);
    for (const [id, paper] of Object.entries(state.papers)) {
      const sameProject = targetRoot ? sameProjectRoot(workspaceProjectRoot(paper), targetRoot) : id === paperId;
      if (!sameProject) {
        continue;
      }
      state.papers[id] = {
        ...paper,
        runtimeConfig,
      };
    }

    await saveProjectState(projectRoot, state);
    const paper = state.papers[paperId];
    const versions = state.versions[paperId];
    const currentVersion = versions ? currentVersionForState(state, paperId, versions) : undefined;
    if (!paper || !versions || versions.length === 0) {
      return null;
    }
    return {
      paper,
      currentVersion: currentVersion || versions[versions.length - 1],
      versions,
    };
  }
  return null;
}

export async function restoreWorkspaceVersion(
  paperId: string,
  restoreVersionId: string,
  summary?: string,
): Promise<WorkspaceSnapshot | null> {
  const states = await loadAllProjectStates();
  for (const { projectRoot, state } of states) {
    const paper = state.papers[paperId];
    if (!paper) {
      continue;
    }

    const versions = normalizeVersions(state.versions[paperId] || [], {
      projectRoot: workspaceProjectRoot(paper),
      assetRoots: paper.assetRoots,
    }).versions;
    const restoreVersion = versions.find((entry) => entry.id === restoreVersionId);
    if (!restoreVersion) {
      return null;
    }
    const currentVersion = currentVersionForState(state, paperId, versions) || versions[versions.length - 1];
    const targetRoot = workspaceProjectRoot(paper);
    for (const [id, candidate] of Object.entries(state.papers)) {
      const sameProject = targetRoot ? sameProjectRoot(workspaceProjectRoot(candidate), targetRoot) : id === paperId;
      if (!sameProject) {
        continue;
      }
      state.papers[id] = {
        ...candidate,
        codexSessionId: undefined,
        codexSessionBackend: undefined,
        codexSessionUpdatedAt: undefined,
      };
    }
    const nextVersion: PaperVersion = enrichPaperVersion({
      id: crypto.randomUUID(),
      paperId,
      label: `v${versions.length + 1}`,
      summary: summary?.trim() || (currentVersion?.id === restoreVersion.id ? `Checkpoint from ${restoreVersion.label}` : `Rewind to ${restoreVersion.label}`),
      createdAt: nowIso(),
      sourceCommit: restoreVersion.sourceCommit || currentVersion?.sourceCommit,
      basedOnVersionId: currentVersion?.id || restoreVersion.id,
      sourcePath: restoreVersion.sourcePath || currentVersion?.sourcePath,
      blocks: restoreVersion.blocks,
      latex: restoreVersion.latex,
      focusTarget: restoreVersion.focusTarget,
    }, currentVersion, {
      projectRoot: workspaceProjectRoot(paper),
      assetRoots: paper.assetRoots,
      sourcePath: restoreVersion.sourcePath || currentVersion?.sourcePath,
    });
    const nextVersions = [...versions, nextVersion];
    state.versions[paperId] = nextVersions;
    state.currentVersionIds = {
      ...(state.currentVersionIds || {}),
      [paperId]: nextVersion.id,
    };
    const nextSourcePath = nextVersion.sourcePath;
    if (nextSourcePath) {
      await fs.mkdir(path.dirname(nextSourcePath), { recursive: true });
      await fs.writeFile(nextSourcePath, nextVersion.latex, 'utf8');
    }
    await saveProjectState(projectRoot, state);
    await registerProjectRoot(projectRoot);
    const restoredPaper = state.papers[paperId] || paper;
    return {
      paper: restoredPaper,
      currentVersion: nextVersion,
      versions: nextVersions,
    };
  }
  return null;
}

export async function readLatestWorkspace(): Promise<WorkspaceSnapshot | null> {
  const states = await loadAllProjectStates();
  const snapshots = states.flatMap(({ state }) => {
    return Object.values(state.papers).flatMap((paper): WorkspaceSnapshot[] => {
      const versions = state.versions[paper.id];
      const currentVersion = versions ? currentVersionForState(state, paper.id, versions) : undefined;
      if (!versions?.length) {
        return [];
      }
      return [
        {
          paper,
          currentVersion: currentVersion || versions[versions.length - 1],
          versions,
        },
      ];
    });
  });

  snapshots.sort((left, right) => right.currentVersion.createdAt.localeCompare(left.currentVersion.createdAt));
  return snapshots[0] || null;
}
