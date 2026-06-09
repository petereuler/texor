import cors from 'cors';
import express from 'express';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { claimBridgeCommand, createBridgeCommand, deleteBridgeCommandsForPapers, listBridgeCommands, readBridgeCommand, updateBridgeCommand } from './lib/bridgeCommandStore.js';
import { buildPaperWorkspace, composeDiffLatex } from './lib/paperBuilder.js';
import { appendCodexVersion, createCodexWorkspace } from './lib/codexHandoff.js';
import { createFeedback, deleteFeedbackForPapers, listFeedback, updateFeedbackStatus } from './lib/feedbackStore.js';
import { compileLatexProject } from './lib/latexCompiler.js';
import { importManuscriptWorkspace } from './lib/importedManuscript.js';
import { appendDesktopChannelLog, buildDesktopDiagnosticsBundle } from './lib/desktopDiagnostics.js';
import {
  desktopBootstrap,
  listSSHHosts,
  listWorkspaceFiles,
  prepareExecutionTarget,
  readWorkspaceFile,
  runWorkspaceCommand,
  writeWorkspaceFile,
} from './lib/desktopServices.js';
import { locatePdfSelection, locateSourceLine } from './lib/pdfLocator.js';
import { resolveBuildRequestPath } from './lib/buildPaths.js';
import { appPath } from './lib/appPaths.js';
import { scanProject } from './lib/projectScanner.js';
import { reviseWorkspace } from './lib/revisionEngine.js';
import { ensureTemplate, readTemplateCatalog, searchTemplateCatalog } from './lib/templateCatalog.js';
import {
  deleteWorkspaceGroup,
  listWorkspaces,
  openWorkspaceForProjectRoot,
  readLatestWorkspace,
  readWorkspace,
  restoreWorkspaceVersion,
  saveWorkspace,
  updateWorkspaceCodexSession,
  updateWorkspaceRuntimeConfig,
} from './lib/versionStore.js';
import {
  BridgeCommandCreateRequest,
  BridgeCommandStatus,
  BridgeCommandUpdateRequest,
  CodexFeedbackCreateRequest,
  CodexFeedbackStatus,
  CodexFeedbackStatusRequest,
  CodexPaperCreateRequest,
  CodexPaperVersionRequest,
  DesktopOpenProjectRequest,
  PdfSelectionLocateRequest,
  RevisionRequest,
  SourceLineLocateRequest,
} from './types.js';

const app = express();
const port = Number(process.env.PORT || 4174);
const execFileAsync = promisify(execFile);
app.disable('etag');

async function logDesktopServer(level: 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
  if (process.env.TEXOR_DESKTOP !== '1') {
    return;
  }
  await appendDesktopChannelLog('desktop-server', level, message).catch(() => undefined);
}

function uniqueResolvedPaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((entry): entry is string => Boolean(entry?.trim())).map((entry) => path.resolve(entry)))];
}

app.use(cors());
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sanitizedArchiveName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

async function buildWorkspaceArchive(snapshot: NonNullable<Awaited<ReturnType<typeof readWorkspace>>>) {
  const projectRoot = snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath;
  if (!projectRoot) {
    throw new Error('稿库缺少 projectRoot，暂时无法导出。');
  }

  const resolvedRoot = path.resolve(projectRoot);
  const texorRoot = path.join(resolvedRoot, '.texor');
  const stateFile = path.join(texorRoot, 'state.json');
  const manuscriptDir = path.join(texorRoot, 'manuscript');
  const hasState = await pathExists(stateFile);
  const hasManuscript = await pathExists(manuscriptDir);
  if (!hasState || !hasManuscript) {
    throw new Error('当前稿库还不完整，缺少可导出的 TEXOR 状态或 manuscript 文件。');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'texor-workspace-export-'));
  const bundleName = sanitizedArchiveName(snapshot.paper.title || snapshot.paper.id || 'texor-workspace', 'texor-workspace');
  const bundleRoot = path.join(tempRoot, bundleName);
  const bundleTexorRoot = path.join(bundleRoot, '.texor');
  const visibleManuscriptDir = path.join(bundleRoot, 'current-manuscript');
  const archivePath = path.join(tempRoot, `${bundleName}.zip`);
  const manifest = {
    title: snapshot.paper.title,
    paperId: snapshot.paper.id,
    targetJournal: snapshot.paper.targetJournal,
    currentVersionId: snapshot.currentVersion.id,
    currentVersionLabel: snapshot.currentVersion.label,
    versionCount: snapshot.versions.length,
    exportedAt: new Date().toISOString(),
    restoreHint: '保留根目录下的 .texor 文件夹，然后重新载入这个解压目录即可恢复 TEXOR 稿库。',
  };
  const readme = [
    `# ${snapshot.paper.title || 'TEXOR Workspace Export'}`,
    '',
    '这个导出包现在包含三部分：',
    '- `current-manuscript/`：当前稿件正文和编译所需支持文件，解压后直接可见。',
    '- `.texor/`：TEXOR 的版本历史、状态文件和内部工作稿，请保留不要删除。',
    '- `texor-workspace.json`：这份稿库的元信息摘要。',
    '',
    '如果你想之后重新载入这个稿库：',
    '1. 保留整个解压目录不变。',
    '2. 确保 `.texor/` 目录仍然存在。',
    '3. 在 TEXOR 中载入这个解压后的目录。',
  ].join('\n');

  await fs.mkdir(bundleTexorRoot, { recursive: true });
  await fs.mkdir(bundleRoot, { recursive: true });
  await fs.copyFile(stateFile, path.join(bundleTexorRoot, 'state.json'));
  await fs.cp(manuscriptDir, visibleManuscriptDir, { recursive: true });
  await fs.cp(manuscriptDir, path.join(bundleTexorRoot, 'manuscript'), { recursive: true });
  await fs.writeFile(path.join(bundleRoot, 'texor-workspace.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(bundleRoot, 'README.md'), readme, 'utf8');
  await execFileAsync('zip', ['-qr', archivePath, bundleName], { cwd: tempRoot });

  return {
    archivePath,
    filename: `${bundleName}.zip`,
    cleanup: async () => {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
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

app.get('/api/health', async (_req, res) => {
  const bootstrap = await desktopBootstrap(process.env.TEXOR_SERVER_URL || `http://127.0.0.1:${port}`);
  res.json({
    ok: true,
    sampleProjectPath: null,
    desktop: bootstrap,
  });
});

app.get('/api/desktop/bootstrap', async (_req, res) => {
  res.json(await desktopBootstrap(process.env.TEXOR_SERVER_URL || `http://127.0.0.1:${port}`));
});

app.get('/api/desktop/diagnostics/bundle', async (_req, res) => {
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const archive = await buildDesktopDiagnosticsBundle();
    cleanup = archive.cleanup;
    res.download(archive.archivePath, archive.filename, (error) => {
      void archive.cleanup();
      if (error && !res.headersSent) {
        res.status(500).json({ error: 'Desktop diagnostics export failed.' });
      }
    });
  } catch (error) {
    await cleanup?.();
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Desktop diagnostics export failed.',
    });
  }
});

app.post('/api/desktop/import-vscode-config', async (_req, res) => {
  res.json(await desktopBootstrap(process.env.TEXOR_SERVER_URL || `http://127.0.0.1:${port}`));
});

app.get('/api/desktop/ssh-hosts', async (_req, res) => {
  res.json(await listSSHHosts());
});

app.post('/api/desktop/open-project', async (req, res) => {
  try {
    const request = req.body as DesktopOpenProjectRequest;
    if (!request.target) {
      res.status(400).json({ error: 'target is required.' });
      return;
    }
    res.json(await prepareExecutionTarget(request.target));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Desktop project preparation failed.',
    });
  }
});

app.get('/api/workspace-files', async (req, res) => {
  try {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : 'local';
    const rootPath = typeof req.query.rootPath === 'string' ? req.query.rootPath : '';
    const hostAlias = typeof req.query.hostAlias === 'string' ? req.query.hostAlias : '';
    const remoteRoot = typeof req.query.remoteRoot === 'string' ? req.query.remoteRoot : '';
    const relativePath = typeof req.query.relativePath === 'string' ? req.query.relativePath : '.';
    const target = kind === 'ssh'
      ? { kind: 'ssh' as const, hostAlias, remoteRoot }
      : { kind: 'local' as const, rootPath };
    res.json(await listWorkspaceFiles(target, relativePath));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Workspace file listing failed.',
    });
  }
});

app.get('/api/workspace-file', async (req, res) => {
  try {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : 'local';
    const rootPath = typeof req.query.rootPath === 'string' ? req.query.rootPath : '';
    const hostAlias = typeof req.query.hostAlias === 'string' ? req.query.hostAlias : '';
    const remoteRoot = typeof req.query.remoteRoot === 'string' ? req.query.remoteRoot : '';
    const relativePath = typeof req.query.relativePath === 'string' ? req.query.relativePath : '';
    if (!relativePath) {
      res.status(400).json({ error: 'relativePath is required.' });
      return;
    }
    const target = kind === 'ssh'
      ? { kind: 'ssh' as const, hostAlias, remoteRoot }
      : { kind: 'local' as const, rootPath };
    res.json(await readWorkspaceFile(target, relativePath));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Workspace file read failed.',
    });
  }
});

app.put('/api/workspace-file', async (req, res) => {
  try {
    const request = req.body as {
      target?: DesktopOpenProjectRequest['target'];
      relativePath?: string;
      content?: string;
    };
    if (!request.target || !request.relativePath || typeof request.content !== 'string') {
      res.status(400).json({ error: 'target, relativePath, and content are required.' });
      return;
    }
    res.json(await writeWorkspaceFile(request.target, request.relativePath, request.content));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Workspace file write failed.',
    });
  }
});

app.post('/api/workspace-command', async (req, res) => {
  try {
    const request = req.body as {
      target?: DesktopOpenProjectRequest['target'];
      command?: string;
      cwd?: string;
    };
    if (!request.target || !request.command) {
      res.status(400).json({ error: 'target and command are required.' });
      return;
    }
    res.json(await runWorkspaceCommand(request.target, request.command, request.cwd));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Workspace command failed.',
    });
  }
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
      executionTarget?: CodexPaperCreateRequest['executionTarget'];
      targetJournal?: string;
      title?: string;
      summary?: string;
      runtimeConfig?: CodexPaperCreateRequest['runtimeConfig'];
    };
    if (!request.texPath || !request.projectRoot || !request.targetJournal) {
      res.status(400).json({ error: 'projectRoot, texPath, and targetJournal are required.' });
      return;
    }
    const sourcePath = path.resolve(request.texPath);
    const projectRoot = await assertWritableProjectWorkspace(request.projectRoot);
    const manuscriptPath = canonicalManuscriptPath(projectRoot);
    const imported = await importManuscriptWorkspace(sourcePath, manuscriptPath);
    const assetRoots = uniqueResolvedPaths([imported.manuscriptDir, imported.sourceDir, projectRoot]);
    const snapshot = createCodexWorkspace({
      title: request.title || path.basename(sourcePath).replace(/\.tex$/i, ''),
      targetJournal: request.targetJournal,
      latex: imported.latex,
      summary:
        request.summary ||
        `Imported ${sourcePath} into project main.tex | Synced ${imported.copiedFileCount} support files`,
      projectRoot,
      executionTarget: request.executionTarget,
      sourcePath: manuscriptPath,
      assetRoots,
      runtimeConfig: request.runtimeConfig,
    });
    res.json(await saveWorkspace(snapshot));
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
    if (request.sourcePath) {
      request.sourcePath = path.isAbsolute(request.sourcePath)
        ? request.sourcePath
        : path.join(request.projectRoot, request.sourcePath);
      await fs.mkdir(path.dirname(request.sourcePath), { recursive: true });
      await fs.writeFile(request.sourcePath, request.latex, 'utf8');
    }
    request.assetRoots = uniqueResolvedPaths([...(request.assetRoots || []), request.projectRoot]);
    const snapshot = createCodexWorkspace(request);
    res.json(await saveWorkspace(snapshot));
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

app.post('/api/pdf/forward-locate', async (req, res) => {
  try {
    const request = req.body as SourceLineLocateRequest;
    if (!request.pdfUrl || !Number.isFinite(request.line)) {
      res.status(400).json({ error: 'pdfUrl and line are required.' });
      return;
    }
    res.json(await locateSourceLine(request));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Source line lookup failed.',
    });
  }
});

app.post('/api/papers/generate', async (req, res) => {
  try {
    const { analysis, targetJournal, modelConfig } = req.body as {
      analysis?: Awaited<ReturnType<typeof scanProject>>;
      targetJournal?: string;
      modelConfig?: { apiKey?: string; baseUrl?: string; model?: string };
      runtimeConfig?: CodexPaperCreateRequest['runtimeConfig'];
    };
    if (!analysis || !targetJournal) {
      res.status(400).json({ error: 'analysis and targetJournal are required.' });
      return;
    }
    const snapshot = await buildPaperWorkspace(analysis, targetJournal, modelConfig, req.body.runtimeConfig);
    res.json(await saveWorkspace(snapshot));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Paper generation failed.',
    });
  }
});

app.patch('/api/papers/:paperId/codex-session', async (req, res) => {
  try {
    const { sessionId, backend } = req.body as { sessionId?: string; backend?: 'texor-agent' | 'codex-cli' | 'codex-native' | 'claude-code' };
    if (!sessionId?.trim()) {
      res.status(400).json({ error: 'sessionId is required.' });
      return;
    }
    const snapshot = await updateWorkspaceCodexSession(req.params.paperId, sessionId.trim(), backend);
    if (!snapshot) {
      res.status(404).json({ error: 'Paper not found.' });
      return;
    }
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Agent session update failed.',
    });
  }
});

app.patch('/api/papers/:paperId/runtime-config', async (req, res) => {
  try {
    const request = req.body as { runtimeConfig?: CodexPaperCreateRequest['runtimeConfig'] };
    if (!request.runtimeConfig || !request.runtimeConfig.agentBackend) {
      res.status(400).json({ error: 'runtimeConfig.agentBackend is required.' });
      return;
    }
    const snapshot = await updateWorkspaceRuntimeConfig(req.params.paperId, request.runtimeConfig);
    if (!snapshot) {
      res.status(404).json({ error: 'Paper not found.' });
      return;
    }
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Runtime config update failed.',
    });
  }
});

app.post('/api/papers/:paperId/restore-version', async (req, res) => {
  try {
    const request = req.body as { versionId?: string; summary?: string };
    if (!request.versionId?.trim()) {
      res.status(400).json({ error: 'versionId is required.' });
      return;
    }
    const snapshot = await restoreWorkspaceVersion(req.params.paperId, request.versionId.trim(), request.summary);
    if (!snapshot) {
      res.status(404).json({ error: 'Version not found.' });
      return;
    }
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Version restore failed.',
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

app.post('/api/workspaces/open', async (req, res) => {
  try {
    const request = req.body as { projectRoot?: string };
    if (!request.projectRoot?.trim()) {
      res.status(400).json({ error: 'projectRoot is required.' });
      return;
    }
    const snapshot = await openWorkspaceForProjectRoot(request.projectRoot.trim());
    if (!snapshot) {
      res.status(404).json({ error: 'Workspace not found.' });
      return;
    }
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Workspace open failed.',
    });
  }
});

app.get('/api/workspaces/:paperId/export', async (req, res) => {
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const snapshot = await readWorkspace(req.params.paperId);
    if (!snapshot) {
      res.status(404).json({ error: 'Workspace not found.' });
      return;
    }
    const archive = await buildWorkspaceArchive(snapshot);
    cleanup = archive.cleanup;
    res.download(archive.archivePath, archive.filename, (error) => {
      void archive.cleanup();
      if (error && !res.headersSent) {
        res.status(500).json({ error: 'Workspace export failed.' });
      }
    });
  } catch (error) {
    await cleanup?.();
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Workspace export failed.',
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

export function startTexorServer(listenPort = port): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(listenPort, '0.0.0.0', () => {
      console.log(`texor API listening on http://0.0.0.0:${listenPort}`);
      void logDesktopServer('INFO', `texor API listening on http://0.0.0.0:${listenPort}`);
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startTexorServer();
}
