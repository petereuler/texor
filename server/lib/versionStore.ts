import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PaperRecord, PaperVersion, StoreState, WorkspaceSnapshot, WorkspaceSummary } from '../types.js';
import { dataPath } from './appPaths.js';

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
    return JSON.parse(raw) as StoreState;
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

function paperWithInheritedCodexSession(state: StoreState, paper: PaperRecord): PaperRecord {
  if (paper.codexSessionId) {
    return paper;
  }

  const existing = state.papers[paper.id];
  if (existing?.codexSessionId) {
    return {
      ...paper,
      codexSessionId: existing.codexSessionId,
      codexSessionUpdatedAt: existing.codexSessionUpdatedAt,
    };
  }

  const root = workspaceProjectRoot(paper);
  const sibling = Object.values(state.papers).find((candidate) => {
    return candidate.codexSessionId && sameProjectRoot(workspaceProjectRoot(candidate), root);
  });
  if (!sibling?.codexSessionId) {
    return paper;
  }

  return {
    ...paper,
    codexSessionId: sibling.codexSessionId,
    codexSessionUpdatedAt: sibling.codexSessionUpdatedAt,
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
      states.push({ projectRoot, state: await loadProjectState(projectRoot) });
    } catch {
      // Missing projects are ignored; deleting from the UI also removes them from the index.
    }
  }
  return states;
}

export async function saveWorkspace(snapshot: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
  const projectRoot = workspaceProjectRoot(snapshot.paper);
  if (!projectRoot) {
    throw new Error('projectRoot is required to save a TEXOR workspace.');
  }
  const state = await loadProjectState(projectRoot);
  const paper = paperWithInheritedCodexSession(state, snapshot.paper);
  state.papers[paper.id] = paper;
  state.versions[snapshot.paper.id] = snapshot.versions;
  await saveProjectState(projectRoot, state);
  await registerProjectRoot(projectRoot);
  return {
    ...snapshot,
    paper,
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
  const versions = [...(state.versions[storedPaper.id] || []), version];
  state.versions[storedPaper.id] = versions;
  await saveProjectState(projectRoot, state);
  await registerProjectRoot(projectRoot);
  return {
    paper: storedPaper,
    currentVersion: version,
    versions,
  };
}

export async function readWorkspace(paperId: string): Promise<WorkspaceSnapshot | null> {
  const states = await loadAllProjectStates();
  for (const { state } of states) {
    const paper = state.papers[paperId];
    const versions = state.versions[paperId];
    if (paper && versions && versions.length > 0) {
      return {
        paper,
        currentVersion: versions[versions.length - 1],
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
        const currentVersion = versions[versions.length - 1];
        if (!currentVersion) {
          return [];
        }
        return [
          {
            paperId: paper.id,
            title: paper.title,
            targetJournal: paper.targetJournal,
            projectRoot: workspaceProjectRoot(paper),
            sourcePath: currentVersion.sourcePath,
            codexSessionId: paper.codexSessionId,
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
    }

    await saveProjectState(projectRoot, state);
    if (Object.keys(state.papers).length === 0) {
      await unregisterProjectRoot(projectRoot);
    }
    return { deletedPaperIds: targetPaperIds, projectRoot: targetRoot };
  }

  return null;
}

export async function updateWorkspaceCodexSession(paperId: string, sessionId: string): Promise<WorkspaceSnapshot | null> {
  const states = await loadAllProjectStates();
  for (const { projectRoot, state } of states) {
    const target = state.papers[paperId];
    if (!target) {
      continue;
    }

    const targetRoot = workspaceProjectRoot(target);
    const updatedAt = new Date().toISOString();
    for (const [id, paper] of Object.entries(state.papers)) {
      const sameProject = targetRoot ? sameProjectRoot(workspaceProjectRoot(paper), targetRoot) : id === paperId;
      if (!sameProject) {
        continue;
      }
      state.papers[id] = {
        ...paper,
        codexSessionId: sessionId,
        codexSessionUpdatedAt: updatedAt,
      };
    }

    await saveProjectState(projectRoot, state);
    const paper = state.papers[paperId];
    const versions = state.versions[paperId];
    if (!paper || !versions || versions.length === 0) {
      return null;
    }
    return {
      paper,
      currentVersion: versions[versions.length - 1],
      versions,
    };
  }
  return null;
}

export async function readLatestWorkspace(): Promise<WorkspaceSnapshot | null> {
  const states = await loadAllProjectStates();
  const snapshots = states.flatMap(({ state }) => {
    return Object.values(state.papers).flatMap((paper): WorkspaceSnapshot[] => {
      const versions = state.versions[paper.id];
      if (!versions?.length) {
        return [];
      }
      return [
        {
          paper,
          currentVersion: versions[versions.length - 1],
          versions,
        },
      ];
    });
  });

  snapshots.sort((left, right) => right.currentVersion.createdAt.localeCompare(left.currentVersion.createdAt));
  return snapshots[0] || null;
}
