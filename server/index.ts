import cors from 'cors';
import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { claimBridgeCommand, createBridgeCommand, deleteBridgeCommandsForPapers, listBridgeCommands, readBridgeCommand, updateBridgeCommand } from './lib/bridgeCommandStore.js';
import { buildPaperWorkspace, composeDiffLatex } from './lib/paperBuilder.js';
import { appendCodexVersion, createCodexWorkspace } from './lib/codexHandoff.js';
import { createFeedback, deleteFeedbackForPapers, listFeedback, updateFeedbackStatus } from './lib/feedbackStore.js';
import { compileLatexProject } from './lib/latexCompiler.js';
import { locatePdfSelection } from './lib/pdfLocator.js';
import { resolveBuildRequestPath } from './lib/buildPaths.js';
import { appPath } from './lib/appPaths.js';
import { scanProject } from './lib/projectScanner.js';
import { reviseWorkspace } from './lib/revisionEngine.js';
import { ensureTemplate, readTemplateCatalog, searchTemplateCatalog } from './lib/templateCatalog.js';
import { deleteWorkspaceGroup, listWorkspaces, readLatestWorkspace, readWorkspace, saveWorkspace, updateWorkspaceCodexSession } from './lib/versionStore.js';
import {
  BridgeCommandCreateRequest,
  BridgeCommandStatus,
  BridgeCommandUpdateRequest,
  CodexFeedbackCreateRequest,
  CodexFeedbackStatus,
  CodexFeedbackStatusRequest,
  CodexPaperCreateRequest,
  CodexPaperVersionRequest,
  PdfSelectionLocateRequest,
  RevisionRequest,
} from './types.js';

const app = express();
const port = Number(process.env.PORT || 4174);

function uniqueResolvedPaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((entry): entry is string => Boolean(entry?.trim())).map((entry) => path.resolve(entry)))];
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.get('/api/builds/*', (req, res) => {
  const projectRoot = typeof req.query.projectRoot === 'string' ? req.query.projectRoot : undefined;
  const wildcard = req.params as Record<string, unknown>;
  const relativePath =
    typeof wildcard[0] === 'string'
      ? wildcard[0]
      : Array.isArray(wildcard[''])
        ? wildcard[''].join('/')
        : typeof wildcard[''] === 'string'
          ? wildcard['']
          : undefined;
  const filePath = relativePath ? resolveBuildRequestPath(relativePath, projectRoot) : null;
  if (!filePath) {
    res.status(404).json({ error: 'Build artifact not found.' });
    return;
  }
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) {
      res.status(404).json({ error: 'Build artifact not found.' });
    }
  });
});

function canonicalManuscriptPath(projectRoot: string): string {
  return path.join(projectRoot, '.texor', 'manuscript', 'main.tex');
}

async function assertWritableProjectWorkspace(projectRoot: string): Promise<string> {
  const root = path.resolve(projectRoot);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`项目路径不存在或不是目录: ${root}`);
  }

  const manuscriptDir = path.dirname(canonicalManuscriptPath(root));
  await fs.mkdir(manuscriptDir, { recursive: true });
  const probeFile = path.join(manuscriptDir, `.write-check-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(probeFile, 'ok', 'utf8');
  await fs.unlink(probeFile).catch(() => undefined);
  return root;
}

function inferredSourcePath(snapshot: Awaited<ReturnType<typeof readWorkspace>>, version: { sourcePath?: string }): string | undefined {
  if (!snapshot) {
    return version.sourcePath;
  }
  return (
    version.sourcePath ||
    (snapshot.paper.projectRoot ? path.join(snapshot.paper.projectRoot, '.texor', 'manuscript', 'main.tex') : undefined) ||
    (snapshot.paper.analysis?.rootPath ? path.join(snapshot.paper.analysis.rootPath, '.texor', 'manuscript', 'main.tex') : undefined)
  );
}

function hasFullLatexDocument(latex: string): boolean {
  return /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(latex) && /\\begin\{document\}/.test(latex) && /\\end\{document\}/.test(latex);
}

function latexNonWhitespaceLength(latex: string): number {
  return latex.replace(/\s+/g, '').length;
}

function validateNewLatexVersion(candidate: string, baseLatex?: string): string | null {
  if (!candidate.trim()) {
    return 'latex must not be empty.';
  }
  if (!hasFullLatexDocument(candidate)) {
    return 'latex must be a complete LaTeX document, not a snippet.';
  }
  if (baseLatex && hasFullLatexDocument(baseLatex)) {
    const baseLength = latexNonWhitespaceLength(baseLatex);
    const nextLength = latexNonWhitespaceLength(candidate);
    if (baseLength > 1200 && nextLength < baseLength * 0.72) {
      return 'latex is much shorter than the selected base version; refusing to save a likely partial rewrite.';
    }
  }
  return null;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
  });
});

app.get('/api/templates', async (_req, res) => {
  try {
    res.json(await readTemplateCatalog());
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Template catalog failed.',
    });
  }
});

app.get('/api/templates/search', async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 8;
    res.json(await searchTemplateCatalog(query, Number.isFinite(limit) ? limit : 8));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Template search failed.',
    });
  }
});

app.post('/api/templates/:templateId/ensure', async (req, res) => {
  try {
    res.json(await ensureTemplate(req.params.templateId));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Template download failed.',
    });
  }
});

app.post('/api/projects/scan', async (req, res) => {
  try {
    const { rootPath } = req.body as { rootPath?: string };
    if (!rootPath) {
      res.status(400).json({ error: 'rootPath is required.' });
      return;
    }
    const analysis = await scanProject(rootPath);
    res.json(analysis);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Project scan failed.',
    });
  }
});

app.post('/api/papers/import-tex', async (req, res) => {
  try {
    const request = req.body as {
      texPath?: string;
      projectRoot?: string;
      targetJournal?: string;
      title?: string;
      summary?: string;
    };
    if (!request.texPath || !request.projectRoot || !request.targetJournal) {
      res.status(400).json({ error: 'projectRoot, texPath, and targetJournal are required.' });
      return;
    }
    const sourcePath = path.resolve(request.texPath);
    const latex = await fs.readFile(sourcePath, 'utf8');
    const projectRoot = await assertWritableProjectWorkspace(request.projectRoot);
    const manuscriptPath = canonicalManuscriptPath(projectRoot);
    const assetRoots = uniqueResolvedPaths([path.dirname(sourcePath), projectRoot]);
    await fs.writeFile(manuscriptPath, latex, 'utf8');
    const snapshot = createCodexWorkspace({
      title: request.title || path.basename(sourcePath).replace(/\.tex$/i, ''),
      targetJournal: request.targetJournal,
      latex,
      summary: request.summary || `Imported ${sourcePath} into project main.tex`,
      projectRoot,
      sourcePath: manuscriptPath,
      assetRoots,
    });
    await saveWorkspace(snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'LaTeX import failed.',
    });
  }
});

app.post('/api/codex/papers', async (req, res) => {
  try {
    const request = req.body as CodexPaperCreateRequest;
    if (!request.title || !request.projectRoot || !request.targetJournal || !request.latex) {
      res.status(400).json({ error: 'title, projectRoot, targetJournal, and latex are required.' });
      return;
    }
    request.projectRoot = await assertWritableProjectWorkspace(request.projectRoot);
    request.assetRoots = uniqueResolvedPaths([...(request.assetRoots || []), request.projectRoot]);
    const snapshot = createCodexWorkspace(request);
    await saveWorkspace(snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Codex paper handoff failed.',
    });
  }
});

app.post('/api/codex/papers/:paperId/versions', async (req, res) => {
  try {
    const snapshot = await readWorkspace(req.params.paperId);
    if (!snapshot) {
      res.status(404).json({ error: 'Paper not found.' });
      return;
    }
    const request = req.body as CodexPaperVersionRequest;
    if (!request.latex) {
      res.status(400).json({ error: 'latex is required.' });
      return;
    }
    const baseVersion =
      snapshot.versions.find((entry) => entry.id === request.basedOnVersionId) ||
      snapshot.currentVersion;
    const validationError = validateNewLatexVersion(request.latex, baseVersion?.latex);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    res.json(await appendCodexVersion(snapshot.paper, snapshot.versions.length, request));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Codex version handoff failed.',
    });
  }
});

app.post('/api/codex/feedback', async (req, res) => {
  try {
    const request = req.body as CodexFeedbackCreateRequest;
    if (!request.paperId || !request.versionId || !request.issue || !request.changeRequest) {
      res.status(400).json({ error: 'paperId, versionId, issue, and changeRequest are required.' });
      return;
    }

    const snapshot = await readWorkspace(request.paperId);
    if (!snapshot) {
      res.status(404).json({ error: 'Paper not found.' });
      return;
    }

    const hasVersion = snapshot.versions.some((entry) => entry.id === request.versionId);
    if (!hasVersion) {
      res.status(404).json({ error: 'Version not found.' });
      return;
    }

    res.json(await createFeedback(request));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Feedback creation failed.',
    });
  }
});

app.get('/api/codex/feedback', async (req, res) => {
  try {
    const paperId = typeof req.query.paperId === 'string' ? req.query.paperId : undefined;
    const status = typeof req.query.status === 'string' ? (req.query.status as CodexFeedbackStatus) : undefined;
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(await listFeedback({ paperId, status, after, limit }));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Feedback listing failed.',
    });
  }
});

app.patch('/api/codex/feedback/:feedbackId', async (req, res) => {
  try {
    const request = req.body as CodexFeedbackStatusRequest;
    if (!request.status) {
      res.status(400).json({ error: 'status is required.' });
      return;
    }
    if (!['open', 'accepted', 'done', 'dismissed'].includes(request.status)) {
      res.status(400).json({ error: 'status must be open, accepted, done, or dismissed.' });
      return;
    }

    const feedback = await updateFeedbackStatus(req.params.feedbackId, request.status);
    if (!feedback) {
      res.status(404).json({ error: 'Feedback not found.' });
      return;
    }
    res.json(feedback);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Feedback update failed.',
    });
  }
});

app.post('/api/bridge/commands', async (req, res) => {
  try {
    const request = req.body as BridgeCommandCreateRequest;
    if (!request.type || !request.payload) {
      res.status(400).json({ error: 'type and payload are required.' });
      return;
    }
    if (!['codex-task', 'capture-active-latex'].includes(request.type)) {
      res.status(400).json({ error: 'type must be codex-task or capture-active-latex.' });
      return;
    }
    if (request.type === 'codex-task') {
      const payload = request.payload as { projectPath?: string };
      if (!payload.projectPath?.trim()) {
        res.status(400).json({ error: 'projectPath is required for codex-task.' });
        return;
      }
      payload.projectPath = await assertWritableProjectWorkspace(payload.projectPath);
    }
    res.json(await createBridgeCommand(request));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Bridge command creation failed.',
    });
  }
});

app.get('/api/bridge/commands', async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? (req.query.status as BridgeCommandStatus) : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const paperId = typeof req.query.paperId === 'string' ? req.query.paperId : undefined;
    const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
    res.json(await listBridgeCommands({ status, limit, paperId, projectPath }));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Bridge command listing failed.',
    });
  }
});

app.get('/api/bridge/commands/:commandId', async (req, res) => {
  const command = await readBridgeCommand(req.params.commandId);
  if (!command) {
    res.status(404).json({ error: 'Bridge command not found.' });
    return;
  }
  res.json(command);
});

app.post('/api/bridge/commands/:commandId/claim', async (req, res) => {
  try {
    const command = await claimBridgeCommand(req.params.commandId);
    if (!command) {
      res.status(409).json({ error: 'Bridge command is not available.' });
      return;
    }
    res.json(command);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Bridge command claim failed.',
    });
  }
});

app.patch('/api/bridge/commands/:commandId', async (req, res) => {
  try {
    const request = req.body as BridgeCommandUpdateRequest;
    if (request.status && !['queued', 'running', 'done', 'failed'].includes(request.status)) {
      res.status(400).json({ error: 'status must be queued, running, done, or failed.' });
      return;
    }
    if (request.control !== undefined && request.control !== null && !['pause', 'terminate'].includes(request.control)) {
      res.status(400).json({ error: 'control must be pause or terminate.' });
      return;
    }
    if (
      !request.status &&
      !request.phase &&
      request.message === undefined &&
      !request.sessionId &&
      request.control === undefined &&
      !request.result &&
      !request.error &&
      !request.logs?.length
    ) {
      res.status(400).json({ error: 'status, phase, message, sessionId, control, result, error, or logs are required.' });
      return;
    }

    const command = await updateBridgeCommand(req.params.commandId, request);
    if (!command) {
      res.status(404).json({ error: 'Bridge command not found.' });
      return;
    }
    res.json(command);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Bridge command update failed.',
    });
  }
});

app.post('/api/pdf/locate', async (req, res) => {
  try {
    const request = req.body as PdfSelectionLocateRequest;
    if (!request.pdfUrl || !request.page || !Number.isFinite(request.x) || !Number.isFinite(request.y)) {
      res.status(400).json({ error: 'pdfUrl, page, x, and y are required.' });
      return;
    }
    res.json(await locatePdfSelection(request));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'PDF selection lookup failed.',
    });
  }
});

app.post('/api/papers/generate', async (req, res) => {
  try {
    const { analysis, targetJournal, modelConfig } = req.body as {
      analysis?: Awaited<ReturnType<typeof scanProject>>;
      targetJournal?: string;
      modelConfig?: { apiKey?: string; baseUrl?: string; model?: string };
    };
    if (!analysis || !targetJournal) {
      res.status(400).json({ error: 'analysis and targetJournal are required.' });
      return;
    }
    const snapshot = await buildPaperWorkspace(analysis, targetJournal, modelConfig);
    await saveWorkspace(snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Paper generation failed.',
    });
  }
});

app.patch('/api/papers/:paperId/codex-session', async (req, res) => {
  try {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId?.trim()) {
      res.status(400).json({ error: 'sessionId is required.' });
      return;
    }
    const snapshot = await updateWorkspaceCodexSession(req.params.paperId, sessionId.trim());
    if (!snapshot) {
      res.status(404).json({ error: 'Paper not found.' });
      return;
    }
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Codex session update failed.',
    });
  }
});

app.get('/api/papers/:paperId', async (req, res) => {
  const snapshot = await readWorkspace(req.params.paperId);
  if (!snapshot) {
    res.status(404).json({ error: 'Paper not found.' });
    return;
  }
  res.json(snapshot);
});

app.get('/api/workspaces', async (_req, res) => {
  try {
    res.json(await listWorkspaces());
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Workspace listing failed.',
    });
  }
});

app.delete('/api/workspaces/:paperId', async (req, res) => {
  try {
    const deleted = await deleteWorkspaceGroup(req.params.paperId);
    if (!deleted) {
      res.status(404).json({ error: 'Workspace not found.' });
      return;
    }
    await Promise.all([
      deleteFeedbackForPapers(deleted.deletedPaperIds),
      deleteBridgeCommandsForPapers(deleted.deletedPaperIds, deleted.projectRoot),
    ]);
    res.json({
      deletedPaperIds: deleted.deletedPaperIds,
      projectRoot: deleted.projectRoot,
      workspaces: await listWorkspaces(),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Workspace deletion failed.',
    });
  }
});

app.get('/api/workspace/latest', async (_req, res) => {
  const snapshot = await readLatestWorkspace();
  if (!snapshot) {
    res.status(404).json({ error: 'No paper found.' });
    return;
  }
  res.json(snapshot);
});

app.post('/api/papers/:paperId/revise', async (req, res) => {
  try {
    const snapshot = await readWorkspace(req.params.paperId);
    if (!snapshot) {
      res.status(404).json({ error: 'Paper not found.' });
      return;
    }
    const request = req.body as RevisionRequest;
    const result = await reviseWorkspace(snapshot, request);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Revision failed.',
    });
  }
});

app.post('/api/papers/:paperId/compile', async (req, res) => {
  try {
    const snapshot = await readWorkspace(req.params.paperId);
    if (!snapshot) {
      res.status(404).json({ error: 'Paper not found.' });
      return;
    }
    const versionId = (req.body as { versionId?: string }).versionId;
    const version = snapshot.versions.find((entry) => entry.id === versionId) || snapshot.currentVersion;
    const compileResult = await compileLatexProject(
      version.latex,
      inferredSourcePath(snapshot, version),
      snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath,
      snapshot.paper.assetRoots,
    );
    res.json(compileResult);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'LaTeX compilation failed.',
    });
  }
});

app.post('/api/papers/:paperId/compile-diff', async (req, res) => {
  try {
    const snapshot = await readWorkspace(req.params.paperId);
    if (!snapshot) {
      res.status(404).json({ error: 'Paper not found.' });
      return;
    }

    const { previousVersionId, currentVersionId } = req.body as { previousVersionId?: string; currentVersionId?: string };
    const currentVersion =
      snapshot.versions.find((entry) => entry.id === currentVersionId) || snapshot.currentVersion;
    const currentIndex = snapshot.versions.findIndex((entry) => entry.id === currentVersion.id);
    const previousVersion =
      snapshot.versions.find((entry) => entry.id === previousVersionId) ||
      (currentIndex > 0 ? snapshot.versions[currentIndex - 1] : undefined);

    if (!previousVersion) {
      const current = await compileLatexProject(
        currentVersion.latex,
        inferredSourcePath(snapshot, currentVersion),
        snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath,
        snapshot.paper.assetRoots,
      );
      res.json({
        ok: current.ok,
        current,
        currentVersionId: currentVersion.id,
      });
      return;
    }

    const [previous, current] = await Promise.all([
      composeDiffLatex(snapshot.paper, previousVersion, currentVersion, 'previous').then((latex) =>
        compileLatexProject(
          latex,
          inferredSourcePath(snapshot, previousVersion),
          snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath,
          snapshot.paper.assetRoots,
        ),
      ),
      composeDiffLatex(snapshot.paper, currentVersion, previousVersion, 'current').then((latex) =>
        compileLatexProject(
          latex,
          inferredSourcePath(snapshot, currentVersion),
          snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath,
          snapshot.paper.assetRoots,
        ),
      ),
    ]);

    res.json({
      ok: previous.ok && current.ok,
      previous,
      current,
      previousVersionId: previousVersion.id,
      currentVersionId: currentVersion.id,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Diff compilation failed.',
    });
  }
});

if (process.env.NODE_ENV === 'production') {
  const clientDist = appPath('web');
  const fallbackClientDist = appPath('dist');
  app.use(express.static(clientDist));
  app.use(express.static(fallbackClientDist));
  app.get('*', (_req, res) => {
    const indexPath = path.join(clientDist, 'index.html');
    res.sendFile(indexPath, (error) => {
      if (error && !res.headersSent) {
        res.sendFile(path.join(fallbackClientDist, 'index.html'));
      }
    });
  });
}

app.listen(port, '0.0.0.0', () => {
  console.log(`texor API listening on http://0.0.0.0:${port}`);
});
