import crypto from 'node:crypto';
import { CodexPaperCreateRequest, CodexPaperVersionRequest, PaperBlock, PaperRecord, PaperVersion, WorkspaceSnapshot } from '../types.js';
import { appendVersion } from './versionStore.js';

function nowIso(): string {
  return new Date().toISOString();
}

function blocksFromLatex(latex: string): PaperBlock[] {
  return [
    {
      id: crypto.randomUUID(),
      type: 'text',
      section: 'Manuscript',
      title: 'Codex Manuscript',
      content: latex,
    },
  ];
}

export function createCodexWorkspace(request: CodexPaperCreateRequest): WorkspaceSnapshot {
  const paperId = crypto.randomUUID();
  const paper: PaperRecord = {
    id: paperId,
    title: request.title,
    targetJournal: request.targetJournal,
    authors: request.authors || [],
    projectRoot: request.projectRoot,
    assetRoots: request.assetRoots,
    createdAt: nowIso(),
  };
  const version: PaperVersion = {
    id: crypto.randomUUID(),
    paperId,
    label: 'v1',
    summary: request.summary || 'Codex handoff',
    createdAt: nowIso(),
    sourcePath: request.sourcePath,
    blocks: blocksFromLatex(request.latex),
    latex: request.latex,
  };

  return {
    paper,
    currentVersion: version,
    versions: [version],
  };
}

export async function appendCodexVersion(
  paper: PaperRecord,
  versionCount: number,
  request: CodexPaperVersionRequest,
): Promise<WorkspaceSnapshot> {
  const version: PaperVersion = {
    id: crypto.randomUUID(),
    paperId: paper.id,
    label: `v${versionCount + 1}`,
    summary: request.summary || 'Codex revision',
    createdAt: nowIso(),
    sourcePath: request.sourcePath,
    basedOnVersionId: request.basedOnVersionId,
    blocks: blocksFromLatex(request.latex),
    latex: request.latex,
  };

  return appendVersion(paper, version);
}
