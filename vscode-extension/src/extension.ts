import * as vscode from 'vscode';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder, promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface SpawnCommand {
  executable: string;
  args: string[];
  display: string;
  shell?: boolean;
}

interface WorkspaceSnapshot {
  paper: {
    id: string;
    title: string;
    targetJournal: string;
    projectRoot?: string;
    assetRoots?: string[];
    analysis?: Partial<ProjectAnalysis>;
    codexSessionId?: string;
    codexSessionBackend?: AgentBackend;
    codexSessionUpdatedAt?: string;
    runtimeConfig?: WorkspaceRuntimeConfig;
  };
  currentVersion: {
    id: string;
    label: string;
    latex?: string;
    sourcePath?: string;
    manuscriptState?: Partial<ManuscriptState>;
    changeSummary?: Partial<VersionChangeSummary>;
  };
  versions: Array<{
    id: string;
    label: string;
    latex: string;
    sourcePath?: string;
    manuscriptState?: Partial<ManuscriptState>;
    changeSummary?: Partial<VersionChangeSummary>;
  }>;
}

interface WorkspaceSummary {
  paperId: string;
  projectRoot?: string;
  codexSessionId?: string;
  codexSessionBackend?: AgentBackend;
}

interface ModelConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: string;
  provider?: string;
  imageModel?: string;
}

type AgentBackend = 'texor-agent' | 'codex-cli' | 'codex-native' | 'claude-code';

type TaskSpeedMode = 'quick' | 'deep';

interface WorkspaceRuntimeConfig {
  agentBackend: AgentBackend;
  taskSpeedMode?: TaskSpeedMode;
  texorAgent?: ModelConfig;
  codex?: {
    model?: string;
    reasoningEffort?: string;
  };
  claude?: {
    model?: string;
  };
}

interface CodexFeedback {
  id: string;
  paperId: string;
  versionId: string;
  targetBlockId?: string;
  selectedText?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceSnippet?: string;
  issue: string;
  changeRequest: string;
  source: 'texor-web' | 'vscode';
  status: 'open' | 'accepted' | 'done' | 'dismissed';
  createdAt: string;
  updatedAt: string;
}

type BridgeCommandStatus = 'queued' | 'running' | 'done' | 'failed';

type BridgeCommandLogStream = 'system' | 'stdout' | 'stderr';

type BridgeCommandControl = 'pause' | 'terminate';

type DraftingMode = 'understand-project' | 'initial-draft' | 'continue';

type CodexTaskIntent = 'auto' | 'chat' | 'edit';

type BridgeCommandPhase =
  | 'queued'
  | 'accepted'
  | 'preparing'
  | 'connecting'
  | 'thinking'
  | 'working'
  | 'finalizing'
  | 'complete'
  | 'failed'
  | 'interrupted';

interface BridgeCommandLogEntry {
  id: string;
  time: string;
  stream: BridgeCommandLogStream;
  message: string;
}

interface CodexTaskCommandPayload {
  projectPath: string;
  targetJournal?: string;
  instruction: string;
  followupInstruction?: string;
  taskSpeedMode?: TaskSpeedMode;
  agentBackend?: AgentBackend;
  modelConfig?: ModelConfig;
  paperId?: string;
  versionId?: string;
  baseVersionId?: string;
  selectedText?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
  sourceSnippet?: string;
  source?: 'browser' | 'annotation';
  draftingMode?: DraftingMode;
  taskIntent?: CodexTaskIntent;
  windowSessionKey?: string;
  resumeSessionId?: string;
  continuedFromCommandId?: string;
}

interface CaptureActiveLatexCommandPayload {
  paperId?: string;
  title?: string;
  targetJournal?: string;
  summary?: string;
  basedOnVersionId?: string;
  projectRoot?: string;
  sourcePath?: string;
  selectedText?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
  sourceSnippet?: string;
  focusTarget?: VersionFocusTarget;
  runtimeConfig?: WorkspaceRuntimeConfig;
}

interface BridgeCommand {
  id: string;
  type: 'codex-task' | 'capture-active-latex';
  payload: CodexTaskCommandPayload | CaptureActiveLatexCommandPayload;
  status: BridgeCommandStatus;
  phase?: BridgeCommandPhase;
  message?: string;
  sessionId?: string;
  control?: BridgeCommandControl;
  controlRequestedAt?: string;
  logs: BridgeCommandLogEntry[];
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface TemplateSuggestion {
  label: string;
  publisher: string;
  templateFamily: string;
}

interface ProjectCommandHint {
  command: string;
  source: string;
  reason: string;
}

interface ProjectDossier {
  agentBrief: string;
  entryPoints: string[];
  experimentFiles: string[];
  figureScripts: string[];
  datasetHints: string[];
  metricHints: string[];
  commandHints: ProjectCommandHint[];
  openQuestions: string[];
}

interface ProjectAnalysis {
  rootPath: string;
  projectName: string;
  overview: string;
  purpose: string;
  methods: string[];
  results: string[];
  recommendedSections: string[];
  languageBreakdown: Array<{ label: string; value: number }>;
  importantFiles: Array<{ path: string; reason: string; snippet: string }>;
  resultArtifacts: Array<{ path: string; kind: string; summary: string; preview?: string[][] }>;
  ingestNotes: string[];
  rawEvidence: string[];
  dossier: ProjectDossier;
  gitContext: {
    isRepo: boolean;
    branch?: string;
    head?: string;
    commits: Array<{ hash: string; date: string; subject: string }>;
  };
}

interface ManuscriptRegion {
  kind: 'abstract' | 'section' | 'subsection' | 'subsubsection' | 'figure' | 'table' | 'bibliography';
  title: string;
  label?: string;
  lineStart: number;
  lineEnd: number;
  wordCount: number;
  snippet: string;
}

interface ManuscriptAsset {
  kind: 'figure' | 'table';
  label?: string;
  caption?: string;
  line: number;
  referenceCount: number;
  assetPath?: string;
  assetPaths?: string[];
  missingAssetPaths?: string[];
  assetExists?: boolean;
}

interface ManuscriptCitation {
  key: string;
  count: number;
  firstLine: number;
}

interface ManuscriptTodo {
  kind: 'todo' | 'tbd' | 'citation-gap' | 'evidence-gap' | 'missing-asset';
  line: number;
  text: string;
  regionTitle?: string;
}

interface ManuscriptState {
  schemaVersion: number;
  extractedAt: string;
  sectionMap: ManuscriptRegion[];
  figures: ManuscriptAsset[];
  tables: ManuscriptAsset[];
  labels: Array<{
    key: string;
    kind: 'figure' | 'table' | 'section' | 'equation' | 'algorithm' | 'other';
    line: number;
  }>;
  citations: ManuscriptCitation[];
  todos: ManuscriptTodo[];
  unresolvedEvidenceGaps: string[];
  stats: {
    wordCount: number;
    sectionCount: number;
    figureCount: number;
    tableCount: number;
    citationCount: number;
    todoCount: number;
    missingAssetCount: number;
  };
}

interface VersionChangeSummary {
  summary: string;
  touchedRegions: string[];
  addedTodos: string[];
  removedTodos: string[];
}

interface VersionFocusTarget {
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
  selectedText?: string;
  pageHint?: number;
  regionTitle?: string;
}

const stateKeys = {
  paperId: 'texor.paperId',
  versionId: 'texor.versionId',
  activeFeedbackId: 'texor.activeFeedbackId',
  manuscriptPath: 'texor.manuscriptPath',
};

const texorManuscriptRelativePath = path.join('.texor', 'manuscript', 'main.tex');
const BRIDGE_POLL_INTERVAL_MS = 250;
const FEEDBACK_POLL_INTERVAL_MS = 2000;
const POST_COMPLETION_GRACE_MS = 250;

const notifiedFeedbackIds = new Set<string>();
let feedbackTimer: ReturnType<typeof setInterval> | undefined;
let pollingFeedback = false;
let bridgeTimer: ReturnType<typeof setInterval> | undefined;
let pollingBridge = false;
const activeBridgeProjects = new Set<string>();
let lastBridgeConnectionErrorAt = 0;
let texorServerProcess: ReturnType<typeof spawn> | undefined;
let runtimeServerUrl: string | undefined;
let runtimeWebUrl: string | undefined;
let writableWorkspaceCheckCache = new Map<string, number>();
let cachedCodexExecutable: string | null = null;
let cachedClaudeExecutable: string | null = null;
const windowsCliDecoder = process.platform === 'win32' ? new TextDecoder('gb18030') : null;

function config() {
  return vscode.workspace.getConfiguration('texor');
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function configuredServerUrl(): string {
  return config().get<string>('serverUrl', 'http://127.0.0.1:4174').replace(/\/$/, '');
}

function configuredWebUrl(): string {
  return config().get<string>('webUrl', 'http://127.0.0.1:4174').replace(/\/$/, '');
}

function serverUrl(): string {
  return normalizeBaseUrl(runtimeServerUrl || configuredServerUrl());
}

function webUrl(): string {
  return normalizeBaseUrl(runtimeWebUrl || configuredWebUrl());
}

function appPath(): string {
  return config().get<string>('appPath', '') || path.resolve(__dirname, '..', '..');
}

function bundledAppPath(context?: vscode.ExtensionContext): string {
  return context?.extensionPath || appPath();
}

function codexExecutable(): string {
  return config().get<string>('codexExecutable', 'codex');
}

function codexModel(payload?: ModelConfig): string {
  return (payload?.model || config().get<string>('codexModel', 'gpt-5.4')).trim();
}

function codexReasoningEffort(payload?: ModelConfig): string {
  return (payload?.reasoningEffort || config().get<string>('codexReasoningEffort', 'xhigh')).trim();
}

function claudeExecutable(): string {
  return config().get<string>('claudeExecutable', 'claude');
}

function claudeModel(payload?: ModelConfig): string {
  return (payload?.model || config().get<string>('claudeModel', '')).trim();
}

function texorAgentModelConfig(payload?: ModelConfig): ModelConfig {
  return {
    provider: payload?.provider || config().get<string>('agentProvider', 'OpenAI-compatible'),
    baseUrl: payload?.baseUrl || config().get<string>('agentBaseUrl', 'https://api.openai.com/v1'),
    model: payload?.model || config().get<string>('agentModel', 'gpt-4.1-mini'),
    imageModel: payload?.imageModel || config().get<string>('agentImageModel', 'gpt-image-1'),
    apiKey: payload?.apiKey || config().get<string>('agentApiKey', '') || process.env.OPENAI_API_KEY || '',
  };
}

function buildWorkspaceRuntimeConfig(
  backend: AgentBackend,
  taskSpeedMode?: TaskSpeedMode,
  modelConfig?: ModelConfig,
): WorkspaceRuntimeConfig {
  return {
    agentBackend: backend,
    taskSpeedMode,
    texorAgent: backend === 'texor-agent' ? texorAgentModelConfig(modelConfig) : undefined,
    codex: isCodexBackend(backend)
      ? {
          model: codexModel(modelConfig),
          reasoningEffort: codexReasoningEffort(modelConfig),
        }
      : undefined,
    claude: backend === 'claude-code'
      ? {
          model: claudeModel(modelConfig),
        }
      : undefined,
  };
}

function backendLabel(backend: AgentBackend): string {
  if (backend === 'texor-agent') {
    return 'TEXOR Agent';
  }
  if (backend === 'claude-code') {
    return 'Claude Code';
  }
  if (backend === 'codex-native') {
    return 'Codex Native';
  }
  return 'Codex';
}

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || appPath();
}

function manuscriptPathForWorkspace(rootPath: string): string {
  return path.join(rootPath, texorManuscriptRelativePath);
}

async function assertWritableProjectWorkspace(rootPath: string): Promise<void> {
  const cachedAt = writableWorkspaceCheckCache.get(rootPath);
  if (cachedAt && Date.now() - cachedAt < 30_000) {
    return;
  }
  const stat = await fs.stat(rootPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`项目路径不存在或不是目录: ${rootPath}`);
  }
  const manuscriptDir = path.dirname(manuscriptPathForWorkspace(rootPath));
  await fs.mkdir(manuscriptDir, { recursive: true });
  const probeFile = path.join(manuscriptDir, `.write-check-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(probeFile, 'ok', 'utf8');
  await fs.unlink(probeFile).catch(() => undefined);
  writableWorkspaceCheckCache.set(rootPath, Date.now());
}

function hasFullLatexDocument(latex: string): boolean {
  return /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(latex) && /\\begin\{document\}/.test(latex) && /\\end\{document\}/.test(latex);
}

function latexNonWhitespaceLength(latex: string): number {
  return latex.replace(/\s+/g, '').length;
}

function normalizeSelectedScopeText(text?: string): string {
  if (!text) {
    return '';
  }
  const selectedLine = text
    .split('\n')
    .find((line) => line.startsWith('已选文字:'))
    ?.replace(/^已选文字:\s*/, '')
    .trim();
  return (selectedLine || text).replace(/\s+/g, ' ').trim();
}

function normalizeLatexForScopeCheck(content: string): string {
  return content
    .replace(/\r/g, '')
    .replace(/[{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildScopeSearchRegex(selectedText: string): RegExp | null {
  const tokens = selectedText.match(/[A-Za-z0-9%+./:-]+|[\u4e00-\u9fff]+/g);
  if (!tokens || tokens.length < 3) {
    return null;
  }
  return new RegExp(tokens.slice(0, 48).map(escapedRegex).join('[\\s~\\\\{}\\[\\](),.;:!?\\-]*'), 'i');
}

function locateSelectedScope(baseLatex: string, selectedText?: string, sourceLine?: number): { start: number; end: number } | null {
  const resolvedSelection = normalizeSelectedScopeText(selectedText);
  const normalizedSelection = normalizeLatexForScopeCheck(resolvedSelection);
  const lines = baseLatex.replace(/\r/g, '').split('\n');
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }
  const searchWindows: Array<{ start: number; end: number; text: string }> = [];
  if (sourceLine && sourceLine > 0) {
    const startLine = Math.max(0, sourceLine - 5);
    const endLine = Math.min(lines.length, sourceLine + 4);
    const start = offsets[startLine] ?? 0;
    const end = endLine >= lines.length ? baseLatex.length : (offsets[endLine] ?? baseLatex.length);
    searchWindows.push({ start, end, text: baseLatex.slice(start, end) });
  }
  searchWindows.push({ start: 0, end: baseLatex.length, text: baseLatex });

  if (normalizedSelection) {
    for (const window of searchWindows) {
      const exactIndex = window.text.indexOf(resolvedSelection);
      if (exactIndex >= 0) {
        return { start: window.start + exactIndex, end: window.start + exactIndex + resolvedSelection.length };
      }
      const regex = buildScopeSearchRegex(resolvedSelection);
      if (regex) {
        const match = window.text.match(regex);
        if (match?.index !== undefined) {
          return { start: window.start + match.index, end: window.start + match.index + match[0].length };
        }
      }
      const normalizedWindow = normalizeLatexForScopeCheck(window.text);
      if (normalizedWindow && normalizedWindow.includes(normalizedSelection.slice(0, Math.min(40, normalizedSelection.length)))) {
        return { start: window.start, end: window.end };
      }
    }
  }

  if (sourceLine && sourceLine > 0) {
    const lineIndex = Math.min(lines.length - 1, Math.max(0, sourceLine - 1));
    const startLine = Math.max(0, lineIndex - 2);
    const endLine = Math.min(lines.length, lineIndex + 3);
    const start = offsets[startLine] ?? 0;
    const end = endLine >= lines.length ? baseLatex.length : (offsets[endLine] ?? baseLatex.length);
    return { start, end };
  }
  return null;
}

function scopedEditExceeded(
  candidate: string,
  baseVersion?: WorkspaceSnapshot['currentVersion'],
  selectedText?: string,
  sourceLine?: number,
): boolean {
  if (!baseVersion?.latex || !selectedText?.trim()) {
    return false;
  }
  const scope = locateSelectedScope(baseVersion.latex, selectedText, sourceLine);
  if (!scope) {
    return false;
  }
  const buffer = 220;
  const before = baseVersion.latex;
  const candidateText = candidate;
  const protectedStart = Math.max(0, scope.start - buffer);
  const protectedEnd = Math.min(before.length, scope.end + buffer);
  const beforePrefix = before.slice(0, protectedStart);
  const afterPrefix = candidateText.slice(0, protectedStart);
  const beforeSuffix = before.slice(protectedEnd);
  const afterSuffix = candidateText.slice(Math.max(0, candidateText.length - beforeSuffix.length));
  return beforePrefix !== afterPrefix || beforeSuffix !== afterSuffix;
}

function versionForPayload(snapshot: WorkspaceSnapshot | null, payload: { basedOnVersionId?: string; paperId?: string }): WorkspaceSnapshot['currentVersion'] | undefined {
  if (!snapshot || (payload.paperId && payload.paperId !== snapshot.paper.id)) {
    return undefined;
  }
  const versionId = payload.basedOnVersionId || snapshot.currentVersion.id;
  return snapshot.versions.find((entry) => entry.id === versionId) || snapshot.currentVersion;
}

function validateSubmittedLatex(
  candidate: string,
  baseVersion?: WorkspaceSnapshot['currentVersion'],
  options: { selectedText?: string; sourceLine?: number; enforceLocalScope?: boolean } = {},
): void {
  if (!candidate.trim()) {
    throw new Error('Codex did not leave a manuscript to save.');
  }
  if (!hasFullLatexDocument(candidate)) {
    throw new Error('Codex output is not a complete LaTeX document, so texor refused to save it as a new paper version.');
  }
  const normalized = candidate.toLowerCase();
  const forbiddenSignals = [
    'texor',
    'browser ui',
    'codex feedback',
    '.texor',
    'routing labels',
    'agent runtime',
  ];
  const leaked = forbiddenSignals.find((signal) => normalized.includes(signal));
  if (leaked) {
    throw new Error(`Codex output leaked internal control text (${leaked}), so texor refused to save it as a paper version.`);
  }
  if (baseVersion?.latex && hasFullLatexDocument(baseVersion.latex)) {
    const baseLength = latexNonWhitespaceLength(baseVersion.latex);
    const nextLength = latexNonWhitespaceLength(candidate);
    if (baseLength > 1200 && nextLength < baseLength * 0.72) {
      throw new Error('Codex output is much shorter than the selected base version. texor refused to save it to prevent accidental manuscript loss.');
    }
  }
  if (options.enforceLocalScope && scopedEditExceeded(candidate, baseVersion, options.selectedText, options.sourceLine)) {
    throw new Error('This revision exceeded the selected local scope, so texor refused to save it as a new version.');
  }
}

async function captureFailedDraft(rootPath: string, manuscriptPath: string): Promise<{
  draftPath?: string;
  excerpt?: string;
  bytes?: number;
} | null> {
  const latex = await fs.readFile(manuscriptPath, 'utf8').catch(() => '');
  if (!latex.trim()) {
    return null;
  }
  const failedDraftDir = path.join(rootPath, '.texor', 'manuscript', 'failed-drafts');
  await fs.mkdir(failedDraftDir, { recursive: true });
  const failedDraftPath = path.join(failedDraftDir, `draft-${new Date().toISOString().replace(/[:.]/g, '-')}.tex`);
  await fs.writeFile(failedDraftPath, latex, 'utf8');
  return {
    draftPath: failedDraftPath,
    excerpt: compactReadableText(latex, 1200),
    bytes: Buffer.byteLength(latex, 'utf8'),
  };
}

interface WorkspaceFileSnapshotEntry {
  relativePath: string;
  isFile: boolean;
  mtimeMs: number;
  size: number;
}

async function captureWorkspaceFileSnapshot(
  rootPath: string,
  options: { trackedPaths?: string[] } = {},
): Promise<Map<string, WorkspaceFileSnapshotEntry>> {
  const snapshot = new Map<string, WorkspaceFileSnapshotEntry>();
  const trackedPaths = [...new Set((options.trackedPaths || []).map((entry) => normalizeProjectRelativePath(entry)).filter(Boolean))];
  if (trackedPaths.length > 0) {
    for (const relativePath of trackedPaths) {
      const absolutePath = path.join(rootPath, relativePath);
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat) {
        continue;
      }
      snapshot.set(relativePath, {
        relativePath,
        isFile: stat.isFile(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
    return snapshot;
  }
  const queue = ['.'];
  while (queue.length > 0) {
    const current = queue.pop() || '.';
    const absolute = current === '.' ? rootPath : path.join(rootPath, current);
    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      const relativePath = current === '.' ? entry.name : path.join(current, entry.name);
      const normalized = normalizeProjectRelativePath(relativePath);
      const absolutePath = path.join(rootPath, relativePath);
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat) {
        continue;
      }
      snapshot.set(normalized, {
        relativePath: normalized,
        isFile: entry.isFile(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
      if (entry.isDirectory()) {
        queue.push(relativePath);
      }
    }
  }
  return snapshot;
}

function trackedPathsForExecution(
  policy: TaskExecutionPolicy,
  route: TexorAgentRoute,
  state?: Partial<ManuscriptState>,
  analysis?: Partial<ProjectAnalysis>,
): string[] | undefined {
  if (policy.profile === 'project-execution') {
    return undefined;
  }
  const tracked = new Set<string>();
  for (const relativePath of texorAgentWritablePaths(policy, route, state, analysis)) {
    tracked.add(normalizeProjectRelativePath(relativePath));
  }
  return [...tracked];
}

function changedWorkspaceFiles(
  before: Map<string, WorkspaceFileSnapshotEntry>,
  after: Map<string, WorkspaceFileSnapshotEntry>,
): string[] {
  const changed = new Set<string>();
  for (const [relativePath, nextEntry] of after.entries()) {
    const previous = before.get(relativePath);
    if (!previous || previous.mtimeMs !== nextEntry.mtimeMs || previous.size !== nextEntry.size) {
      changed.add(relativePath);
    }
  }
  return [...changed];
}

function invalidWorkspaceWrites(
  changedFiles: string[],
  policy: TaskExecutionPolicy,
  route: TexorAgentRoute,
  state?: Partial<ManuscriptState>,
  analysis?: Partial<ProjectAnalysis>,
): string[] {
  return changedFiles.filter((relativePath) => !isPathAllowedForWrite(policy, route, relativePath, state, analysis));
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function preferWindowsCodexLauncher(candidate: string): Promise<string> {
  if (process.platform !== 'win32') {
    return candidate;
  }
  const normalized = candidate.trim().replace(/^"(.*)"$/, '$1');
  if (!normalized.toLowerCase().endsWith('.ps1')) {
    return normalized;
  }
  const parsed = path.parse(normalized);
  for (const extension of ['.cmd', '.exe', '.bat']) {
    const sibling = path.join(parsed.dir, `${parsed.name}${extension}`);
    if (await fileExists(sibling)) {
      return sibling;
    }
  }
  return normalized;
}

function currentCodexPlatformFolders(): string[] {
  const arch = process.arch;
  if (process.platform === 'win32') {
    return arch === 'arm64'
      ? ['win32-arm64', 'win32-x64', 'windows-arm64', 'windows-x64', 'win32', 'windows']
      : ['win32-x64', 'win32-arm64', 'windows-x64', 'windows-arm64', 'win32', 'windows'];
  }
  if (process.platform === 'darwin') {
    return arch === 'arm64'
      ? ['darwin-arm64', 'darwin-x64', 'macos-arm64', 'macos-x64', 'darwin', 'macos']
      : ['darwin-x64', 'darwin-arm64', 'macos-x64', 'macos-arm64', 'darwin', 'macos'];
  }
  if (process.platform === 'linux') {
    return arch === 'arm64'
      ? ['linux-arm64', 'linux-aarch64', 'alpine-arm64', 'linux']
      : ['linux-x64', 'linux-x86_64', 'linux-amd64', 'alpine-x64', 'linux'];
  }
  return [];
}

function candidateMatchesCurrentPlatform(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  const folders = currentCodexPlatformFolders();
  if (normalized.includes('/bin/')) {
    const match = normalized.match(/\/bin\/([^/]+)\//);
    if (match) {
      return folders.includes(match[1]);
    }
  }
  if (process.platform === 'win32') {
    return /\.(exe|cmd|bat|ps1)$/i.test(candidate);
  }
  return !/\.(exe|cmd|bat|ps1)$/i.test(candidate);
}

function candidatePreferredPlatformRank(candidate: string): number {
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  const folders = currentCodexPlatformFolders();
  const match = normalized.match(/\/bin\/([^/]+)\//);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  const index = folders.indexOf(match[1]);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function candidateIsCodexBinary(entryName: string): boolean {
  if (process.platform === 'win32') {
    return /^codex(?:\.exe|\.cmd|\.bat|\.ps1)?$/i.test(entryName);
  }
  return /^codex$/i.test(entryName);
}

async function firstUsableCodexCandidate(candidates: string[]): Promise<string | null> {
  const normalizedCandidates = await Promise.all(
    candidates
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => preferWindowsCodexLauncher(entry)),
  );
  const usable = normalizedCandidates.filter(candidateMatchesCurrentPlatform);
  const preferred = usable.find((entry) => !isCodexPowerShellShim(entry)) || usable[0];
  if (preferred && (await fileExists(preferred))) {
    return preferred;
  }
  return null;
}

async function installOpenAICodexExtension(): Promise<boolean> {
  const candidateIds = [
    'openai.chatgpt',
  ];
  for (const extensionId of candidateIds) {
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', extensionId);
      return true;
    } catch {
      // Try next candidate id.
    }
  }
  return false;
}

function decodeProcessOutput(chunks: Buffer[]): string {
  if (!chunks.length) {
    return '';
  }
  const combined = Buffer.concat(chunks);
  const utf8 = combined.toString('utf8');
  if (!windowsCliDecoder || !/[�锟]/.test(utf8)) {
    return utf8;
  }
  try {
    const decoded = windowsCliDecoder.decode(combined);
    return decoded || utf8;
  } catch {
    return utf8;
  }
}

async function findCodexBinaryInTree(root: string, depth = 3): Promise<string | null> {
  if (depth < 0) {
    return null;
  }

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const sortedEntries = [...entries].sort((left, right) => {
    const leftPath = path.join(root, left.name);
    const rightPath = path.join(root, right.name);
    const leftRank = left.isDirectory() ? candidatePreferredPlatformRank(`${leftPath}${path.sep}codex`) : candidatePreferredPlatformRank(leftPath);
    const rightRank = right.isDirectory() ? candidatePreferredPlatformRank(`${rightPath}${path.sep}codex`) : candidatePreferredPlatformRank(rightPath);
    return leftRank - rightRank || left.name.localeCompare(right.name);
  });

  for (const entry of sortedEntries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && candidateIsCodexBinary(entry.name) && candidateMatchesCurrentPlatform(candidate) && (await fileExists(candidate))) {
      return preferWindowsCodexLauncher(candidate);
    }
    if (entry.isDirectory()) {
      if (candidate.includes(path.sep + 'bin' + path.sep) && !candidateMatchesCurrentPlatform(path.join(candidate, 'codex'))) {
        continue;
      }
      const nested = await findCodexBinaryInTree(candidate, depth - 1);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

async function resolveCodexExecutable(allowInstall = true): Promise<string> {
  if (cachedCodexExecutable) {
    return cachedCodexExecutable;
  }
  const configured = codexExecutable().trim();
  const candidates = configured && configured !== 'codex' ? [configured, 'codex'] : ['codex'];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
      if (await fileExists(candidate)) {
        const normalizedCandidate = await preferWindowsCodexLauncher(candidate);
        if (candidateMatchesCurrentPlatform(normalizedCandidate)) {
          cachedCodexExecutable = normalizedCandidate;
          return normalizedCandidate;
        }
      }
      continue;
    }

    try {
      const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
      const { stdout } = await execFileAsync(lookup, [candidate]);
      const first = await firstUsableCodexCandidate(
        stdout
          .trim()
          .split(/\r?\n/)
          .filter(Boolean),
      );
      if (first) {
        cachedCodexExecutable = first;
        return first;
      }
    } catch {
      // Fall through to extension-path detection.
    }
  }

  const openaiExtensions = vscode.extensions.all.filter((extension) => extension.id.toLowerCase().includes('openai.chatgpt'));
  for (const extension of openaiExtensions) {
    const binDir = path.join(extension.extensionPath, 'bin');
    const found = await findCodexBinaryInTree(binDir, 4);
    if (found) {
      cachedCodexExecutable = found;
      return found;
    }
  }

  const serverExtensionRoot = path.join(os.homedir(), '.vscode-server', 'extensions');
  const localExtensionRoot = path.join(os.homedir(), '.vscode', 'extensions');
  for (const root of [serverExtensionRoot, localExtensionRoot]) {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().includes('openai.chatgpt')) {
        continue;
      }
      const found = await findCodexBinaryInTree(path.join(root, entry.name, 'bin'), 4);
      if (found) {
        cachedCodexExecutable = found;
        return found;
      }
    }
  }

  const installed = allowInstall ? await installOpenAICodexExtension() : false;
  if (installed) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return await resolveCodexExecutable(false);
  }

  throw new Error(
    'Unable to locate the Codex CLI. Set texor.codexExecutable to the full path, or install the OpenAI ChatGPT/Codex extension.',
  );
}

function codexSpawnCommand(executable: string, args: string[]): SpawnCommand {
  if (process.platform !== 'win32') {
    return {
      executable,
      args,
      display: executable,
    };
  }

  const lowerExecutable = executable.toLowerCase();
  if (lowerExecutable.endsWith('.ps1')) {
    return {
      executable: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args],
      display: `powershell.exe -File ${executable}`,
    };
  }

  if (lowerExecutable.endsWith('.cmd') || lowerExecutable.endsWith('.bat')) {
    return {
      executable,
      args,
      display: executable,
      shell: true,
    };
  }

  return {
    executable,
    args,
    display: executable,
  };
}

function isCodexPowerShellShim(candidate: string): boolean {
  return process.platform === 'win32' && candidate.toLowerCase().endsWith('.ps1');
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${serverUrl()}${path}`, {
      headers: {
        'Content-Type': 'application/json',
      },
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error || `texor request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`texor request timed out: ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithTimeout(url: string, timeoutMs = 2_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function workbenchHealthyAt(baseUrl: string): Promise<boolean> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const health = await fetchWithTimeout(`${normalized}/api/health`);
    if (!health.ok) {
      return false;
    }

    const root = await fetchWithTimeout(`${normalized}/`);
    if (!root.ok) {
      return false;
    }
    const html = await root.text();
    return html.includes('id="root"') && html.includes('type="module"');
  } catch {
    return false;
  }
}

async function portAcceptsConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function chooseWorkbenchUrl(preferredBaseUrl: string): Promise<{ url: string; reuse: boolean }> {
  const preferred = new URL(preferredBaseUrl);
  const host = preferred.hostname === '0.0.0.0' ? '127.0.0.1' : preferred.hostname;
  const startPort = Number(preferred.port || (preferred.protocol === 'https:' ? 443 : 80));

  for (let port = startPort; port < startPort + 30; port += 1) {
    const candidate = `${preferred.protocol}//${host}:${port}`;
    if (await workbenchHealthyAt(candidate)) {
      return { url: candidate, reuse: true };
    }
    if (!(await portAcceptsConnection(host, port))) {
      return { url: candidate, reuse: false };
    }
  }

  return { url: `${preferred.protocol}//${host}:${startPort}`, reuse: false };
}

async function backendHealthy(): Promise<boolean> {
  return workbenchHealthyAt(serverUrl());
}

function showError(error: unknown): void {
  vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}

function bridgeLog(stream: BridgeCommandLogStream, message: string): BridgeCommandLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: new Date().toISOString(),
    stream,
    message: message.length > 12000 ? `${message.slice(-12000)}` : message,
  };
}

async function updateBridgeCommand(
  commandId: string,
  status?: BridgeCommandStatus,
  options: {
    phase?: BridgeCommandPhase;
    message?: string;
    sessionId?: string;
    control?: BridgeCommandControl | null;
    result?: Record<string, unknown>;
    error?: string;
    logs?: BridgeCommandLogEntry[];
  } = {},
): Promise<BridgeCommand> {
  return request<BridgeCommand>(`/api/bridge/commands/${commandId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, ...options }),
  });
}

async function createBridgeCommandRequest(payload: {
  type: BridgeCommand['type'];
  payload: CodexTaskCommandPayload | CaptureActiveLatexCommandPayload;
}): Promise<BridgeCommand> {
  return request<BridgeCommand>('/api/bridge/commands', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function claimBridgeCommand(commandId: string): Promise<BridgeCommand | null> {
  try {
    return await request<BridgeCommand>(`/api/bridge/commands/${commandId}/claim`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('409')) {
      return null;
    }
    return null;
  }
}

async function readBridgeCommand(commandId: string): Promise<BridgeCommand | null> {
  try {
    return await request<BridgeCommand>(`/api/bridge/commands/${commandId}`);
  } catch {
    return null;
  }
}

function backendFromCommandPayload(payload: CodexTaskCommandPayload): AgentBackend {
  if (payload.agentBackend) {
    return payload.agentBackend;
  }
  if (payload.modelConfig?.apiKey) {
    return 'texor-agent';
  }
  return 'codex-cli';
}

function snapshotMatchesCommand(snapshot: WorkspaceSnapshot | null, payload: CodexTaskCommandPayload): boolean {
  if (!snapshot) {
    return false;
  }
  if (payload.paperId) {
    return payload.paperId === snapshot.paper.id;
  }
  const snapshotRoot = snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath;
  if (!snapshotRoot) {
    return false;
  }
  return path.resolve(payload.projectPath) === path.resolve(snapshotRoot);
}

function normalizeProjectExecutionKey(projectPath?: string): string {
  return projectPath ? path.resolve(projectPath) : '';
}

function commandProjectExecutionKey(command: BridgeCommand): string {
  const payload = command.payload as Partial<CodexTaskCommandPayload & CaptureActiveLatexCommandPayload>;
  return normalizeProjectExecutionKey(payload.projectPath || payload.projectRoot);
}

async function recentSessionForCommand(command: BridgeCommand, snapshot: WorkspaceSnapshot | null = null): Promise<string | undefined> {
  const payload = command.payload as CodexTaskCommandPayload;
  const backend = backendFromCommandPayload(payload);
  if (payload.resumeSessionId) {
    return payload.resumeSessionId;
  }
  const snapshotBackend =
    snapshot?.paper.runtimeConfig?.agentBackend ||
    snapshot?.paper.codexSessionBackend ||
    (snapshot?.paper.codexSessionId?.startsWith('texor-agent:')
      ? 'texor-agent'
      : snapshot?.paper.codexSessionId?.startsWith('claude-code:')
        ? 'claude-code'
        : undefined);
  if (snapshotMatchesCommand(snapshot, payload) && snapshot?.paper.codexSessionId && snapshotBackend === backend) {
    return snapshot.paper.codexSessionId;
  }
  if (!payload.paperId && !payload.projectPath) {
    return undefined;
  }
  const params = new URLSearchParams({ limit: '20' });
  if (payload.paperId) {
    params.set('paperId', payload.paperId);
  }
  if (payload.projectPath) {
    params.set('projectPath', payload.projectPath);
  }
  const commands = await request<BridgeCommand[]>(`/api/bridge/commands?${params.toString()}`).catch(() => []);
  const candidates = commands
    .filter((entry) => entry.id !== command.id && entry.type === 'codex-task')
    .filter((entry) => backendFromCommandPayload(entry.payload as CodexTaskCommandPayload) === backend)
    .filter((entry) => {
      if (backend !== 'codex-native') {
        return true;
      }
      const entryPayload = entry.payload as CodexTaskCommandPayload;
      if (payload.windowSessionKey?.trim()) {
        return entryPayload.windowSessionKey?.trim() === payload.windowSessionKey.trim();
      }
      return !entryPayload.windowSessionKey?.trim();
    })
    .filter((entry) => entry.sessionId || typeof entry.result?.sessionId === 'string')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const latest = candidates[candidates.length - 1];
  return latest?.sessionId || (latest?.result?.sessionId as string | undefined);
}

async function updatePaperCodexSession(paperId: string | undefined, sessionId: string | undefined, backend?: AgentBackend): Promise<void> {
  if (!paperId || !sessionId) {
    return;
  }
  await request<WorkspaceSnapshot>(`/api/papers/${paperId}/codex-session`, {
    method: 'PATCH',
    body: JSON.stringify({ sessionId, backend }),
  }).catch(() => undefined);
}

async function updateBridgeProgress(commandId: string, phase: BridgeCommandPhase, message: string): Promise<void> {
  await updateBridgeCommand(commandId, 'running', {
    phase,
    message,
  }).catch(() => undefined);
}

interface CodexExecResult {
  output: string;
  answer?: string;
  sessionId?: string;
  interruptedBy?: BridgeCommandControl;
}

interface TexorAgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface TexorAgentToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

interface TexorAgentModelResponse {
  content: string;
}

interface TexorAgentToolContext {
  route: TexorAgentRoute;
  taskSpeedMode: TaskSpeedMode;
  executionPolicy: TaskExecutionPolicy;
  analysis?: Partial<ProjectAnalysis>;
  manuscriptState?: Partial<ManuscriptState>;
}

type TexorAgentRoute =
  | 'quick-polish'
  | 'full-revision'
  | 'structure-diagram'
  | 'result-figure'
  | 'references'
  | 'general';

type TaskExecutionProfile =
  | 'quick-local-edit'
  | 'manuscript-edit'
  | 'reference-research'
  | 'diagram-generation'
  | 'project-execution';

type TaskExecutionScope = 'foreground' | 'background';

type ProjectContextLoadMode = 'none' | 'existing-only' | 'ensure';

interface TaskExecutionPolicy {
  route: TexorAgentRoute;
  profile: TaskExecutionProfile;
  requestedSpeedMode: TaskSpeedMode;
  speedMode: TaskSpeedMode;
  scope: TaskExecutionScope;
  timeoutMs: number;
  maxSteps: number;
  loadProjectContext: ProjectContextLoadMode;
  refreshProjectAnalysis: boolean;
  resumeSession: boolean;
  useEphemeralSession: boolean;
  allowProjectCommands: boolean;
  allowFigureGeneration: boolean;
  allowPaperSearch: boolean;
  stopAfterFirstWrite: boolean;
  preferDirectQuickEdit: boolean;
  includeConversationMemory: boolean;
}

function isCodexBackend(backend: AgentBackend): boolean {
  return backend === 'codex-cli' || backend === 'codex-native';
}

interface TexorAgentMemoryEntry {
  id: string;
  time: string;
  route: TexorAgentRoute;
  instruction: string;
  targetJournal?: string;
  sourceFile?: string;
  selectedText?: string;
  summary: string;
}

interface CodexReadableLog {
  stream: BridgeCommandLogStream;
  message: string;
}

interface FailureDiagnosis {
  category:
    | 'auth'
    | 'codex-not-found'
    | 'wrong-platform-binary'
    | 'powershell-shim'
    | 'timeout'
    | 'tool-write-failure'
    | 'template-download'
    | 'network'
    | 'unknown';
  summary: string;
  detail: string;
  suggestion?: string;
}

function diagnoseFailure(message: string, backend?: AgentBackend): FailureDiagnosis {
  const normalized = message
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  const lower = normalized.toLowerCase();
  const endpoint = extractFailureEndpoint(normalized);
  const endpointHost = extractFailureHost(endpoint);

  if (
    lower.includes('texor agent model request failed: 401') ||
    lower.includes('texor agent model request failed: 403') ||
    lower.includes('image generation failed: 401') ||
    lower.includes('image generation failed: 403') ||
    (backend === 'texor-agent' && (lower.includes('authentication') || lower.includes('unauthorized'))) ||
    (backend === 'claude-code' && (lower.includes('authentication') || lower.includes('unauthorized') || lower.includes('anthropic'))) ||
    lower.includes('api key') && lower.includes('required')
  ) {
    return {
      category: 'auth',
      summary: backend === 'claude-code' ? 'Claude Code 登录失效或权限不足' : '用户模型 API 认证失败',
      detail: normalized,
      suggestion: backend === 'claude-code'
        ? '请在 Claude Code CLI 中重新登录，或检查 Anthropic 相关配置后重试。'
        : '请检查 Base URL、API Key、模型名和账号权限，然后重试。',
    };
  }
  if (lower.includes('authentication') || lower.includes('unauthorized')) {
    return {
      category: 'auth',
      summary: backend === 'claude-code' ? 'Claude Code 登录失效或权限不足' : 'Codex 登录失效或权限不足',
      detail: normalized,
      suggestion: backend === 'claude-code'
        ? '请在 Claude Code CLI 里重新登录，然后重试。'
        : '请在 VSCode 的 OpenAI/Codex 扩展里重新登录，然后重试。',
    };
  }
  if (lower.includes('503 service unavailable') || lower.includes('service temporarily unavailable')) {
    const serviceName =
      backend === 'claude-code'
        ? 'Claude Code 上游服务暂时不可用'
        : backend === 'texor-agent'
          ? '模型服务暂时不可用'
          : 'Codex 上游服务暂时不可用';
    return {
      category: 'network',
      summary: serviceName,
      detail: normalized,
      suggestion: endpointHost
        ? `上游接口 ${endpointHost} 当前返回 503，请稍后重试。`
        : '上游接口当前返回 503，请稍后重试。',
    };
  }
  if (lower.includes('timed out')) {
    return {
      category: 'timeout',
      summary: '任务执行超时',
      detail: normalized,
      suggestion: '可以点击“继续撰写”从当前会话接着跑，或缩小本轮任务范围。',
    };
  }
  if (backend === 'claude-code' && (lower.includes('unable to locate the claude code cli') || lower.includes('texor.claudeexecutable'))) {
    return {
      category: 'codex-not-found',
      summary: '没有找到 Claude Code 可执行文件',
      detail: normalized,
      suggestion: '请安装 Claude Code CLI，或把 texor.claudeExecutable 指向可执行文件。',
    };
  }
  if (lower.includes('enoent')) {
    if (backend === 'claude-code') {
      return {
        category: 'codex-not-found',
        summary: '没有找到 Claude Code 可执行文件',
        detail: normalized,
        suggestion: '请安装 Claude Code CLI，或把 texor.claudeExecutable 指向可执行文件。',
      };
    }
    if ((lower.includes('linux-x86_64') || lower.includes('linux-x64') || lower.includes('darwin-')) && process.platform === 'win32') {
      return {
        category: 'wrong-platform-binary',
        summary: '误选了错误平台的 Codex 可执行文件',
        detail: normalized,
        suggestion: '请检查 texor.codexExecutable，确保它指向 Windows 版 codex.exe 或 codex.cmd。',
      };
    }
    return {
      category: 'codex-not-found',
      summary: '没有找到 Codex 可执行文件',
      detail: normalized,
      suggestion: '请安装 OpenAI/Codex VSCode 扩展，或手动设置 texor.codexExecutable。',
    };
  }
  if (lower.includes('codex.ps1') && (lower.includes('invalidargument') || lower.includes('psargumentexception') || lower.includes('fullyqualifiederrorid'))) {
    return {
      category: 'powershell-shim',
      summary: 'PowerShell 启动到了 codex.ps1 包装脚本',
      detail: normalized,
      suggestion: '请把 texor.codexExecutable 改成 codex.cmd 或 codex.exe。',
    };
  }
  if (lower.includes('eftype')) {
    return {
      category: 'powershell-shim',
      summary: 'Windows 无法直接启动当前 Codex 脚本',
      detail: normalized,
      suggestion: '请使用新版 TEXOR，或把 texor.codexExecutable 指向 codex.cmd / codex.exe。',
    };
  }
  if (isToolLayerWriteFailure(normalized)) {
    return {
      category: 'tool-write-failure',
      summary: 'Codex 工具层写文件失败',
      detail: normalized,
      suggestion: '请检查当前环境是否允许写入项目目录，再重新发起任务。',
    };
  }
  if (lower.includes('template') && (lower.includes('download failed') || lower.includes('expand-archive') || lower.includes('resolved template url returned html'))) {
    return {
      category: 'template-download',
      summary: '模板下载或解压失败',
      detail: normalized,
      suggestion: '请重试模板下载，或换一个稳定网络环境后再试。',
    };
  }
  if (lower.includes('fetch failed') || lower.includes('network') || lower.includes('econnreset') || lower.includes('etimedout')) {
    return {
      category: 'network',
      summary: '网络请求失败',
      detail: normalized,
      suggestion: '请检查网络连接、代理设置或目标服务可达性。',
    };
  }
  return {
    category: 'unknown',
    summary: '本轮没有正常完成',
    detail: normalized || '未返回更多错误细节。',
    suggestion: '请查看下方日志；如果有会话按钮，可以直接继续撰写。',
  };
}

function extractFailureEndpoint(message: string): string | undefined {
  const match = message.match(/url:\s*([a-z]+:\/\/[^\s,)]+)/i);
  return match?.[1];
}

function extractFailureHost(endpoint?: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

function compactCodexError(message: string): string {
  return diagnoseFailure(message).summary;
}

function isToolLayerWriteFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('bwrap: loopback') ||
    lower.includes('failed rtm_newaddr') ||
    lower.includes('operation not permitted') && lower.includes('bwrap') ||
    lower.includes('当前环境写文件失败') ||
    lower.includes('没法实际落盘') ||
    lower.includes('无法实际落盘') ||
    lower.includes('可直接替换的 latex') ||
    lower.includes('可直接替换的 latex 文本') ||
    lower.includes('工具层故障')
  );
}

function redactSecret(value: string): string {
  if (value.length <= 8) {
    return '***';
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function compactToolOutput(value: string, limit = 6000): string {
  return value.length > limit ? value.slice(-limit) : value;
}

function safeRelativePath(root: string, requested: string): string {
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`TEXOR Agent refused path outside project: ${requested}`);
  }
  return resolved;
}

function relativePathInsideRoot(root: string, maybePath?: string): string | undefined {
  if (!maybePath) {
    return undefined;
  }
  const resolved = path.resolve(maybePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative || '.';
}

function isBibliographyPath(relativePath: string): boolean {
  return /\.bib$/i.test(relativePath) || /(?:^|[\\/])references(?:[\\/]|$)/i.test(relativePath);
}

function texorAgentWritablePaths(
  policy: TaskExecutionPolicy,
  route: TexorAgentRoute,
  state?: Partial<ManuscriptState>,
  analysis?: Partial<ProjectAnalysis>,
): string[] {
  const writable = new Set<string>();
  if (policy.profile !== 'reference-research' || route !== 'references') {
    writable.add(normalizeProjectRelativePath(texorManuscriptRelativePath));
  }
  if (policy.loadProjectContext === 'ensure') {
    writable.add(normalizeProjectRelativePath(path.join('.texor', 'agent', 'project-context.md')));
  }
  if (policy.allowFigureGeneration || route === 'result-figure') {
    writable.add(normalizeProjectRelativePath(path.join('.texor', 'figures')));
  }
  if (policy.profile === 'reference-research') {
    writable.add(normalizeProjectRelativePath('references.bib'));
  }
  if (route === 'result-figure') {
    for (const assetPath of trackedManuscriptAssetPaths(state)) {
      writable.add(normalizeProjectRelativePath(assetPath));
    }
    for (const scriptPath of projectKnownScriptPaths(analysis)) {
      writable.add(scriptPath);
    }
  }
  return [...writable];
}

function isPathAllowedForWrite(
  policy: TaskExecutionPolicy,
  route: TexorAgentRoute,
  relativePath: string,
  state?: Partial<ManuscriptState>,
  analysis?: Partial<ProjectAnalysis>,
): boolean {
  const normalized = normalizeProjectRelativePath(relativePath);
  const allowed = texorAgentWritablePaths(policy, route, state, analysis);
  return allowed.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

const TEXOR_AGENT_READ_ONLY_PREFIXES = new Set([
  'ls',
  'pwd',
  'find',
  'rg',
  'grep',
  'cat',
  'head',
  'tail',
  'sed',
  'awk',
  'wc',
  'stat',
]);

const TEXOR_AGENT_EXECUTION_PATH_PATTERN = /(train|experiment|benchmark|ablation|eval|test|validate|finetune|sweep|search|runner|launch|plot|figure|chart|visual|viz|draw|result|table)/i;
const TEXOR_AGENT_SCRIPT_EXTENSION_PATTERN = /\.(py|sh|r|R|jl|m|js|ts)$/;
const TEXOR_AGENT_BLOCKED_COMMAND_PATTERN =
  /(^|[\s"'`])(curl|wget|ssh|scp|rsync|sudo|chmod|chown|mount|umount|docker|kubectl|git)(?=$|[\s"'`])|(^|[\s"'`])(pip|pip3|conda|mamba|poetry)\s+install\b|(^|[\s"'`])(npm|pnpm|yarn)\s+(install|add)\b|(^|[\s"'`])(apt|apt-get|yum|dnf|brew)\b/i;

function normalizeAgentCommandText(value: string): string {
  return value.replace(/\r/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenizeShellCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

function unquoteShellToken(token: string): string {
  return token.replace(/^['"]|['"]$/g, '');
}

function normalizeProjectRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function commandKeyForMatch(command: string): string {
  const tokens = tokenizeShellCommand(command)
    .map(unquoteShellToken)
    .filter((token) => token && !token.startsWith('--'))
    .filter((token) => !/^-[A-Za-z]$/.test(token) && token !== '-m' && token !== '-c' && token !== '-e')
    .slice(0, 3);
  return normalizeAgentCommandText(tokens.join(' '));
}

function projectCommandHints(analysis?: Partial<ProjectAnalysis>): Array<{ command: string; source: string }> {
  return Array.isArray(analysis?.dossier?.commandHints)
    ? analysis.dossier.commandHints
        .map((hint) => ({
          command: typeof hint?.command === 'string' ? hint.command.trim() : '',
          source: typeof hint?.source === 'string' ? hint.source.trim() : '',
        }))
        .filter((hint) => hint.command)
    : [];
}

function projectKnownScriptPaths(analysis?: Partial<ProjectAnalysis>): Set<string> {
  const paths = [
    ...(analysis?.dossier?.entryPoints || []),
    ...(analysis?.dossier?.experimentFiles || []),
    ...(analysis?.dossier?.figureScripts || []),
  ];
  return new Set(
    paths
      .map((entry) => typeof entry === 'string' ? normalizeProjectRelativePath(entry.trim()) : '')
      .filter(Boolean),
  );
}

function findMatchingProjectCommandHint(command: string, analysis?: Partial<ProjectAnalysis>): { command: string; source: string } | undefined {
  const normalized = normalizeAgentCommandText(command);
  const key = commandKeyForMatch(command);
  return projectCommandHints(analysis).find((hint) => {
    const hintNormalized = normalizeAgentCommandText(hint.command);
    const hintKey = commandKeyForMatch(hint.command);
    return normalized === hintNormalized || normalized.startsWith(hintNormalized) || hintNormalized.startsWith(normalized) || (key && key === hintKey);
  });
}

function isReadOnlyInspectionCommand(tokens: string[]): boolean {
  const first = tokens[0]?.toLowerCase();
  if (!first || !TEXOR_AGENT_READ_ONLY_PREFIXES.has(first)) {
    return false;
  }
  return !tokens.some((token) => /[><|;&]/.test(token));
}

function commandHasBlockedShellControl(command: string): boolean {
  return /&&|\|\||[;`<>]|\$\(|\n/.test(command) || command.includes('|');
}

function looksLikeWorkspaceScript(token: string): boolean {
  const normalized = unquoteShellToken(token);
  return normalized.startsWith('./') || normalized.startsWith('../') || normalized.includes('/') || TEXOR_AGENT_SCRIPT_EXTENSION_PATTERN.test(normalized);
}

async function workspaceFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function relativeScriptPathFromToken(rootPath: string, token?: string): Promise<string | undefined> {
  if (!token) {
    return undefined;
  }
  const normalized = unquoteShellToken(token);
  if (!normalized || normalized.startsWith('-') || !looksLikeWorkspaceScript(normalized)) {
    return undefined;
  }
  try {
    const resolved = safeRelativePath(rootPath, normalized);
    if (!await workspaceFileExists(resolved)) {
      return undefined;
    }
    return path.relative(rootPath, resolved).replace(/\\/g, '/');
  } catch {
    return undefined;
  }
}

async function findGroundedScriptPath(rootPath: string, tokens: string[]): Promise<string | undefined> {
  const first = tokens[0]?.toLowerCase();
  if (!first) {
    return undefined;
  }
  if (first === 'bash' || first === 'sh' || first === 'rscript' || first === 'julia' || first === 'octave') {
    return relativeScriptPathFromToken(rootPath, tokens[1]);
  }
  if (first === 'python' || first === 'python3' || first === 'node') {
    if (['-c', '-e', '-m'].includes(tokens[1]?.toLowerCase() || '')) {
      return undefined;
    }
    return relativeScriptPathFromToken(rootPath, tokens[1]);
  }
  if (first === 'torchrun' || first === 'deepspeed') {
    for (const token of tokens.slice(1)) {
      const candidate = await relativeScriptPathFromToken(rootPath, token);
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  }
  if (first === 'accelerate') {
    if (tokens[1]?.toLowerCase() !== 'launch') {
      return undefined;
    }
    for (const token of tokens.slice(2)) {
      const candidate = await relativeScriptPathFromToken(rootPath, token);
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  }
  if (first === 'uv' && tokens[1]?.toLowerCase() === 'run') {
    if (tokens[2]?.toLowerCase() === 'python' || tokens[2]?.toLowerCase() === 'python3') {
      if (['-c', '-e', '-m'].includes(tokens[3]?.toLowerCase() || '')) {
        return undefined;
      }
      return relativeScriptPathFromToken(rootPath, tokens[3]);
    }
    return relativeScriptPathFromToken(rootPath, tokens[2]);
  }
  if (looksLikeWorkspaceScript(tokens[0])) {
    return relativeScriptPathFromToken(rootPath, tokens[0]);
  }
  return undefined;
}

async function texorAgentMakefileExists(rootPath: string): Promise<boolean> {
  const candidates = [path.join(rootPath, 'Makefile'), path.join(rootPath, 'makefile')];
  for (const candidate of candidates) {
    if (await workspaceFileExists(candidate)) {
      return true;
    }
  }
  return false;
}

function trackedManuscriptAssetPaths(state?: Partial<ManuscriptState>): string[] {
  const seen = new Set<string>();
  const tracked: string[] = [];
  const assets = [
    ...(Array.isArray(state?.figures) ? state.figures : []),
    ...(Array.isArray(state?.tables) ? state.tables : []),
  ];
  for (const asset of assets) {
    const candidates = [
      typeof asset?.assetPath === 'string' ? asset.assetPath : '',
      ...(Array.isArray(asset?.assetPaths) ? asset.assetPaths : []),
      ...(Array.isArray(asset?.missingAssetPaths) ? asset.missingAssetPaths : []),
    ]
      .map((entry) => typeof entry === 'string' ? entry.trim() : '')
      .filter(Boolean);
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      tracked.push(candidate);
    }
  }
  return tracked.slice(0, 24);
}

async function manuscriptAssetSnapshot(rootPath: string, state?: Partial<ManuscriptState>): Promise<Map<string, number | null>> {
  const snapshot = new Map<string, number | null>();
  for (const assetPath of trackedManuscriptAssetPaths(state)) {
    try {
      const resolved = safeRelativePath(rootPath, assetPath);
      const stat = await fs.stat(resolved).catch(() => null);
      snapshot.set(assetPath, stat?.mtimeMs || null);
    } catch {
      snapshot.set(assetPath, null);
    }
  }
  return snapshot;
}

function summarizeTrackedAssetChanges(before: Map<string, number | null>, after: Map<string, number | null>): string[] {
  const changed: string[] = [];
  for (const [assetPath, previousMtime] of before.entries()) {
    const nextMtime = after.get(assetPath) ?? null;
    if (previousMtime !== nextMtime && nextMtime !== null) {
      changed.push(assetPath);
    }
  }
  return changed.slice(0, 8);
}

async function validateTexorAgentCommand(
  rootPath: string,
  command: string,
  context: TexorAgentToolContext,
): Promise<{ routeLabel: string; timeoutCapMs: number }> {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('run_command requires command.');
  }
  if (commandHasBlockedShellControl(trimmed)) {
    throw new Error('run_command only allows a single project-local command without shell chaining, pipes, or redirection.');
  }
  if (TEXOR_AGENT_BLOCKED_COMMAND_PATTERN.test(trimmed)) {
    throw new Error('run_command refused a network, install, git, or system-level command. Use project-local execution only.');
  }

  const tokens = tokenizeShellCommand(trimmed).map(unquoteShellToken).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('run_command requires a concrete executable.');
  }

  if (isReadOnlyInspectionCommand(tokens)) {
    return {
      routeLabel: 'inspection command',
      timeoutCapMs: 60_000,
    };
  }

  if (!context.executionPolicy.allowProjectCommands) {
    throw new Error('当前执行通道只允许局部改写或只读检查；如需运行实验/绘图脚本，请改用项目执行任务。');
  }

  const hintMatch = findMatchingProjectCommandHint(trimmed, context.analysis);
  if (hintMatch) {
    return {
      routeLabel: `command hint from ${hintMatch.source}`,
      timeoutCapMs: 180_000,
    };
  }

  const first = tokens[0]?.toLowerCase() || '';
  if ((first === 'bash' || first === 'sh') && (!tokens[1] || tokens[1].startsWith('-'))) {
    throw new Error('run_command only allows bash/sh when pointing at a workspace script file, not inline shell code.');
  }
  if ((first === 'python' || first === 'python3') && ['-c', '-m'].includes(tokens[1]?.toLowerCase() || '')) {
    throw new Error('run_command needs a project-local script path or a stored command hint before running Python inline/module commands.');
  }
  if (first === 'node' && tokens[1]?.toLowerCase() === '-e') {
    throw new Error('run_command only allows Node when pointing at a project-local script file.');
  }
  if (first === 'uv' && tokens[1]?.toLowerCase() === 'run' && ['-m', '-c'].includes(tokens[2]?.toLowerCase() || '')) {
    throw new Error('run_command needs a project-local script path or a stored command hint before running uv inline/module commands.');
  }

  const scriptPath = await findGroundedScriptPath(rootPath, tokens);
  if (scriptPath) {
    const normalized = normalizeProjectRelativePath(scriptPath);
    const knownPaths = projectKnownScriptPaths(context.analysis);
    if (knownPaths.has(normalized)) {
      return {
        routeLabel: `known project script ${scriptPath}`,
        timeoutCapMs: 180_000,
      };
    }
    if (TEXOR_AGENT_EXECUTION_PATH_PATTERN.test(scriptPath)) {
      return {
        routeLabel: `project-local execution script ${scriptPath}`,
        timeoutCapMs: 180_000,
      };
    }
    throw new Error(`run_command found local script ${scriptPath}, but it is not recognized as an experiment, entrypoint, or plotting script yet. Inspect it first or rely on a stored command hint.`);
  }

  if (first === 'make') {
    if (!await texorAgentMakefileExists(rootPath)) {
      throw new Error('run_command cannot use make because no Makefile was found in the project root.');
    }
    const target = tokens[1] || '';
    if (!target || !TEXOR_AGENT_EXECUTION_PATH_PATTERN.test(target)) {
      throw new Error('run_command only allows make targets that look like experiment, eval, plot, or result tasks unless a stored command hint matches.');
    }
    return {
      routeLabel: `make target ${target}`,
      timeoutCapMs: 180_000,
    };
  }

  throw new Error('run_command must be grounded in a stored project command hint or a discovered experiment/figure script. Inspect the repository first if the right command is still unclear.');
}

function includesAny(text: string, signals: string[]): boolean {
  return signals.some((signal) => text.includes(signal));
}

function taskClassificationText(payload: CodexTaskCommandPayload): string {
  return [
    payload.instruction,
    payload.selectedText,
    payload.sourceSnippet,
  ].filter(Boolean).join('\n').toLowerCase();
}

function taskIntentForPayload(payload: CodexTaskCommandPayload): CodexTaskIntent {
  if (payload.taskIntent === 'chat' || payload.taskIntent === 'edit') {
    return payload.taskIntent;
  }
  if (payload.draftingMode === 'understand-project') {
    return 'chat';
  }
  if (payload.draftingMode === 'initial-draft') {
    return 'edit';
  }
  if (payload.selectedText || payload.sourceFile || payload.sourceLine || payload.sourceSnippet) {
    return 'edit';
  }
  const text = taskClassificationText(payload);
  if (includesAny(text, [
    'what',
    'why',
    'how',
    'explain',
    '总结',
    '解释',
    '为什么',
    '如何',
    '能不能',
    '是什么',
    '思路',
    '建议',
  ])) {
    return 'chat';
  }
  return 'edit';
}

function classifyTexorAgentTask(payload: CodexTaskCommandPayload): TexorAgentRoute {
  const text = taskClassificationText(payload);

  const structureSignals = ['结构图', '框架图', '流程图', '示意图', 'architecture diagram', 'pipeline diagram', 'schematic', 'diagram'];
  const referenceSignals = ['参考文献', '引用', '文献综述', 'related work', 'literature', 'citation', 'reference', 'arxiv', 'doi'];
  const resultFigureSignals = ['结果图', '实验图', '绘图', '画图', '图表', '曲线', '可视化', 'plot', 'figure', 'chart', 'visualization'];
  const fullSignals = ['全文', '全篇', '整体', '结构', '逻辑', '一致性', '摘要', '引言', '方法', '实验部分', 'conclusion', 'abstract', 'introduction', 'method', 'section'];
  const heavySignals = [
    ...structureSignals,
    ...referenceSignals,
    ...resultFigureSignals,
    ...fullSignals,
    '实验',
    '补充实验',
    '运行',
    '代码',
    'dataset',
    'benchmark',
    'ablation',
  ];
  const quickSignals = ['措辞', '表述', '润色', '语法', '改写', '精炼', '压缩', '更自然', '更学术', 'wording', 'polish', 'grammar', 'rewrite', 'phrase', 'concise'];

  if (includesAny(text, structureSignals)) {
    return 'structure-diagram';
  }
  if (includesAny(text, referenceSignals)) {
    return 'references';
  }
  if (includesAny(text, resultFigureSignals)) {
    return 'result-figure';
  }
  if (includesAny(text, fullSignals)) {
    return 'full-revision';
  }
  if ((payload.selectedText || payload.sourceSnippet || payload.sourceFile) && includesAny(text, quickSignals) && !includesAny(text, heavySignals)) {
    return 'quick-polish';
  }
  return 'general';
}

function routeLabel(route: TexorAgentRoute): string {
  const labels: Record<TexorAgentRoute, string> = {
    'quick-polish': '快速局部润色',
    'full-revision': '全文一致性精修',
    'structure-diagram': '结构图生成',
    'result-figure': '结果图更新',
    references: '参考文献检索',
    general: '通用论文任务',
  };
  return labels[route];
}

function executionScopeLabel(scope: TaskExecutionScope): string {
  return scope === 'foreground' ? '前台快速通道' : '后台长时通道';
}

function executionProfileLabel(profile: TaskExecutionProfile): string {
  const labels: Record<TaskExecutionProfile, string> = {
    'quick-local-edit': '快速局部改写',
    'manuscript-edit': '文稿聚焦改写',
    'reference-research': '参考文献检索',
    'diagram-generation': '图示生成',
    'project-execution': '项目执行',
  };
  return labels[profile];
}

function taskSpeedLabel(mode: TaskSpeedMode): string {
  return mode === 'quick' ? '快速' : '深度';
}

function isPreDraftWorkflowMode(mode?: DraftingMode): boolean {
  return mode === 'understand-project' || mode === 'initial-draft';
}

function requestedTaskSpeedModeForPayload(payload: CodexTaskCommandPayload): TaskSpeedMode {
  if (payload.taskSpeedMode === 'quick' || payload.taskSpeedMode === 'deep') {
    return payload.taskSpeedMode;
  }
  if (isPreDraftWorkflowMode(payload.draftingMode)) {
    return 'deep';
  }
  return classifyTexorAgentTask(payload) === 'quick-polish' ? 'quick' : 'deep';
}

function taskSpeedInstruction(mode: TaskSpeedMode): string[] {
  if (mode === 'quick') {
    return [
      'Prefer the smallest safe edit that addresses the request.',
      'Keep the response concise and avoid broad manuscript rewrites unless the user explicitly asks for them.',
      'Stop as soon as the requested change is complete and consistent.',
      'Once the manuscript file is updated and checked, end the turn immediately without a long textual wrap-up.',
    ];
  }
  return [
    'Take a broader pass when the task could affect surrounding claims, sections, experiments, or references.',
    'Check for consistency across related manuscript sections before finishing.',
    'Spend extra time on completeness, but still avoid inventing evidence or claims.',
    'Once the manuscript file is updated and consistency is checked, end the turn without an extended summary.',
  ];
}

function routeStepLimit(route: TexorAgentRoute): number {
  if (route === 'quick-polish') {
    return 5;
  }
  if (route === 'full-revision' || route === 'result-figure' || route === 'references') {
    return 18;
  }
  if (route === 'structure-diagram') {
    return 14;
  }
  return 12;
}

function initialDraftTurnBudget(payload: CodexTaskCommandPayload): number {
  const speed = requestedTaskSpeedModeForPayload(payload);
  if (payload.draftingMode === 'initial-draft') {
    return speed === 'quick' ? 16 : 24;
  }
  return 0;
}

function stepBudgetForProjectWorkflow(route: TexorAgentRoute, payload: CodexTaskCommandPayload): number {
  const base = payload.draftingMode === 'initial-draft'
    ? Math.max(routeStepLimit(route), initialDraftTurnBudget(payload))
    : payload.draftingMode === 'understand-project'
      ? (requestedTaskSpeedModeForPayload(payload) === 'quick' ? 10 : 16)
    : routeStepLimit(route);
  const speed = requestedTaskSpeedModeForPayload(payload);
  const scaled = speed === 'quick' ? Math.round(base * 0.65) : Math.round(base * 1.45);
  return Math.max(speed === 'quick' ? 3 : base, scaled);
}

function taskNeedsProjectExecution(payload: CodexTaskCommandPayload, route: TexorAgentRoute): boolean {
  if (isPreDraftWorkflowMode(payload.draftingMode)) {
    return true;
  }
  if (route === 'result-figure') {
    return true;
  }
  return includesAny(taskClassificationText(payload), [
    '补做实验',
    '追加实验',
    '跑实验',
    '重跑',
    '复现',
    '运行',
    '训练',
    '评测',
    '脚本',
    '代码',
    'benchmark',
    'ablation',
    'experiment',
    'rerun',
    'reproduce',
    'train',
    'evaluate',
    'eval',
    'script',
  ]);
}

function codexTimeoutMsForPayload(payload: CodexTaskCommandPayload): number {
  return taskExecutionPolicyForPayload(payload).timeoutMs;
}

function stepBudgetForPayload(route: TexorAgentRoute, payload: CodexTaskCommandPayload): number {
  void route;
  return taskExecutionPolicyForPayload(payload).maxSteps;
}

function taskExecutionPolicyForPayload(
  payload: CodexTaskCommandPayload,
  backend: AgentBackend = backendFromCommandPayload(payload),
): TaskExecutionPolicy {
  if (backend === 'codex-native') {
    const intent = taskIntentForPayload(payload);
    const requestedSpeedMode = payload.taskSpeedMode === 'quick' || payload.taskSpeedMode === 'deep'
      ? payload.taskSpeedMode
      : 'deep';
    const speedMode: TaskSpeedMode = isPreDraftWorkflowMode(payload.draftingMode) ? 'deep' : requestedSpeedMode;
    const timeoutMs =
      payload.draftingMode === 'initial-draft'
        ? 60 * 60 * 1000
        : payload.draftingMode === 'understand-project'
          ? 40 * 60 * 1000
          : speedMode === 'quick'
            ? 8 * 60 * 1000
            : 35 * 60 * 1000;
    return {
      route: 'general',
      profile: isPreDraftWorkflowMode(payload.draftingMode)
        ? 'project-execution'
        : intent === 'chat'
          ? 'manuscript-edit'
          : 'manuscript-edit',
      requestedSpeedMode,
      speedMode,
      scope: isPreDraftWorkflowMode(payload.draftingMode) || intent === 'chat' ? 'foreground' : 'foreground',
      timeoutMs,
      maxSteps: intent === 'chat' ? (speedMode === 'quick' ? 5 : 10) : (speedMode === 'quick' ? 6 : 18),
      loadProjectContext: 'none',
      refreshProjectAnalysis: false,
      resumeSession: true,
      useEphemeralSession: false,
      allowProjectCommands: true,
      allowFigureGeneration: true,
      allowPaperSearch: true,
      stopAfterFirstWrite: false,
      preferDirectQuickEdit: false,
      includeConversationMemory: false,
    };
  }
  const route = classifyTexorAgentTask(payload);
  const requestedSpeedMode = requestedTaskSpeedModeForPayload(payload);
  const needsProjectExecution = taskNeedsProjectExecution(payload, route);
  const profile: TaskExecutionProfile =
    route === 'quick-polish' && requestedSpeedMode === 'quick'
      ? 'quick-local-edit'
      : route === 'references'
        ? 'reference-research'
        : route === 'structure-diagram'
          ? 'diagram-generation'
          : needsProjectExecution
            ? 'project-execution'
            : 'manuscript-edit';
  const speedMode = profile === 'project-execution' ? 'deep' : requestedSpeedMode;
  const scope: TaskExecutionScope = profile === 'project-execution' ? 'background' : 'foreground';
  const localEdit = profile === 'quick-local-edit';
  const timeoutMs =
    profile === 'quick-local-edit'
      ? 5 * 60 * 1000
      : profile === 'project-execution'
        ? payload.draftingMode === 'initial-draft'
          ? 60 * 60 * 1000
          : payload.draftingMode === 'understand-project'
            ? 40 * 60 * 1000
            : route === 'result-figure'
              ? 45 * 60 * 1000
              : 35 * 60 * 1000
        : profile === 'diagram-generation'
          ? (speedMode === 'quick' ? 10 : 22) * 60 * 1000
          : profile === 'reference-research'
            ? (speedMode === 'quick' ? 8 : 18) * 60 * 1000
            : (speedMode === 'quick' ? 8 : 18) * 60 * 1000;
  const maxSteps = localEdit
    ? 3
    : profile === 'project-execution'
      ? Math.max(stepBudgetForProjectWorkflow(route, payload), routeStepLimit(route))
      : speedMode === 'quick'
        ? Math.max(4, Math.round(routeStepLimit(route) * 0.7))
        : Math.max(routeStepLimit(route), Math.round(routeStepLimit(route) * 1.15));
  const allowProjectCommands = profile === 'project-execution';
  return {
    route,
    profile,
    requestedSpeedMode,
    speedMode,
    scope,
    timeoutMs,
    maxSteps,
    loadProjectContext:
      profile === 'project-execution'
        ? 'ensure'
        : localEdit
          ? 'none'
          : 'existing-only',
    refreshProjectAnalysis:
      profile === 'project-execution' && (
        route === 'result-figure' ||
        payload.draftingMode === 'understand-project' ||
        payload.draftingMode === 'initial-draft' ||
        needsProjectExecution
      ),
    resumeSession: profile === 'project-execution',
    useEphemeralSession: backend === 'codex-cli' && profile !== 'project-execution',
    allowProjectCommands,
    allowFigureGeneration: profile === 'diagram-generation' || profile === 'project-execution',
    allowPaperSearch: profile === 'reference-research',
    stopAfterFirstWrite: localEdit,
    preferDirectQuickEdit: localEdit,
    includeConversationMemory: profile === 'project-execution',
  };
}

function taskSpeedModeForPayload(payload: CodexTaskCommandPayload): TaskSpeedMode {
  return taskExecutionPolicyForPayload(payload).speedMode;
}

function texorAgentMemoryPath(rootPath: string): string {
  return path.join(rootPath, '.texor', 'agent', 'memory.json');
}

interface SavedProjectContext {
  path: string;
  content: string;
  seeded: boolean;
}

function texorProjectContextPath(rootPath: string): string {
  return path.join(rootPath, '.texor', 'agent', 'project-context.md');
}

function projectContextPromptText(content?: string): string {
  const normalized = (content || '').replace(/\r/g, '').trim();
  if (!normalized) {
    return 'No saved source-repo context yet. Inspect the repository and save a concise verified context before broad drafting.';
  }
  return compactReadableText(normalized, 2800);
}

function formatProjectContextSeedList(title: string, items: string[]): string {
  const compact = items.map((item) => item.trim()).filter(Boolean);
  if (!compact.length) {
    return `## ${title}\n- None confirmed yet.`;
  }
  return [`## ${title}`, ...compact.map((item) => `- ${item}`)].join('\n');
}

function buildProjectContextSeed(analysis?: Partial<ProjectAnalysis>, targetJournal?: string): string {
  const importantFiles = Array.isArray(analysis?.importantFiles)
    ? analysis.importantFiles
        .slice(0, 6)
        .map((file) => {
          const filePath = typeof file?.path === 'string' ? file.path.trim() : '';
          const reason = typeof file?.reason === 'string' ? compactAgentPromptLine(file.reason, 120) : '';
          return filePath ? `\`${filePath}\`${reason ? ` - ${reason}` : ''}` : '';
        })
        .filter(Boolean)
    : [];
  const resultArtifacts = Array.isArray(analysis?.resultArtifacts)
    ? analysis.resultArtifacts
        .slice(0, 5)
        .map((artifact) => {
          const artifactPath = typeof artifact?.path === 'string' ? artifact.path.trim() : '';
          const summary = typeof artifact?.summary === 'string' ? compactAgentPromptLine(artifact.summary, 140) : '';
          const kind = typeof artifact?.kind === 'string' ? artifact.kind : 'artifact';
          return artifactPath ? `\`${artifactPath}\` (${kind})${summary ? ` - ${summary}` : ''}` : '';
        })
        .filter(Boolean)
    : [];
  const datasetHints = Array.isArray(analysis?.dossier?.datasetHints)
    ? analysis.dossier.datasetHints.slice(0, 5).map((item) => compactAgentPromptLine(item, 100)).filter(Boolean)
    : [];
  const metricHints = Array.isArray(analysis?.dossier?.metricHints)
    ? analysis.dossier.metricHints.slice(0, 6).map((item) => compactAgentPromptLine(item, 100)).filter(Boolean)
    : [];
  const commandHints = Array.isArray(analysis?.dossier?.commandHints)
    ? analysis.dossier.commandHints
        .slice(0, 5)
        .map((hint) => {
          const command = typeof hint?.command === 'string' ? hint.command.trim() : '';
          const source = typeof hint?.source === 'string' ? hint.source.trim() : '';
          return command ? `\`${command}\`${source ? ` - from ${source}` : ''}` : '';
        })
        .filter(Boolean)
    : [];
  const openQuestions = Array.isArray(analysis?.dossier?.openQuestions)
    ? analysis.dossier.openQuestions.slice(0, 5).map((item) => compactAgentPromptLine(item, 140)).filter(Boolean)
    : [];
  const methods = Array.isArray(analysis?.methods)
    ? analysis.methods.slice(0, 4).map((item) => compactAgentPromptLine(item, 140)).filter(Boolean)
    : [];
  const results = Array.isArray(analysis?.results)
    ? analysis.results.slice(0, 4).map((item) => compactAgentPromptLine(item, 140)).filter(Boolean)
    : [];

  return [
    '# Source Repository Context',
    '',
    `Status: scan-seeded, needs AI verification`,
    `Updated: ${new Date().toISOString()}`,
    `Project: ${analysis?.projectName || 'Unknown project'}`,
    `Root path: ${analysis?.rootPath || 'Unknown root path'}`,
    `Target journal: ${targetJournal || 'arXiv'}`,
    '',
    'Use this file as persistent project grounding for manuscript drafting. Before broad drafting, inspect the repository and rewrite this file with verified understanding drawn from actual project files and runnable evidence.',
    '',
    '## Current scan snapshot',
    `- Overview: ${compactAgentPromptLine(analysis?.overview || 'Repository-level overview is not stored yet.', 220)}`,
    `- Purpose: ${compactAgentPromptLine(analysis?.purpose || 'Project purpose still needs verification from source files.', 220)}`,
    `- Agent brief: ${compactAgentPromptLine(analysis?.dossier?.agentBrief || 'No agent brief yet.', 260)}`,
    '',
    formatProjectContextSeedList('Candidate methods', methods),
    '',
    formatProjectContextSeedList('Candidate results', results),
    '',
    formatProjectContextSeedList('Evidence anchors', importantFiles),
    '',
    formatProjectContextSeedList('Result artifacts', resultArtifacts),
    '',
    formatProjectContextSeedList('Dataset hints', datasetHints),
    '',
    formatProjectContextSeedList('Metric hints', metricHints),
    '',
    formatProjectContextSeedList('Runnable commands', commandHints),
    '',
    formatProjectContextSeedList('Open questions', openQuestions),
    '',
    '## Next AI update checklist',
    '- Verify the real research problem, method, and contribution from repository evidence.',
    '- Confirm datasets, metrics, baselines, figures, and experiment scripts from actual files or commands.',
    '- Keep this context concise and update it before broad manuscript drafting.',
  ].join('\n');
}

async function ensureSavedProjectContext(
  rootPath: string,
  snapshot: WorkspaceSnapshot | null,
  targetJournal?: string,
  analysis?: Partial<ProjectAnalysis>,
): Promise<SavedProjectContext> {
  const contextPath = texorProjectContextPath(rootPath);
  const existing = await fs.readFile(contextPath, 'utf8').catch(() => '');
  if (existing.trim()) {
    return {
      path: contextPath,
      content: existing.trim(),
      seeded: false,
    };
  }

  const seed = buildProjectContextSeed(analysis || snapshot?.paper.analysis, targetJournal || snapshot?.paper.targetJournal);
  await fs.mkdir(path.dirname(contextPath), { recursive: true });
  await fs.writeFile(contextPath, seed, 'utf8');
  return {
    path: contextPath,
    content: seed,
    seeded: true,
  };
}

async function loadTexorAgentMemory(rootPath: string): Promise<TexorAgentMemoryEntry[]> {
  const memoryPath = texorAgentMemoryPath(rootPath);
  const raw = await fs.readFile(memoryPath, 'utf8').catch(() => '');
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is TexorAgentMemoryEntry => Boolean(entry && typeof entry === 'object')) : [];
  } catch {
    return [];
  }
}

async function appendTexorAgentMemory(rootPath: string, entry: Omit<TexorAgentMemoryEntry, 'id' | 'time'>): Promise<void> {
  const memoryPath = texorAgentMemoryPath(rootPath);
  const existing = await loadTexorAgentMemory(rootPath);
  const next = [
    ...existing,
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: new Date().toISOString(),
      ...entry,
    },
  ].slice(-60);
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, JSON.stringify(next, null, 2), 'utf8');
}

function formatTexorAgentMemory(memory: TexorAgentMemoryEntry[]): string {
  const recent = memory.slice(-10);
  if (!recent.length) {
    return 'No prior TEXOR Agent turns for this project.';
  }
  return recent
    .map((entry, index) => [
      `${index + 1}. ${routeLabel(entry.route)} at ${entry.time}`,
      `Request: ${compactToolOutput(entry.instruction, 500)}`,
      entry.sourceFile ? `Source: ${entry.sourceFile}` : undefined,
      entry.selectedText ? `Selected: ${compactToolOutput(entry.selectedText, 500)}` : undefined,
      `Outcome: ${compactToolOutput(entry.summary, 700)}`,
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}

function compactAgentPromptLine(value: string, limit = 320): string {
  return compactReadableText(value, limit).replace(/\s+/g, ' ').trim();
}

function formatProjectDossierList(label: string, items: string[] | undefined, limit: number): string | undefined {
  const compact = Array.isArray(items)
    ? items
        .map((item) => typeof item === 'string' ? item.trim() : '')
        .filter(Boolean)
        .slice(0, limit)
    : [];
  if (!compact.length) {
    return undefined;
  }
  return `${label}: ${compact.join('; ')}`;
}

function formatProjectCommandHintsForAgent(hints: ProjectCommandHint[] | undefined, limit = 3): string | undefined {
  const compact = Array.isArray(hints)
    ? hints
        .map((hint) => {
          const command = typeof hint?.command === 'string' ? hint.command.trim() : '';
          if (!command) {
            return '';
          }
          const source = typeof hint?.source === 'string' ? hint.source.trim() : '';
          return source ? `${command} [${source}]` : command;
        })
        .filter(Boolean)
        .slice(0, limit)
    : [];
  if (!compact.length) {
    return undefined;
  }
  return `Command hints: ${compact.join('; ')}`;
}

function formatProjectResultArtifactsForAgent(
  artifacts: Array<{ path: string; kind: string; summary: string; preview?: string[][] }> | undefined,
  limit = 4,
): string | undefined {
  const compact = Array.isArray(artifacts)
    ? artifacts
        .map((artifact) => {
          const artifactPath = typeof artifact?.path === 'string' ? artifact.path.trim() : '';
          if (!artifactPath) {
            return '';
          }
          const kind = typeof artifact?.kind === 'string' ? artifact.kind.trim() : 'artifact';
          const preview = Array.isArray(artifact?.preview) && artifact.preview.length > 0
            ? artifact.preview
                .slice(0, 2)
                .map((row) => row.slice(0, 4).join(' | '))
                .join(' / ')
            : '';
          return compactAgentPromptLine(
            `${kind}:${artifactPath}${preview ? ` [${preview}]` : ''}`,
            180,
          );
        })
        .filter(Boolean)
        .slice(0, limit)
    : [];
  if (!compact.length) {
    return undefined;
  }
  return `Result artifacts: ${compact.join('; ')}`;
}

function formatProjectDossierForAgent(analysis?: Partial<ProjectAnalysis>): string {
  const dossier = analysis?.dossier;
  const lines = [
    typeof dossier?.agentBrief === 'string' && dossier.agentBrief.trim()
      ? `Agent brief: ${compactAgentPromptLine(dossier.agentBrief, 520)}`
      : undefined,
    formatProjectDossierList('Entrypoints', dossier?.entryPoints, 3),
    formatProjectDossierList('Experiment files', dossier?.experimentFiles, 4),
    formatProjectDossierList('Figure scripts', dossier?.figureScripts, 3),
    formatProjectDossierList('Dataset hints', dossier?.datasetHints, 4),
    formatProjectDossierList('Metric hints', dossier?.metricHints, 5),
    formatProjectCommandHintsForAgent(dossier?.commandHints, 3),
    formatProjectResultArtifactsForAgent(analysis?.resultArtifacts, 4),
    formatProjectDossierList('Open evidence questions', dossier?.openQuestions, 3),
  ].filter((line): line is string => Boolean(line));

  if (!lines.length) {
    return 'No stored project dossier yet. Inspect the repository directly before making claims.';
  }

  lines.push('Treat the dossier as heuristic evidence cues and verify critical claims against project files before writing them.');
  return lines.join('\n');
}

function formatManuscriptStateList(label: string, items: string[] | undefined, limit: number): string | undefined {
  const compact = Array.isArray(items)
    ? items
        .map((item) => typeof item === 'string' ? item.trim() : '')
        .filter(Boolean)
        .slice(0, limit)
    : [];
  if (!compact.length) {
    return undefined;
  }
  return `${label}: ${compact.join('; ')}`;
}

function formatManuscriptAssetForAgent(asset?: Partial<ManuscriptAsset>): string {
  const label = typeof asset?.label === 'string' ? asset.label.trim() : '';
  const caption = typeof asset?.caption === 'string' ? compactAgentPromptLine(asset.caption, 96) : '';
  const assetPaths = Array.isArray(asset?.assetPaths)
    ? asset.assetPaths.map((entry) => typeof entry === 'string' ? entry.trim() : '').filter(Boolean).slice(0, 2)
    : [];
  const primaryPath =
    typeof asset?.assetPath === 'string' && asset.assetPath.trim()
      ? asset.assetPath.trim()
      : assetPaths[0] || '';
  const missingPaths = Array.isArray(asset?.missingAssetPaths)
    ? asset.missingAssetPaths.map((entry) => typeof entry === 'string' ? entry.trim() : '').filter(Boolean).slice(0, 2)
    : [];
  const head = label || caption ? `${label || 'unlabeled'}${caption ? ` (${caption})` : ''}` : `line ${asset?.line || '?'}`;
  const pathInfo = assetPaths.length > 0 ? assetPaths.join(', ') : primaryPath;
  const statusInfo = missingPaths.length > 0
    ? ` missing:${missingPaths.join(', ')}`
    : asset?.assetExists === false
      ? ' missing linked asset'
      : '';
  return compactAgentPromptLine(`${head}${pathInfo ? ` -> ${pathInfo}` : ''}${statusInfo}`, 220);
}

function missingAssetHintsForAgent(state?: Partial<ManuscriptState>, limit = 4): string[] {
  const assets = [
    ...(Array.isArray(state?.figures) ? state?.figures : []),
    ...(Array.isArray(state?.tables) ? state?.tables : []),
  ];
  return assets
    .filter((asset) => asset?.assetExists === false)
    .map((asset) => formatManuscriptAssetForAgent(asset))
    .filter(Boolean)
    .slice(0, limit);
}

function formatManuscriptStateForAgent(
  state?: Partial<ManuscriptState>,
  changeSummary?: Partial<VersionChangeSummary>,
): string {
  if (!state && !changeSummary) {
    return 'No stored manuscript state yet. Inspect the main manuscript before broad structural changes.';
  }

  const sectionTitles = Array.isArray(state?.sectionMap)
    ? state.sectionMap
        .filter((region) => typeof region?.title === 'string' && typeof region?.kind === 'string')
        .map((region) => `${region.kind}:${region.title}`)
    : [];
  const figureTitles = Array.isArray(state?.figures)
    ? state.figures
        .map((figure) => formatManuscriptAssetForAgent(figure))
        .filter(Boolean)
    : [];
  const tableTitles = Array.isArray(state?.tables)
    ? state.tables
        .map((table) => formatManuscriptAssetForAgent(table))
        .filter(Boolean)
    : [];
  const missingAssets = missingAssetHintsForAgent(state, 4);
  const citations = Array.isArray(state?.citations)
    ? state.citations
        .map((citation) => {
          const key = typeof citation?.key === 'string' ? citation.key : '';
          const count = typeof citation?.count === 'number' ? citation.count : 0;
          return key ? `${key}${count > 0 ? ` x${count}` : ''}` : '';
        })
        .filter(Boolean)
    : [];
  const openItems = Array.isArray(state?.unresolvedEvidenceGaps) && state.unresolvedEvidenceGaps.length > 0
    ? state.unresolvedEvidenceGaps
    : Array.isArray(state?.todos)
      ? state.todos.map((todo) => typeof todo?.text === 'string' ? todo.text : '').filter(Boolean)
      : [];
  const stats = state?.stats;

  const lines = [
    typeof changeSummary?.summary === 'string' && changeSummary.summary.trim()
      ? `Latest version change summary: ${compactAgentPromptLine(changeSummary.summary, 360)}`
      : undefined,
    stats
      ? `Manuscript stats: ${typeof stats.wordCount === 'number' ? stats.wordCount : 0} words; ${typeof stats.sectionCount === 'number' ? stats.sectionCount : 0} sections; ${typeof stats.figureCount === 'number' ? stats.figureCount : 0} figures; ${typeof stats.tableCount === 'number' ? stats.tableCount : 0} tables; ${typeof stats.citationCount === 'number' ? stats.citationCount : 0} citations; ${typeof stats.todoCount === 'number' ? stats.todoCount : 0} open items; ${typeof stats.missingAssetCount === 'number' ? stats.missingAssetCount : 0} missing assets`
      : undefined,
    formatManuscriptStateList('Section map', sectionTitles, 8),
    formatManuscriptStateList('Figures', figureTitles, 4),
    formatManuscriptStateList('Tables', tableTitles, 4),
    formatManuscriptStateList('Missing linked assets', missingAssets, 4),
    formatManuscriptStateList('Citation anchors', citations, 5),
    formatManuscriptStateList('Open manuscript gaps', openItems, 5),
    formatManuscriptStateList(
      'Touched regions in this lineage',
      Array.isArray(changeSummary?.touchedRegions) ? changeSummary.touchedRegions : undefined,
      5,
    ),
  ].filter((line): line is string => Boolean(line));

  if (!lines.length) {
    return 'No stored manuscript state yet. Inspect the main manuscript before broad structural changes.';
  }

  lines.push('Use this manuscript state to keep section names, figures, tables, linked asset paths, citations, and open evidence gaps consistent after edits.');
  return lines.join('\n');
}

function normalizedTaskTextForAgent(payload: CodexTaskCommandPayload): string {
  return [payload.instruction, payload.selectedText, payload.sourceSnippet]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function manuscriptRegionTitleKey(region?: Partial<ManuscriptRegion>): string {
  return compactAgentPromptLine(typeof region?.title === 'string' ? region.title : '', 120).toLowerCase();
}

function findManuscriptRegionByLine(state: Partial<ManuscriptState> | undefined, line?: number): Partial<ManuscriptRegion> | undefined {
  if (!state || !line || !Array.isArray(state.sectionMap)) {
    return undefined;
  }
  return state.sectionMap.find((region) =>
    typeof region?.lineStart === 'number' &&
    typeof region?.lineEnd === 'number' &&
    region.lineStart <= line &&
    region.lineEnd >= line,
  );
}

function findManuscriptRegionsByTerms(state: Partial<ManuscriptState> | undefined, terms: string[]): Partial<ManuscriptRegion>[] {
  if (!state || !Array.isArray(state.sectionMap) || terms.length === 0) {
    return [];
  }
  return state.sectionMap.filter((region) => {
    const title = manuscriptRegionTitleKey(region);
    return title && terms.some((term) => title.includes(term));
  });
}

function inferManuscriptRegionTermsForTask(text: string): string[] {
  const terms = new Set<string>();
  const mappings: Array<{ signals: string[]; terms: string[] }> = [
    { signals: ['abstract', '摘要'], terms: ['abstract'] },
    { signals: ['introduction', '引言', 'motivation', 'background'], terms: ['introduction', 'background'] },
    { signals: ['related work', '参考文献', '引用', 'citation', 'references', '文献综述'], terms: ['related work', 'reference', 'bibliography'] },
    { signals: ['method', 'approach', '方法', '模型', '架构'], terms: ['method', 'approach'] },
    { signals: ['experiment', '实验', 'setup', 'benchmark', 'dataset'], terms: ['experiment', 'setup'] },
    { signals: ['result', 'results', '结果', 'ablation', 'analysis', 'discussion'], terms: ['result', 'analysis', 'discussion'] },
    { signals: ['conclusion', '结论', 'future work'], terms: ['conclusion'] },
  ];
  for (const mapping of mappings) {
    if (mapping.signals.some((signal) => text.includes(signal))) {
      mapping.terms.forEach((term) => terms.add(term));
    }
  }
  return [...terms];
}

function uniqueManuscriptRegions(regions: Array<Partial<ManuscriptRegion> | undefined>, primary?: Partial<ManuscriptRegion>): Partial<ManuscriptRegion>[] {
  const primaryKey = manuscriptRegionTitleKey(primary);
  const seen = new Set<string>();
  const unique: Partial<ManuscriptRegion>[] = [];
  for (const region of regions) {
    const key = manuscriptRegionTitleKey(region);
    if (!key || key === primaryKey || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(region || {});
  }
  return unique;
}

function inferRelatedManuscriptRegionsForAgent(
  state: Partial<ManuscriptState> | undefined,
  primary: Partial<ManuscriptRegion> | undefined,
  route: TexorAgentRoute,
  text: string,
): Partial<ManuscriptRegion>[] {
  if (!state) {
    return [];
  }
  const terms = new Set<string>();
  const primaryTitle = manuscriptRegionTitleKey(primary);
  if (primaryTitle.includes('abstract')) {
    ['introduction', 'conclusion', 'result'].forEach((term) => terms.add(term));
  }
  if (primaryTitle.includes('introduction')) {
    ['abstract', 'conclusion'].forEach((term) => terms.add(term));
  }
  if (primaryTitle.includes('method') || primaryTitle.includes('approach')) {
    ['abstract', 'experiment', 'result'].forEach((term) => terms.add(term));
  }
  if (primaryTitle.includes('experiment') || primaryTitle.includes('result') || primaryTitle.includes('discussion') || primaryTitle.includes('analysis')) {
    ['abstract', 'conclusion', 'method'].forEach((term) => terms.add(term));
  }
  if (primaryTitle.includes('conclusion')) {
    ['abstract', 'introduction', 'result'].forEach((term) => terms.add(term));
  }
  if (route === 'references') {
    ['introduction', 'related work', 'bibliography'].forEach((term) => terms.add(term));
  }
  if (route === 'result-figure') {
    ['experiment', 'result', 'analysis', 'discussion'].forEach((term) => terms.add(term));
  }
  if (route === 'structure-diagram') {
    ['method', 'approach', 'experiment'].forEach((term) => terms.add(term));
  }
  if (route === 'full-revision' || /(全文|全篇|一致性|overall|consistency|across sections)/i.test(text)) {
    ['abstract', 'introduction', 'conclusion'].forEach((term) => terms.add(term));
  }
  return uniqueManuscriptRegions(findManuscriptRegionsByTerms(state, [...terms]), primary).slice(0, 6);
}

function relevantOpenItemsForAgent(
  state: Partial<ManuscriptState> | undefined,
  primary: Partial<ManuscriptRegion> | undefined,
  related: Partial<ManuscriptRegion>[],
): string[] {
  if (!state) {
    return [];
  }
  const titles = new Set(uniqueManuscriptRegions([primary, ...related]).map((region) => manuscriptRegionTitleKey(region)).filter(Boolean));
  const todoItems = Array.isArray(state.todos)
    ? state.todos
        .filter((todo) => {
          const regionTitle = compactAgentPromptLine(typeof todo?.regionTitle === 'string' ? todo.regionTitle : '', 120).toLowerCase();
          return titles.size === 0 ? todo?.kind !== 'todo' : titles.has(regionTitle);
        })
        .map((todo) => typeof todo?.text === 'string' ? todo.text : '')
        .filter(Boolean)
    : [];
  if (todoItems.length > 0) {
    return todoItems.slice(0, 4);
  }
  return Array.isArray(state.unresolvedEvidenceGaps) ? state.unresolvedEvidenceGaps.slice(0, 4) : [];
}

function manuscriptAssetKeyForAgent(asset?: Partial<ManuscriptAsset>): string {
  return compactAgentPromptLine(
    [
      typeof asset?.label === 'string' ? asset.label : '',
      typeof asset?.caption === 'string' ? asset.caption : '',
      typeof asset?.assetPath === 'string' ? asset.assetPath : '',
      ...(Array.isArray(asset?.assetPaths) ? asset.assetPaths : []),
      ...(Array.isArray(asset?.missingAssetPaths) ? asset.missingAssetPaths : []),
    ]
      .filter(Boolean)
      .join(' '),
    220,
  ).toLowerCase();
}

function manuscriptAssetMatchesRegion(asset: Partial<ManuscriptAsset>, region?: Partial<ManuscriptRegion>): boolean {
  return Boolean(
    region &&
      typeof asset.line === 'number' &&
      typeof region.lineStart === 'number' &&
      typeof region.lineEnd === 'number' &&
      asset.line >= region.lineStart &&
      asset.line <= region.lineEnd,
  );
}

function relevantLinkedAssetsForAgent(
  state: Partial<ManuscriptState> | undefined,
  primary: Partial<ManuscriptRegion> | undefined,
  related: Partial<ManuscriptRegion>[],
  route: TexorAgentRoute,
  text: string,
): Partial<ManuscriptAsset>[] {
  if (!state) {
    return [];
  }
  const assets = [
    ...(Array.isArray(state.figures) ? state.figures : []),
    ...(Array.isArray(state.tables) ? state.tables : []),
  ];
  if (assets.length === 0) {
    return [];
  }
  const textHints = inferManuscriptRegionTermsForTask(text);
  const wantsFigure = /(figure|fig\.?|结果图|实验图|结构图|流程图|示意图|图表|可视化|plot|chart)/i.test(text);
  const wantsTable = /(table|tab\.?|表格|结果表|表)/i.test(text);
  const scored = assets
    .map((asset) => {
      let score = 0;
      if (asset.assetExists === false) {
        score += 5;
      }
      if (manuscriptAssetMatchesRegion(asset, primary)) {
        score += 4;
      }
      if (related.some((region) => manuscriptAssetMatchesRegion(asset, region))) {
        score += 2;
      }
      if (route === 'result-figure' && asset.kind === 'figure') {
        score += 3;
      }
      if (route === 'structure-diagram' && asset.kind === 'figure') {
        score += 3;
      }
      if (route === 'references' && asset.kind === 'table') {
        score -= 1;
      }
      if (wantsFigure && asset.kind === 'figure') {
        score += 1;
      }
      if (wantsTable && asset.kind === 'table') {
        score += 1;
      }
      const key = manuscriptAssetKeyForAgent(asset);
      if (textHints.some((term) => key.includes(term))) {
        score += 1;
      }
      if (route === 'structure-diagram' && /(arch|framework|pipeline|workflow|system|overview|框架|流程|系统)/i.test(key)) {
        score += 2;
      }
      return { asset, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || (left.asset.line || 0) - (right.asset.line || 0));
  return scored.slice(0, 4).map((entry) => entry.asset);
}

function formatRevisionRegionPlanForAgent(
  payload: CodexTaskCommandPayload,
  snapshot: WorkspaceSnapshot | null,
  route: TexorAgentRoute,
): string {
  const state = snapshot?.currentVersion.manuscriptState;
  if (!state) {
    return 'No stored revision-region plan yet. Inspect the manuscript and choose a local section before broad edits.';
  }

  const text = normalizedTaskTextForAgent(payload);
  const primary =
    findManuscriptRegionByLine(state, payload.sourceLine) ||
    findManuscriptRegionsByTerms(state, inferManuscriptRegionTermsForTask(text))[0];
  const related = inferRelatedManuscriptRegionsForAgent(state, primary, route, text);
  const openItems = relevantOpenItemsForAgent(state, primary, related);
  const linkedAssets = relevantLinkedAssetsForAgent(state, primary, related, route, text);
  const scopeNotes = [
    primary
      ? `Edit the primary region first: ${primary.title}${typeof primary.lineStart === 'number' && typeof primary.lineEnd === 'number' ? ` [lines ${primary.lineStart}-${primary.lineEnd}]` : ''}.`
      : 'No primary region was resolved, so start with the closest local manuscript area you inspect.',
    related.length > 0
      ? `If terminology, claims, or numbers shift, only do the minimum follow-up checks in: ${related.map((region) => region.title).filter(Boolean).join(', ')}.`
      : 'Do not broaden scope beyond the local request unless consistency clearly requires it.',
    route === 'result-figure'
      ? 'Keep figure/table captions and nearby result discussion synchronized. Prefer updating the existing manuscript-linked asset paths above; if an asset is missing, regenerate into the same path when feasible.'
      : route === 'references'
        ? 'Keep related-work edits synchronized with introduction claims and bibliography entries.'
        : route === 'structure-diagram'
          ? 'Keep the diagram synchronized with method terminology and figure references. If the manuscript already has a linked or missing figure path, prefer filling that reference instead of inventing a new one.'
          : 'Preserve section-local intent and avoid unnecessary global rewrites.',
  ];

  return [
    primary
      ? `Primary manuscript region: ${primary.title}${typeof primary.lineStart === 'number' && typeof primary.lineEnd === 'number' ? ` [${primary.lineStart}-${primary.lineEnd}]` : ''}`
      : 'Primary manuscript region: unresolved from current state.',
    related.length > 0
      ? `Related consistency regions: ${related.map((region) => `${region.title}${typeof region.lineStart === 'number' && typeof region.lineEnd === 'number' ? ` [${region.lineStart}-${region.lineEnd}]` : ''}`).join('; ')}`
      : 'Related consistency regions: none strongly indicated.',
    openItems.length > 0
      ? `Open items near these regions: ${openItems.join(' ; ')}`
      : 'Open items near these regions: none currently flagged.',
    linkedAssets.length > 0
      ? `Linked manuscript assets in scope: ${linkedAssets.map((asset) => formatManuscriptAssetForAgent(asset)).join('; ')}`
      : 'Linked manuscript assets in scope: none strongly indicated.',
    `Scope guidance: ${scopeNotes.join(' ')}`,
  ].join('\n');
}

function normalizePdfSelectedTextForAgent(text?: string): string {
  if (!text) {
    return '';
  }
  const selectedLine = text
    .split('\n')
    .find((line) => line.startsWith('已选文字:'))
    ?.replace(/^已选文字:\s*/, '')
    .trim();
  return (selectedLine || text).replace(/\s+/g, ' ').trim();
}

function escapeRegexForAgent(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFuzzyTextRegexForAgent(selectedText: string): RegExp | null {
  const words = selectedText.match(/[A-Za-z0-9%+./-]+|[\u4e00-\u9fff]+/g);
  if (!words || words.length < 3) {
    return null;
  }
  return new RegExp(words.slice(0, 56).map(escapeRegexForAgent).join('[\\s~\\\\{}\\[\\](),.;:!?\\-]*'), 'i');
}

function lineWindowForAgent(content: string, line?: number, radius = 4): { start: number; end: number; text: string } | null {
  if (!line || line < 1) {
    return null;
  }
  const lines = content.split('\n');
  const startLine = Math.max(0, line - 1 - radius);
  const endLine = Math.min(lines.length, line + radius);
  const offsets: number[] = [];
  let cursor = 0;
  for (const entry of lines) {
    offsets.push(cursor);
    cursor += entry.length + 1;
  }
  const start = offsets[startLine] ?? 0;
  const end = endLine >= lines.length ? content.length : offsets[endLine] ?? content.length;
  return { start, end, text: content.slice(start, end) };
}

function locateQuickPolishSpan(latex: string, payload: CodexTaskCommandPayload): { start: number; end: number; text: string } | null {
  const selectedText = normalizePdfSelectedTextForAgent(payload.selectedText);
  const sourceSnippet = payload.sourceSnippet?.trim();
  const sourceWindow = lineWindowForAgent(latex, payload.sourceLine);
  const searchAreas = [
    sourceWindow ? { offset: sourceWindow.start, text: sourceWindow.text } : null,
    sourceSnippet ? { offset: Math.max(0, latex.indexOf(sourceSnippet)), text: sourceSnippet } : null,
    { offset: 0, text: latex },
  ].filter((area): area is { offset: number; text: string } => Boolean(area && area.offset >= 0));

  if (selectedText && selectedText !== 'PDF text selection') {
    for (const area of searchAreas) {
      const index = area.text.indexOf(selectedText);
      if (index >= 0) {
        return { start: area.offset + index, end: area.offset + index + selectedText.length, text: area.text.slice(index, index + selectedText.length) };
      }
    }
    const fuzzy = buildFuzzyTextRegexForAgent(selectedText);
    if (fuzzy) {
      for (const area of searchAreas) {
        const match = area.text.match(fuzzy);
        if (match?.index !== undefined) {
          return { start: area.offset + match.index, end: area.offset + match.index + match[0].length, text: match[0] };
        }
      }
    }
  }

  if (sourceSnippet) {
    const snippetIndex = latex.indexOf(sourceSnippet);
    if (snippetIndex >= 0) {
      return { start: snippetIndex, end: snippetIndex + sourceSnippet.length, text: sourceSnippet };
    }
  }

  if (sourceWindow) {
    const sentences = sourceWindow.text.match(/[^.!?。！？\n]+[.!?。！？]?/g) || [];
    const candidates = sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 24 && !sentence.startsWith('\\'));
    const chosen = candidates[Math.floor(candidates.length / 2)] || candidates[0];
    if (chosen) {
      const index = latex.indexOf(chosen, sourceWindow.start);
      if (index >= 0) {
        return { start: index, end: index + chosen.length, text: chosen };
      }
    }
  }

  return null;
}

function sanitizeQuickReplacement(original: string, content: string): string {
  const trimmed = content
    .replace(/^```(?:latex|tex|text)?/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!trimmed) {
    throw new Error('快速润色没有生成可替换文本。');
  }
  if (hasFullLatexDocument(trimmed)) {
    throw new Error('快速润色返回了整篇论文，TEXOR 已拒绝保存以避免误删原稿。');
  }
  const maxLength = Math.max(420, original.length * 3);
  if (trimmed.length > maxLength) {
    throw new Error('快速润色扩写过多，已停止本次局部替换。');
  }
  return trimmed;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        const parsed = JSON.parse(candidate.slice(first, last + 1)) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function texorProcessSummaryFromParsed(parsed: Record<string, unknown>): string {
  const raw = typeof parsed.process === 'string'
    ? parsed.process
    : typeof parsed.thought === 'string'
      ? parsed.thought
      : '';
  const normalized = compactReadableText(raw, 220)
    .replace(/^[-*]\s*/, '')
    .replace(/^(?:thought|process|status)\s*:\s*/i, '')
    .trim();
  if (!normalized) {
    return '正在推进当前写作任务';
  }
  if (
    /^("?tool"?\s*:|"?(read_file|list_files|inspect_result_table|write_file|run_command|generate_image|search_papers)"?)/i.test(normalized) ||
    /^```/.test(normalized)
  ) {
    return '正在推进当前写作任务';
  }
  return normalized;
}

async function callTexorAgentModel(messages: TexorAgentMessage[], modelConfig: ModelConfig): Promise<TexorAgentModelResponse> {
  const baseUrl = (modelConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const localModelEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(baseUrl);
  if (!modelConfig.apiKey?.trim() && !localModelEndpoint) {
    throw new Error('TEXOR Agent 需要模型 API Key。请在侧栏填写，或在 VSCode 设置 texor.agentApiKey。');
  }
  const model = modelConfig.model || 'gpt-4.1-mini';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (modelConfig.apiKey?.trim()) {
    headers.Authorization = `Bearer ${modelConfig.apiKey}`;
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages,
    }),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`TEXOR Agent model request failed: ${response.status} ${raw.slice(0, 1200)}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('TEXOR Agent model returned an empty response.');
  }
  return { content };
}

function texorAgentRouteInstructions(route: TexorAgentRoute, policy: TaskExecutionPolicy): string[] {
  const common = [
    'Preserve the user-selected scope whenever a source location or snippet is provided.',
    'When broader consistency matters, make the minimal cross-reference edits needed and explain that in the final summary.',
  ];
  if (route === 'quick-polish') {
    return [
      ...common,
      'This is a fast local wording task. Do not rewrite the full paper.',
      'Read only the main manuscript or located source file if needed, replace the selected span or its nearby LaTeX sentence, then finish.',
      'Avoid changing citations, math, labels, figure/table references, experiment claims, or unrelated paragraphs.',
      policy.allowProjectCommands
        ? 'Read-only project inspection is allowed if it directly disambiguates the local text, but do not broaden into experiment execution.'
        : 'Do not run project commands, generate figures, or search papers in this local-edit lane.',
    ];
  }
  if (route === 'full-revision') {
    return [
      ...common,
      'This is a manuscript-level consistency task. Inspect the current manuscript structure before editing.',
      'If quantitative claims or manuscript tables change, inspect the underlying CSV/TSV/JSON result file with inspect_result_table before editing those numbers.',
      'After editing, quickly scan related sections for terminology, claim, notation, citation, and contribution consistency.',
      'Do not invent new experiments or citations. If evidence is missing, leave a precise TODO in the manuscript or final summary.',
    ];
  }
  if (route === 'structure-diagram') {
    return [
      ...common,
      'This task asks for an architecture, pipeline, workflow, or schematic figure.',
      'First inspect the project/manuscript enough to understand the method. If the manuscript state already shows a linked or missing diagram path, prefer filling that path instead of inventing a new reference.',
      'Otherwise create a figure asset under .texor/figures/ and reference it from main.tex.',
      'Prefer generate_image for bitmap diagrams when an image API is configured; otherwise write a simple project-local script or TikZ/LaTeX figure that can compile.',
    ];
  }
  if (route === 'result-figure') {
    return [
      ...common,
      'This task changes result visualizations. Inspect existing project scripts/data before editing.',
      'Use inspect_result_table on manuscript-linked CSV/TSV/JSON result files before changing table text or numeric claims.',
      'Inspect manuscript-linked figure/table asset paths first. Prefer regenerating the existing referenced asset at the same path; only create a new asset if no suitable manuscript reference exists yet.',
      'Modify or add project-local plotting code, run it when feasible, save outputs under .texor/figures/ or the project figure directory, and update main.tex references only when the target path truly changes.',
      'Do not fabricate metrics. If the data are unavailable, report what file or command is missing.',
    ];
  }
  if (route === 'references') {
    return [
      ...common,
      'This task concerns citations, related work, or bibliography.',
      'Use search_papers for online paper discovery, summarize only papers whose metadata/abstract you can inspect, and add conservative BibTeX or citation placeholders.',
      'Do not claim you read a paper beyond the metadata/abstract returned by tools unless you explicitly fetched and inspected more source text.',
    ];
  }
  return [
    ...common,
    'Use the smallest adequate workflow: local edit for narrow requests, broader project inspection for research/content changes.',
  ];
}

function texorAgentAllowedToolForms(policy: TaskExecutionPolicy): string[] {
  const forms = [
    '{"process":"brief user-facing writing step","tool":"read_file","args":{"path":"relative/path"}}',
    '{"process":"brief user-facing writing step","tool":"list_files","args":{"path":"relative/path","limit":80}}',
    '{"process":"brief user-facing writing step","tool":"inspect_result_table","args":{"path":"results/metrics.csv","limitRows":6}}',
    '{"process":"brief user-facing writing step","tool":"write_file","args":{"path":".texor/manuscript/main.tex","content":"..."}}',
  ];
  if (policy.allowProjectCommands) {
    forms.push('{"process":"brief user-facing writing step","tool":"run_command","args":{"command":"python script.py","timeoutMs":120000}}');
  }
  if (policy.allowFigureGeneration) {
    forms.push('{"process":"brief user-facing writing step","tool":"generate_image","args":{"prompt":"diagram prompt","outputPath":".texor/figures/diagram.png","size":"1024x1024"}}');
  }
  if (policy.allowPaperSearch) {
    forms.push('{"process":"brief user-facing writing step","tool":"search_papers","args":{"query":"paper search query","limit":5}}');
  }
  forms.push('{"process":"brief user-facing writing step","final":"short final summary"}');
  return forms;
}

function texorAgentExecutionRules(policy: TaskExecutionPolicy): string[] {
  const rules = [
    '- Read project files before making factual claims.',
    '- Do not invent results, datasets, citations, or experiments.',
    '- "process" must be a short public-facing writing step in plain language, such as "正在核对摘要与引言之间的衔接" or "已完成正文修改，正在检查术语一致性". Do not expose chain-of-thought, tool names, shell commands, or JSON handling.',
    '- Prefer inspect_result_table over raw file reading when you need structured CSV/TSV/JSON result evidence.',
    `- Current execution profile is ${executionProfileLabel(policy.profile)}.`,
    `- Current execution scope is ${executionScopeLabel(policy.scope)}.`,
  ];
  if (policy.allowProjectCommands) {
    rules.push('- Use run_command only for project-local, non-destructive commands grounded in a stored command hint or an inspected experiment/figure script.');
  } else {
    rules.push('- Do not run project commands in this lane. Limit yourself to local manuscript edits and read-only inspection.');
  }
  if (!policy.allowFigureGeneration) {
    rules.push('- Do not generate figures in this lane.');
  }
  if (!policy.allowPaperSearch) {
    rules.push('- Do not search for external papers in this lane.');
  }
  if (policy.stopAfterFirstWrite) {
    rules.push('- As soon as the local manuscript edit is written safely, finalize immediately.');
  }
  rules.push('- Follow the task speed mode: be concise and stop earlier in quick mode; do broader consistency checks in deep mode.');
  return rules;
}

function texorAgentSystemPrompt(
  rootPath: string,
  manuscriptPath: string,
  policy: TaskExecutionPolicy,
  modelConfig: ModelConfig,
  draftingMode?: DraftingMode,
): string {
  const route = policy.route;
  const taskSpeedMode = policy.speedMode;
  const workflowRules = draftingMode === 'understand-project'
    ? [
        '- This turn is only for source-repository understanding.',
        '- Do not draft manuscript prose or save a manuscript version in this phase.',
        '- Do not edit the main manuscript, bibliography files, or manuscript figures in this phase.',
        '- Use tools to inspect the repository and rewrite only the saved source-repo context file with concise verified grounding.',
      ]
    : [
        '- Prefer local manuscript edits. For selected PDF text, edit only the located LaTeX area unless consistency requires a broader change.',
        '- Keep a complete compilable LaTeX document at the main manuscript path.',
      ];

  return [
    'You are TEXOR, a research-paper agent runtime.',
    'You work by using explicit tools. You are not Codex and must not mention TEXOR, tooling, browser UI, or .texor metadata in manuscript prose.',
    '',
    `Project workspace: ${rootPath}`,
    `Main manuscript path: ${manuscriptPath}`,
    `Task route: ${routeLabel(route)}`,
    `Execution profile: ${executionProfileLabel(policy.profile)}`,
    `Execution scope: ${executionScopeLabel(policy.scope)}`,
    `Task speed mode: ${taskSpeedLabel(taskSpeedMode)}`,
    `Workflow mode: ${draftingMode || 'continue'}`,
    `Text model: ${modelConfig.model || 'gpt-4.1-mini'}`,
    `Image model: ${modelConfig.imageModel || 'gpt-image-1'}`,
    '',
    'You must respond with exactly one JSON object and no markdown.',
    'Allowed forms:',
    ...texorAgentAllowedToolForms(policy),
    '',
    'Rules:',
    ...workflowRules,
    ...texorAgentExecutionRules(policy),
    '',
    'Route-specific instructions:',
    ...texorAgentRouteInstructions(route, policy).map((line) => `- ${line}`),
    '',
    'Speed-specific instructions:',
    ...taskSpeedInstruction(taskSpeedMode).map((line) => `- ${line}`),
  ].join('\n');
}

function openAlexAbstractFromIndex(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const words: string[] = [];
  for (const [word, positions] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(positions)) {
      continue;
    }
    for (const position of positions) {
      if (typeof position === 'number') {
        words[position] = word;
      }
    }
  }
  return words.filter(Boolean).join(' ');
}

async function searchPapers(query: string, limit: number): Promise<string> {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('per-page', String(limit));
  url.searchParams.set('select', 'id,doi,title,display_name,publication_year,primary_location,authorships,abstract_inverted_index');
  const response = await fetch(url);
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`paper search failed: ${response.status} ${raw.slice(0, 500)}`);
  }
  const data = await response.json() as { results?: Array<Record<string, unknown>> };
  const results = (data.results || []).map((item) => {
    const primaryLocation = item.primary_location && typeof item.primary_location === 'object' ? item.primary_location as Record<string, unknown> : {};
    const source = primaryLocation.source && typeof primaryLocation.source === 'object' ? primaryLocation.source as Record<string, unknown> : {};
    const authors = Array.isArray(item.authorships)
      ? item.authorships
          .slice(0, 4)
          .map((entry) => {
            const author = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).author : undefined;
            return author && typeof author === 'object' ? String((author as Record<string, unknown>).display_name || '') : '';
          })
          .filter(Boolean)
      : [];
    return {
      title: String(item.title || item.display_name || ''),
      year: item.publication_year,
      venue: String(source.display_name || ''),
      authors,
      doi: item.doi,
      url: primaryLocation.landing_page_url || item.doi || item.id,
      abstract: openAlexAbstractFromIndex(item.abstract_inverted_index).slice(0, 1800),
    };
  });
  return compactToolOutput(JSON.stringify(results, null, 2), 9000);
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function compactTableCell(value: unknown, limit = 72): string {
  const raw = typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return raw.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function numericValueFromCell(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const normalized = compactTableCell(value, 120).replace(/,/g, '').replace(/%$/, '');
  if (!normalized || /^[-+]?inf(?:inity)?$/i.test(normalized) || /^nan$/i.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeNumericColumns(headers: string[], rows: unknown[][], limitColumns: number): Array<{ column: string; count: number; min: number; max: number; mean: number }> {
  const summaries: Array<{ column: string; count: number; min: number; max: number; mean: number }> = [];
  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    const numericValues = rows
      .map((row) => numericValueFromCell(row[columnIndex]))
      .filter((value): value is number => value !== null);
    if (numericValues.length === 0) {
      continue;
    }
    const total = numericValues.reduce((sum, value) => sum + value, 0);
    summaries.push({
      column: headers[columnIndex] || `col_${columnIndex + 1}`,
      count: numericValues.length,
      min: Number(Math.min(...numericValues).toFixed(6)),
      max: Number(Math.max(...numericValues).toFixed(6)),
      mean: Number((total / numericValues.length).toFixed(6)),
    });
  }
  return summaries.slice(0, limitColumns);
}

function jsonRowsFromUnknown(value: unknown, limitRows: number, limitColumns: number): {
  format: 'json-array' | 'json-object' | 'json-lines';
  headers: string[];
  rows: string[][];
  numericColumns: Array<{ column: string; count: number; min: number; max: number; mean: number }>;
  rowCount: number;
} {
  if (Array.isArray(value)) {
    if (value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
      const objects = value as Array<Record<string, unknown>>;
      const headers = [...new Set(objects.flatMap((entry) => Object.keys(entry)))].slice(0, limitColumns);
      const rows = objects
        .slice(0, limitRows)
        .map((entry) => headers.map((header) => compactTableCell(entry[header])));
      const numericColumns = summarizeNumericColumns(
        headers,
        objects.map((entry) => headers.map((header) => entry[header])),
        limitColumns,
      );
      return {
        format: 'json-array',
        headers,
        rows,
        numericColumns,
        rowCount: value.length,
      };
    }
    const headers = Array.from({ length: Math.min(limitColumns, Math.max(...value.map((entry) => Array.isArray(entry) ? entry.length : 1), 1)) }, (_, index) => `col_${index + 1}`);
    const rows = value
      .slice(0, limitRows)
      .map((entry) => Array.isArray(entry) ? entry.slice(0, limitColumns).map((cell) => compactTableCell(cell)) : [compactTableCell(entry)]);
    const numericColumns = summarizeNumericColumns(headers, value.map((entry) => Array.isArray(entry) ? entry : [entry]), limitColumns);
    return {
      format: 'json-array',
      headers,
      rows,
      numericColumns,
      rowCount: value.length,
    };
  }

  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const headers = ['key', 'value'];
  const entries = Object.entries(object);
  const rows = entries
    .slice(0, limitRows)
    .map(([key, entryValue]) => [key, compactTableCell(entryValue)]);
  const numericColumns = summarizeNumericColumns(['value'], entries.map(([, entryValue]) => [entryValue]), 1);
  return {
    format: 'json-object',
    headers,
    rows,
    numericColumns,
    rowCount: entries.length,
  };
}

async function inspectResultTable(rootPath: string, args: Record<string, unknown>): Promise<string> {
  const requested = String(args.path || '').trim();
  if (!requested) {
    throw new Error('inspect_result_table requires path.');
  }
  const filePath = safeRelativePath(rootPath, requested);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`inspect_result_table requires a file path: ${requested}`);
  }
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error(`inspect_result_table only supports files up to 2 MB for now: ${requested}`);
  }

  const limitRows = Math.max(2, Math.min(12, Number(args.limitRows || 6)));
  const limitColumns = Math.max(2, Math.min(10, Number(args.limitColumns || 6)));
  const ext = path.extname(filePath).toLowerCase();
  const raw = await fs.readFile(filePath, 'utf8');

  if (ext === '.csv' || ext === '.tsv') {
    const delimiter = ext === '.tsv' ? '\t' : ',';
    const lines = raw.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      throw new Error(`inspect_result_table found an empty file: ${requested}`);
    }
    const parsedRows = lines.map((line) => splitDelimitedLine(line, delimiter));
    const headers = parsedRows[0].slice(0, limitColumns).map((header, index) => header || `col_${index + 1}`);
    const dataRows = parsedRows.slice(1);
    const previewRows = dataRows.slice(0, limitRows).map((row) => headers.map((_, index) => compactTableCell(row[index])));
    const numericColumns = summarizeNumericColumns(
      headers,
      dataRows.map((row) => headers.map((_, index) => row[index])),
      limitColumns,
    );
    return compactToolOutput(JSON.stringify({
      path: requested,
      format: ext === '.tsv' ? 'tsv' : 'csv',
      rowCount: Math.max(0, parsedRows.length - 1),
      columnCount: headers.length,
      headers,
      previewRows,
      numericColumns,
    }, null, 2), 9000);
  }

  if (ext === '.json' || ext === '.jsonl') {
    const parsed = ext === '.jsonl'
      ? raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown)
      : JSON.parse(raw) as unknown;
    const table = jsonRowsFromUnknown(parsed, limitRows, limitColumns);
    return compactToolOutput(JSON.stringify({
      path: requested,
      format: table.format,
      rowCount: table.rowCount,
      columnCount: table.headers.length,
      headers: table.headers,
      previewRows: table.rows,
      numericColumns: table.numericColumns,
    }, null, 2), 9000);
  }

  throw new Error(`inspect_result_table supports .csv, .tsv, .json, and .jsonl files only: ${requested}`);
}

async function generateImage(rootPath: string, modelConfig: ModelConfig, args: Record<string, unknown>): Promise<string> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) {
    throw new Error('generate_image requires prompt.');
  }
  const requestedOutput = String(args.outputPath || '.texor/figures/generated-diagram.png');
  const outputPath = safeRelativePath(rootPath, requestedOutput);
  const baseUrl = (modelConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const localModelEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(baseUrl);
  if (!modelConfig.apiKey?.trim() && !localModelEndpoint) {
    throw new Error('generate_image requires an API key unless the image endpoint is local.');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (modelConfig.apiKey?.trim()) {
    headers.Authorization = `Bearer ${modelConfig.apiKey}`;
  }
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelConfig.imageModel || 'gpt-image-1',
      prompt,
      size: String(args.size || '1024x1024'),
      response_format: 'b64_json',
    }),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`image generation failed: ${response.status} ${raw.slice(0, 1200)}`);
  }
  const data = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
  const image = data.data?.[0];
  if (!image?.b64_json && !image?.url) {
    throw new Error('image generation returned no image data.');
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (image.b64_json) {
    await fs.writeFile(outputPath, Buffer.from(image.b64_json, 'base64'));
  } else if (image.url) {
    const imageResponse = await fetch(image.url);
    if (!imageResponse.ok) {
      throw new Error(`failed to download generated image: ${imageResponse.status}`);
    }
    await fs.writeFile(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
  }
  return `generated image ${path.relative(rootPath, outputPath)}`;
}

async function runTexorAgentTool(
  rootPath: string,
  call: TexorAgentToolCall,
  modelConfig: ModelConfig,
  context: TexorAgentToolContext,
): Promise<string> {
  const args = call.args || {};
  const tool = call.tool;
  if (tool === 'read_file') {
    const requested = String(args.path || '');
    const filePath = safeRelativePath(rootPath, requested);
    const raw = await fs.readFile(filePath, 'utf8');
    return compactToolOutput(raw);
  }
  if (tool === 'list_files') {
    const requested = String(args.path || '.');
    const limit = Math.max(1, Math.min(200, Number(args.limit || 80)));
    const dirPath = safeRelativePath(rootPath, requested);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .slice(0, limit)
      .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${path.join(requested, entry.name)}`)
      .join('\n');
  }
  if (tool === 'inspect_result_table') {
    return await inspectResultTable(rootPath, args);
  }
  if (tool === 'write_file') {
    const requested = String(args.path || '');
    const content = String(args.content || '');
    if (!content.trim()) {
      throw new Error('TEXOR Agent refused to write empty content.');
    }
    const relativeRequested = relativePathInsideRoot(rootPath, path.resolve(rootPath, requested));
    if (!relativeRequested) {
      throw new Error(`TEXOR Agent refused path outside project: ${requested}`);
    }
    if (!isPathAllowedForWrite(context.executionPolicy, context.route, relativeRequested, context.manuscriptState, context.analysis)) {
      throw new Error(`当前任务不允许写入该路径: ${relativeRequested}`);
    }
    if (context.executionPolicy.profile !== 'reference-research' && isBibliographyPath(relativeRequested)) {
      throw new Error(`当前任务路由不是参考文献任务，禁止写入参考文献路径: ${relativeRequested}`);
    }
    if (context.executionPolicy.loadProjectContext !== 'ensure' && normalizeProjectRelativePath(relativeRequested) === normalizeProjectRelativePath(path.join('.texor', 'agent', 'project-context.md'))) {
      throw new Error('当前任务没有开启源库上下文刷新，禁止改写 project-context.md。');
    }
    const filePath = safeRelativePath(rootPath, requested);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return `wrote ${path.relative(rootPath, filePath)} (${content.length} chars)`;
  }
  if (tool === 'run_command') {
    if (!context.executionPolicy.allowProjectCommands) {
      throw new Error('当前任务被路由到本地改写通道，禁止运行项目命令。');
    }
    const command = String(args.command || '').trim();
    if (!command) {
      throw new Error('run_command requires command.');
    }
    if (/(\brm\b|\bdel\b|\brmdir\b|\bformat\b|git\s+reset|git\s+checkout\s+--)/i.test(command)) {
      throw new Error(`TEXOR Agent refused destructive command: ${command}`);
    }
    const routeDecision = await validateTexorAgentCommand(rootPath, command, context);
    const assetSnapshotBefore = await manuscriptAssetSnapshot(rootPath, context.manuscriptState);
    const timeoutMs = Math.max(5_000, Math.min(routeDecision.timeoutCapMs, Number(args.timeoutMs || 60_000)));
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, {
        cwd: rootPath,
        shell: true,
        timeout: timeoutMs,
      });
      const chunks: string[] = [];
      child.stdout.on('data', (data) => chunks.push(data.toString()));
      child.stderr.on('data', (data) => chunks.push(data.toString()));
      child.on('error', reject);
      child.on('exit', async (code) => {
        const output = compactToolOutput(chunks.join('').trim() || `(exit ${code})`);
        const assetSnapshotAfter = await manuscriptAssetSnapshot(rootPath, context.manuscriptState);
        const changedAssets = summarizeTrackedAssetChanges(assetSnapshotBefore, assetSnapshotAfter);
        const assetLine = changedAssets.length > 0
          ? `linked manuscript assets updated: ${changedAssets.join(', ')}`
          : assetSnapshotBefore.size > 0
            ? 'linked manuscript assets updated: none detected'
            : 'linked manuscript assets updated: no tracked asset paths in current manuscript state';
        const routedOutput = compactToolOutput(`command route: ${routeDecision.routeLabel}\n${assetLine}\n${output}`, 6000);
        if (code === 0) {
          resolve(routedOutput);
          return;
        }
        reject(new Error(routedOutput || `command exited with code ${code}`));
      });
    });
  }
  if (tool === 'generate_image') {
    if (!context.executionPolicy.allowFigureGeneration) {
      throw new Error('当前任务没有开启图像生成能力。');
    }
    return await generateImage(rootPath, modelConfig, args);
  }
  if (tool === 'search_papers') {
    if (!context.executionPolicy.allowPaperSearch) {
      throw new Error('当前任务没有开启外部论文检索能力。');
    }
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('search_papers requires query.');
    }
    const limit = Math.max(1, Math.min(10, Number(args.limit || 5)));
    return await searchPapers(query, limit);
  }
  throw new Error(`Unknown TEXOR Agent tool: ${tool}`);
}

async function runQuickPolishAgent(
  payload: CodexTaskCommandPayload,
  snapshot: WorkspaceSnapshot | null,
  modelConfig: ModelConfig,
  policy: TaskExecutionPolicy,
  options: {
    onProgress?: (phase: BridgeCommandPhase, message: string) => void;
    onLog?: (stream: BridgeCommandLogStream, message: string) => void;
    controlSignal?: () => Promise<BridgeCommandControl | undefined>;
  } = {},
): Promise<string | null> {
  const rootPath = payload.projectPath;
  const manuscriptPath = manuscriptPathForWorkspace(rootPath);
  const sourceFile = relativePathInsideRoot(rootPath, payload.sourceFile)
    ? path.resolve(payload.sourceFile || manuscriptPath)
    : manuscriptPath;
  const latex = await fs.readFile(sourceFile, 'utf8').catch(() => '');
  if (!latex) {
    return null;
  }
  const span = locateQuickPolishSpan(latex, payload);
  if (!span) {
    return null;
  }
  const control = await options.controlSignal?.();
  if (control) {
    return null;
  }
  options.onProgress?.('thinking', '正在快速润色选区');
  options.onLog?.('system', '已定位到选区源码，只改这一小段。');
  const response = await callTexorAgentModel(
    [
      {
        role: 'system',
        content: [
          'You revise one selected span in a LaTeX manuscript.',
          'Return only the replacement text for that exact span.',
          'Preserve factual claims, citations, LaTeX commands, math, labels, and references.',
          `This task uses the ${executionProfileLabel(policy.profile)} in the ${executionScopeLabel(policy.scope)} and must stop after one safe replacement.`,
          'Do not return a full document. Do not explain.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Target journal: ${payload.targetJournal || snapshot?.paper.targetJournal || 'not specified'}`,
          'Selected LaTeX/text span:',
          span.text,
          '',
          'User request:',
          payload.instruction,
        ].join('\n'),
      },
    ],
    modelConfig,
  );
  const replacement = sanitizeQuickReplacement(span.text, response.content);
  const revisedLatex = `${latex.slice(0, span.start)}${replacement}${latex.slice(span.end)}`;
  await fs.writeFile(sourceFile, revisedLatex, 'utf8');
  if (path.resolve(sourceFile) !== path.resolve(manuscriptPath)) {
    await fs.writeFile(manuscriptPath, revisedLatex, 'utf8');
  }
  options.onLog?.('system', '局部替换完成，正在保存论文版本。');
  return `quick-polish replaced ${span.text.length} chars with ${replacement.length} chars in ${path.relative(rootPath, sourceFile)}`;
}

async function runTexorAgent(
  payload: CodexTaskCommandPayload,
  snapshot: WorkspaceSnapshot | null,
  options: {
    onProgress?: (phase: BridgeCommandPhase, message: string) => void;
    onLog?: (stream: BridgeCommandLogStream, message: string) => void;
    controlSignal?: () => Promise<BridgeCommandControl | undefined>;
    projectContext?: SavedProjectContext | null;
    analysis?: ProjectAnalysis | null;
  } = {},
): Promise<CodexExecResult> {
  const rootPath = payload.projectPath;
  const manuscriptPath = manuscriptPathForWorkspace(rootPath);
  const modelConfig = texorAgentModelConfig(payload.modelConfig);
  const executionPolicy = taskExecutionPolicyForPayload(payload, 'texor-agent');
  const route = executionPolicy.route;
  const taskSpeedMode = executionPolicy.speedMode;
  const sessionId = `texor-agent:${path.resolve(rootPath)}`;
  const projectAnalysis = options.analysis || snapshot?.paper.analysis;
  options.onProgress?.('connecting', `TEXOR Agent 正在连接 ${modelConfig.provider || '模型 API'}`);
  options.onLog?.('system', `进入${routeLabel(route)}模式。`);
  options.onLog?.('system', `采用${taskSpeedLabel(taskSpeedMode)}模式。`);
  options.onLog?.('system', `执行档位：${executionProfileLabel(executionPolicy.profile)}。`);
  options.onLog?.('system', `执行策略：${executionScopeLabel(executionPolicy.scope)}。`);
  options.onLog?.('system', `使用 ${modelConfig.provider || 'OpenAI-compatible'} 的 ${modelConfig.model || 'gpt-4.1-mini'}。`);
  const sourceFileRelative = relativePathInsideRoot(rootPath, payload.sourceFile);
  const memory = executionPolicy.includeConversationMemory ? await loadTexorAgentMemory(rootPath) : [];
  const projectContext = options.projectContext || (
    executionPolicy.loadProjectContext === 'ensure'
      ? await ensureSavedProjectContext(rootPath, snapshot, payload.targetJournal, projectAnalysis)
      : null
  );

  if (executionPolicy.preferDirectQuickEdit && route === 'quick-polish') {
    const quickOutput = await runQuickPolishAgent(payload, snapshot, modelConfig, executionPolicy, options);
    if (quickOutput) {
      await appendTexorAgentMemory(rootPath, {
        route,
        instruction: payload.instruction,
        targetJournal: payload.targetJournal || snapshot?.paper.targetJournal,
        sourceFile: payload.sourceFile,
        selectedText: payload.selectedText,
        summary: quickOutput,
      }).catch(() => undefined);
      return { output: quickOutput, sessionId };
    }
    options.onLog?.('system', '没有稳定定位到选区源码，切换到常规 Agent 流程。');
  }

  const messages: TexorAgentMessage[] = [
    { role: 'system', content: texorAgentSystemPrompt(rootPath, manuscriptPath, executionPolicy, modelConfig, payload.draftingMode) },
    {
      role: 'user',
      content: [
        `Target journal: ${payload.targetJournal || snapshot?.paper.targetJournal || 'not specified'}`,
        snapshot ? `Current version: ${snapshot.currentVersion.label}` : 'No stored manuscript version yet.',
        projectContext ? `Saved source-repo context file: ${projectContext.path}` : undefined,
        projectContext ? `Saved source-repo context:\n${projectContextPromptText(projectContext.content)}` : undefined,
        payload.draftingMode === 'understand-project'
          ? 'This is the source-understanding stage. Inspect the repository and rewrite the saved source-repo context file before any manuscript drafting.'
          : payload.draftingMode === 'initial-draft'
          ? 'Before broad manuscript drafting, first inspect the repository and refresh the saved source-repo context file above.'
          : projectContext
            ? 'Reuse the saved source-repo context above and update it if the current task uncovers a better-grounded understanding.'
            : 'No saved source-repo context was loaded for this lane. Stay scoped to the immediate writing task unless broader grounding is required.',
        `Project dossier:\n${formatProjectDossierForAgent(projectAnalysis)}`,
        payload.draftingMode === 'understand-project'
          ? undefined
          : `Current manuscript state:\n${formatManuscriptStateForAgent(snapshot?.currentVersion.manuscriptState, snapshot?.currentVersion.changeSummary)}`,
        payload.draftingMode === 'understand-project'
          ? undefined
          : `Revision region plan:\n${formatRevisionRegionPlanForAgent(payload, snapshot, route)}`,
        executionPolicy.includeConversationMemory ? `Prior project conversation memory:\n${formatTexorAgentMemory(memory)}` : undefined,
        payload.selectedText ? `Selected PDF text:\n${payload.selectedText}` : undefined,
        payload.sourceFile ? `Located source: ${payload.sourceFile}${payload.sourceLine ? `:${payload.sourceLine}` : ''}` : undefined,
        sourceFileRelative ? `Located source relative path for tools: ${sourceFileRelative}` : undefined,
        payload.sourceSnippet ? `Nearby source snippet:\n${payload.sourceSnippet}` : undefined,
        '',
        `User request:\n${payload.instruction}`,
      ].filter((line): line is string => line !== undefined).join('\n'),
    },
  ];

  let output = '';
  const maxSteps = executionPolicy.maxSteps;
  for (let step = 0; step < maxSteps; step += 1) {
    const control = await options.controlSignal?.();
    if (control) {
      return { output, sessionId, interruptedBy: control };
    }
    options.onProgress?.(
      step === 0 ? 'thinking' : 'working',
      payload.draftingMode === 'understand-project'
        ? (step === 0
          ? (taskSpeedMode === 'quick' ? '正在快速理解源库' : '正在理解源库并整理研究上下文')
          : (taskSpeedMode === 'quick' ? '正在补全源库理解' : '正在核对源库证据并更新上下文'))
        : payload.draftingMode === 'initial-draft'
        ? (step === 0
          ? (taskSpeedMode === 'quick' ? '正在快速搭建论文初稿' : '正在理解项目并搭建论文结构')
          : (taskSpeedMode === 'quick' ? '正在快速扩展初稿' : '正在扩展论文初稿'))
        : route === 'quick-polish'
          ? (taskSpeedMode === 'quick' ? '正在快速做局部修改' : '正在做局部修改')
          : `正在${routeLabel(route)}`,
    );
    const response = await callTexorAgentModel(messages, modelConfig);
    output += `\n${response.content}`;
    const parsed = extractJsonObject(response.content);
    if (!parsed) {
      throw new Error(`TEXOR Agent model did not return valid JSON: ${response.content.slice(0, 500)}`);
    }
    options.onLog?.('system', texorProcessSummaryFromParsed(parsed));
    if (typeof parsed.final === 'string') {
      options.onProgress?.('finalizing', 'TEXOR Agent 正在收尾');
      await appendTexorAgentMemory(rootPath, {
        route,
        instruction: payload.instruction,
        targetJournal: payload.targetJournal || snapshot?.paper.targetJournal,
        sourceFile: payload.sourceFile,
        selectedText: payload.selectedText,
        summary: parsed.final,
      }).catch(() => undefined);
      return { output, answer: parsed.final, sessionId };
    }
    const tool = typeof parsed.tool === 'string' ? parsed.tool : '';
    if (!tool) {
      throw new Error('TEXOR Agent response needs either final or tool.');
    }
    const toolResult = await runTexorAgentTool(rootPath, {
      tool,
      args: parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? parsed.args as Record<string, unknown> : {},
    }, modelConfig, {
      route,
      taskSpeedMode,
      executionPolicy,
      analysis: snapshot?.paper.analysis,
      manuscriptState: snapshot?.currentVersion.manuscriptState,
    });
    options.onLog?.('stdout', `${tool}: ${compactToolOutput(toolResult, 1200)}`);
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: `Tool result from ${tool}:\n${toolResult}` });
  }
  throw new Error('TEXOR Agent reached the step limit before finishing.');
}

function compactReadableText(message: string, limit = 900): string {
  const normalized = message
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textFromUnknown).filter(Boolean).join('\n');
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'message', 'output', 'summary']) {
    const text = textFromUnknown(record[key]);
    if (text) {
      return text;
    }
  }
  return '';
}

function commandTextFromItem(item: Record<string, unknown>): string {
  const direct = textFromUnknown(item.command || item.cmd || item.formatted_command || item.command_line);
  if (direct) {
    return direct;
  }
  const args = item.arguments || item.args;
  if (Array.isArray(args)) {
    return args.map((part) => String(part)).join(' ');
  }
  return '';
}

function commandResultTextFromItem(item: Record<string, unknown>): string {
  const direct = textFromUnknown(item.output || item.result || item.error || item.stderr || item.stdout);
  return direct ? compactReadableText(direct, 1800) : '';
}

function isNoisyCommandLog(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.startsWith('openai codex ') ||
    normalized.startsWith('user # texor') ||
    normalized.startsWith('exec ') ||
    normalized.startsWith('/bin/bash ') ||
    normalized.startsWith('workdir:') ||
    normalized.startsWith('model:') ||
    normalized.startsWith('provider:') ||
    normalized.startsWith('approval:') ||
    normalized.startsWith('sandbox:') ||
    normalized.startsWith('reasoning ') ||
    normalized.includes(' succeeded in ') ||
    /^succeeded in \d+ms:/.test(normalized) ||
    /^completed in \d+ms:/.test(normalized) ||
    normalized.length > 2200 ||
    normalized.includes('/.texor/codex-feedback/') ||
    normalized.includes('.texor/codex-feedback')
  );
}

function codexReadableLogFromEvent(event: Record<string, unknown>): CodexReadableLog | null {
  if (event.type === 'thread.started') {
    return { stream: 'system', message: 'Codex 会话已启动。' };
  }
  if (event.type === 'turn.started') {
    return { stream: 'system', message: 'Codex 开始处理这一轮请求。' };
  }
  if (event.type === 'turn.completed') {
    return { stream: 'system', message: 'Codex 完成本轮处理。' };
  }
  if (event.type === 'turn.failed') {
    const error = event.error as Record<string, unknown> | undefined;
    const detail = typeof error?.message === 'string' ? compactReadableText(error.message, 1800) : '';
    return { stream: 'stderr', message: detail ? `Codex 本轮没有正常完成。\n${detail}` : 'Codex 本轮没有正常完成。' };
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    return { stream: 'stderr', message: compactReadableText(event.message, 1800) };
  }

  const item = event.item as Record<string, unknown> | undefined;
  if (!item) {
    return null;
  }

  const itemType = item.type;
  if (itemType === 'agent_message' || itemType === 'message') {
    return null;
  }

  if (itemType === 'command_execution' || itemType === 'tool_call') {
    const commandText = compactReadableText(commandTextFromItem(item), 220);
    const resultText = commandResultTextFromItem(item);
    if (isNoisyCommandLog(commandText) && !resultText) {
      return null;
    }
    const status = typeof item.status === 'string' ? item.status : '';
    if (status === 'in_progress' || status === 'running') {
      return { stream: 'system', message: commandText ? `运行命令:\n${commandText}` : 'Codex 正在操作项目文件。' };
    }
    if (status === 'failed' || status === 'error') {
      return {
        stream: 'stderr',
        message: [commandText ? `命令失败:\n${commandText}` : 'Codex 的一步操作失败。', resultText].filter(Boolean).join('\n\n'),
      };
    }
    return {
      stream: 'system',
      message: [commandText ? `完成命令:\n${commandText}` : 'Codex 完成一步项目操作。', resultText].filter(Boolean).join('\n\n'),
    };
  }

  if (itemType === 'file_change' || itemType === 'patch') {
    const target = textFromUnknown(item.path || item.file || item.files);
    return { stream: 'system', message: target ? `修改文件: ${target}` : 'Codex 正在写入文件修改。' };
  }

  if (itemType === 'reasoning' || itemType === 'thinking') {
    return { stream: 'system', message: 'Codex 正在分析上下文。' };
  }

  return null;
}

function suppressCodexRawLogFallback(event: Record<string, unknown>): boolean {
  const item = event.item as Record<string, unknown> | undefined;
  if (!item) {
    return false;
  }
  return item.type === 'agent_message' || item.type === 'message';
}

function codexProgressFromEvent(event: Record<string, unknown>): { phase: BridgeCommandPhase; message: string } | null {
  if (event.type === 'thread.started') {
    return { phase: 'thinking', message: 'Codex 已开始理解任务' };
  }
  if (event.type === 'turn.started') {
    return { phase: 'thinking', message: 'Codex 正在思考怎么处理' };
  }
  if (event.type === 'turn.completed') {
    return { phase: 'finalizing', message: 'Codex 正在收尾' };
  }

  const item = event.item as Record<string, unknown> | undefined;
  if (!item) {
    return null;
  }

  if (item.type === 'command_execution') {
    if (item.status === 'in_progress') {
      return { phase: 'working', message: 'Codex 正在执行一个项目步骤' };
    }
    return { phase: 'thinking', message: 'Codex 已完成一步项目操作' };
  }
  if (item.type === 'agent_message') {
    return { phase: 'finalizing', message: 'Codex 正在整理结果' };
  }
  return null;
}

function normalizeAssistantAnswerText(value: string): string {
  return value.replace(/\r/g, '').trim();
}

function chooseBetterAssistantAnswer(current: string, next: string): string {
  const currentText = normalizeAssistantAnswerText(current);
  const nextText = normalizeAssistantAnswerText(next);
  if (!nextText) {
    return currentText;
  }
  if (!currentText) {
    return nextText;
  }
  const currentFlat = currentText.replace(/\s+/g, ' ');
  const nextFlat = nextText.replace(/\s+/g, ' ');
  if (currentFlat === nextFlat) {
    return currentText.length >= nextText.length ? currentText : nextText;
  }
  if (nextFlat.includes(currentFlat)) {
    return nextText;
  }
  if (currentFlat.includes(nextFlat)) {
    return currentText;
  }
  return nextText.length >= currentText.length ? nextText : currentText;
}

function extractLikelyAssistantAnswerFromOutput(output: string): string | undefined {
  const cleanedLines = output
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('{'))
    .filter((line) => !isNoisyCommandLog(line))
    .filter((line) => !/^codex\b/i.test(line))
    .filter((line) => !/^claude\b/i.test(line));
  if (!cleanedLines.length) {
    return undefined;
  }
  const merged = compactReadableText(cleanedLines.join('\n\n'), 8000).trim();
  return merged || undefined;
}

function resolvedAssistantAnswer(answer: string | undefined, output: string, backend: AgentBackend): string | undefined {
  const explicit = compactReadableText(answer || '', 8000).trim();
  if (explicit) {
    return explicit;
  }
  const extracted = extractLikelyAssistantAnswerFromOutput(output);
  if (extracted) {
    return extracted;
  }
  if (backend === 'codex-native') {
    return undefined;
  }
  const fallback = output.trim();
  return fallback ? fallback.slice(-8000) : undefined;
}

function codexCompletionEvent(event: Record<string, unknown>): boolean {
  return event.type === 'turn.completed';
}

function codexAnswerFromEvent(event: Record<string, unknown>): string | null {
  const item = event.item as Record<string, unknown> | undefined;
  if (!item) {
    return null;
  }
  if (item.type === 'agent_message' || item.type === 'message') {
    const text = compactReadableText(textFromUnknown(item), 8000);
    if (!text || isNoisyCommandLog(text)) {
      return null;
    }
    return text;
  }
  return null;
}

async function runCodexExec(
  prompt: string,
  cwd: string,
  options: {
    backend?: AgentBackend;
    model?: string;
    reasoningEffort?: string;
    resumeSessionId?: string;
    useEphemeralSession?: boolean;
    timeoutMs?: number;
    onProgress?: (phase: BridgeCommandPhase, message: string) => void;
    onLog?: (stream: BridgeCommandLogStream, message: string) => void;
    onSession?: (sessionId: string) => void;
    controlSignal?: () => Promise<BridgeCommandControl | undefined>;
  } = {},
): Promise<CodexExecResult> {
  const executable = await resolveCodexExecutable();
  const reasoningEffort = options.reasoningEffort?.trim();
  const args = options.resumeSessionId
    ? [
        'exec',
        'resume',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--json',
        ...(options.useEphemeralSession ? ['--ephemeral'] : []),
        ...(options.model ? ['--model', options.model] : []),
        ...(reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : []),
        options.resumeSessionId,
        '-',
      ]
    : [
        'exec',
        '--cd',
        cwd,
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--json',
        ...(options.useEphemeralSession ? ['--ephemeral'] : []),
        ...(options.model ? ['--model', options.model] : []),
        ...(reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : []),
        '-',
      ];
  const spawnCommand = codexSpawnCommand(executable, args);
  options.onProgress?.('connecting', '正在连接 Codex');
  options.onLog?.('system', `启动 Codex CLI: ${spawnCommand.display}`);
  if (options.model) {
    options.onLog?.('system', reasoningEffort ? `使用 Codex 配置: ${options.model} · ${reasoningEffort}` : `使用 Codex 模型: ${options.model}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      spawnCommand.executable,
      spawnCommand.args,
      {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: spawnCommand.shell,
      },
    );

    let stdout = '';
    const stderrChunks: Buffer[] = [];
    let jsonBuffer = '';
    let stderrBuffer = '';
    let sessionId: string | undefined;
    let interruptedBy: BridgeCommandControl | undefined;
    let toolFailure: Error | undefined;
    let latestAnswer = '';
    let completedTurn = false;
    let settled = false;
    let checkingControl = false;
    const heartbeat = setInterval(() => {
      options.onProgress?.('thinking', 'Codex 仍在处理');
    }, 30_000);
    const controlTimer = setInterval(() => {
      if (!options.controlSignal || checkingControl || interruptedBy || settled) {
        return;
      }
      checkingControl = true;
      options
        .controlSignal()
        .then((control) => {
          if (!control || interruptedBy || settled) {
            return;
          }
          interruptedBy = control;
          options.onProgress?.(control === 'pause' ? 'interrupted' : 'failed', control === 'pause' ? '正在暂停并保存当前草稿' : '正在终止本次撰写');
          options.onLog?.('system', control === 'pause' ? '收到暂停请求，正在保存已生成内容。' : '收到终止请求，正在结束本次撰写。');
          child.kill('SIGTERM');
        })
        .catch(() => undefined)
        .finally(() => {
          checkingControl = false;
        });
    }, 1200);
    const timeoutMs = Math.max(5 * 60 * 1000, options.timeoutMs || 30 * 60 * 1000);
    const timeout = setTimeout(() => {
      clearInterval(heartbeat);
      clearInterval(controlTimer);
      child.kill('SIGTERM');
      reject(new Error(`Codex task timed out after ${Math.round(timeoutMs / 60_000)} minutes.`));
    }, timeoutMs);
    let completionTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleFastFinish = () => {
      completedTurn = true;
      if (completionTimer || settled || interruptedBy) {
        return;
      }
      completionTimer = setTimeout(() => {
        if (settled || interruptedBy) {
          return;
        }
        options.onLog?.('system', '已收到 Codex 完成信号，正在结束收尾阶段。');
        child.kill('SIGTERM');
      }, POST_COMPLETION_GRACE_MS);
    };

    child.on('spawn', () => {
      options.onProgress?.('thinking', options.resumeSessionId ? '已回到上次 Codex 会话' : 'Codex 已启动');
      options.onLog?.('system', options.resumeSessionId ? '已回到上次 Codex 会话。' : 'Codex 进程已启动。');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      jsonBuffer += text;
      const lines = jsonBuffer.split(/\r?\n/);
      jsonBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) {
          if (trimmed) {
            options.onLog?.('stdout', compactReadableText(trimmed, 2000));
          }
          continue;
        }
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          const threadId = event.thread_id;
          if (typeof threadId === 'string') {
            sessionId = threadId;
            options.onSession?.(threadId);
          }
          const progress = codexProgressFromEvent(event);
          if (progress) {
            options.onProgress?.(progress.phase, progress.message);
          }
          if (codexCompletionEvent(event)) {
            scheduleFastFinish();
          }
          const answer = codexAnswerFromEvent(event);
          if (answer) {
            latestAnswer = chooseBetterAssistantAnswer(latestAnswer, answer);
          }
          const readableLog = codexReadableLogFromEvent(event);
          if (readableLog) {
            options.onLog?.(readableLog.stream, readableLog.message);
          } else if (trimmed && !suppressCodexRawLogFallback(event)) {
            options.onLog?.('stdout', compactReadableText(trimmed, 2000));
          }
          if (readableLog && isToolLayerWriteFailure(readableLog.message)) {
            toolFailure = new Error('Codex 工具层写入失败，已停止本次任务；不会保存替代文本为论文版本。');
            options.onProgress?.('failed', 'Codex 工具层写入失败');
            options.onLog?.('stderr', toolFailure.message);
            child.kill('SIGTERM');
            return;
          }
        } catch {
          options.onLog?.('stdout', compactReadableText(trimmed, 2000));
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += decodeProcessOutput([chunk]);
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          options.onLog?.('stderr', compactReadableText(trimmed, 2000));
        }
      }
    });
    child.on('error', (error) => {
      settled = true;
      clearInterval(heartbeat);
      clearInterval(controlTimer);
      clearTimeout(timeout);
      if (completionTimer) {
        clearTimeout(completionTimer);
      }
      const rawMessage = error.message || String(error);
      options.onLog?.('stderr', compactCodexError(rawMessage));
      reject(new Error(rawMessage));
    });
    child.on('close', (code) => {
      settled = true;
      clearInterval(heartbeat);
      clearInterval(controlTimer);
      clearTimeout(timeout);
      if (completionTimer) {
        clearTimeout(completionTimer);
      }
      const trailingStderr = stderrBuffer.trim();
      if (trailingStderr) {
        options.onLog?.('stderr', compactReadableText(trailingStderr, 2000));
      }
      const stderr = decodeProcessOutput(stderrChunks);
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      const finalAnswer = resolvedAssistantAnswer(latestAnswer || undefined, output, options.backend || 'codex-cli');
      if (interruptedBy) {
        resolve({ output, answer: finalAnswer, sessionId, interruptedBy });
        return;
      }
      if (toolFailure || isToolLayerWriteFailure(output)) {
        reject(toolFailure || new Error('Codex 工具层写入失败，已停止本次任务；不会保存替代文本为论文版本。'));
        return;
      }
      if (code === 0 || completedTurn) {
        options.onLog?.('system', 'Codex CLI 正常退出。');
        resolve({ output, answer: finalAnswer, sessionId });
      } else {
        const rawMessage = output || `Codex exited with code ${code}.`;
        options.onLog?.('stderr', compactCodexError(rawMessage));
        reject(new Error(rawMessage));
      }
    });
    child.stdin.end(prompt);
  });
}

async function resolveClaudeExecutable(): Promise<string> {
  if (cachedClaudeExecutable) {
    return cachedClaudeExecutable;
  }
  const configured = claudeExecutable().trim();
  const candidates = configured && configured !== 'claude' ? [configured, 'claude'] : ['claude'];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
      if (await fileExists(candidate)) {
        const normalizedCandidate = await preferWindowsCodexLauncher(candidate);
        if (candidateMatchesCurrentPlatform(normalizedCandidate)) {
          cachedClaudeExecutable = normalizedCandidate;
          return normalizedCandidate;
        }
      }
      continue;
    }

    try {
      const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
      const { stdout } = await execFileAsync(lookup, [candidate]);
      const first = await firstUsableCodexCandidate(
        stdout
          .trim()
          .split(/\r?\n/)
          .filter(Boolean),
      );
      if (first) {
        cachedClaudeExecutable = first;
        return first;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('Unable to locate the Claude Code CLI. Set texor.claudeExecutable to the full path, or install Claude Code so the `claude` command is on PATH.');
}

function claudeEventInner(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const inner = event.event;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return undefined;
}

function claudeSessionIdFromEvent(event: Record<string, unknown>): string | undefined {
  const inner = claudeEventInner(event);
  const sessionId = event.session_id || event.sessionId || inner?.session_id || inner?.sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

function claudeTextFromEvent(event: Record<string, unknown>): string {
  const inner = claudeEventInner(event);
  const delta = inner?.delta as Record<string, unknown> | undefined;
  if (typeof delta?.text === 'string') {
    return delta.text;
  }
  if (typeof inner?.text === 'string') {
    return inner.text;
  }
  const innerText = inner ? textFromUnknown(inner) : '';
  return innerText || textFromUnknown(event);
}

function claudeReadableLogFromEvent(event: Record<string, unknown>): CodexReadableLog | null {
  const inner = claudeEventInner(event);
  const innerType = typeof inner?.type === 'string' ? inner.type : '';

  if (event.type === 'system' && event.subtype === 'init') {
    return { stream: 'system', message: 'Claude Code 会话已启动。' };
  }
  if (event.type === 'system' && event.subtype === 'api_retry') {
    return { stream: 'system', message: 'Claude Code 正在重试 API。' };
  }
  if (event.type === 'result') {
    return { stream: 'system', message: 'Claude Code 已生成结果。' };
  }

  if (innerType === 'content_block_start') {
    const contentBlock = inner?.content_block as Record<string, unknown> | undefined;
    if (contentBlock?.type === 'tool_use') {
      const name = typeof contentBlock.name === 'string' ? contentBlock.name : 'tool';
      return { stream: 'system', message: `Claude 正在调用工具: ${name}` };
    }
  }
  if (innerType === 'message_stop') {
    return { stream: 'system', message: 'Claude Code 正在收尾。' };
  }

  const text = claudeTextFromEvent(event);
  return text ? { stream: 'stdout', message: compactReadableText(text, 1800) } : null;
}

function claudeProgressFromEvent(event: Record<string, unknown>): { phase: BridgeCommandPhase; message: string } | null {
  const inner = claudeEventInner(event);
  const innerType = typeof inner?.type === 'string' ? inner.type : '';

  if (event.type === 'system' && event.subtype === 'init') {
    return { phase: 'thinking', message: 'Claude Code 已开始理解任务' };
  }
  if (event.type === 'system' && event.subtype === 'api_retry') {
    return { phase: 'thinking', message: 'Claude Code 正在重试请求' };
  }
  if (event.type === 'result') {
    return { phase: 'finalizing', message: 'Claude Code 正在收尾' };
  }
  if (innerType === 'content_block_start' || innerType === 'content_block_delta') {
    return { phase: 'working', message: 'Claude Code 正在调用工具或生成内容' };
  }
  if (innerType === 'message_stop') {
    return { phase: 'finalizing', message: 'Claude Code 正在整理结果' };
  }
  return null;
}

function claudeCompletionEvent(event: Record<string, unknown>): boolean {
  const inner = claudeEventInner(event);
  const innerType = typeof inner?.type === 'string' ? inner.type : '';
  return event.type === 'result' || innerType === 'message_stop';
}

async function runClaudeCodeExec(
  prompt: string,
  cwd: string,
  options: {
    model?: string;
    resumeSessionId?: string;
    timeoutMs?: number;
    onProgress?: (phase: BridgeCommandPhase, message: string) => void;
    onLog?: (stream: BridgeCommandLogStream, message: string) => void;
    onSession?: (sessionId: string) => void;
    controlSignal?: () => Promise<BridgeCommandControl | undefined>;
  } = {},
): Promise<CodexExecResult> {
  const executable = await resolveClaudeExecutable();
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    'Bash,Read,Edit',
  ];
  const model = options.model || '';
  if (model) {
    args.push('--model', model);
  }
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }
  const spawnCommand = codexSpawnCommand(executable, args);
  options.onProgress?.('connecting', '正在连接 Claude Code');
  options.onLog?.('system', `启动 Claude Code CLI: ${spawnCommand.display}`);
  if (model) {
    options.onLog?.('system', `使用 Claude 模型: ${model}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      spawnCommand.executable,
      spawnCommand.args,
      {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: spawnCommand.shell,
      },
    );

    let outputText = '';
    let latestAnswer = '';
    const stderrChunks: Buffer[] = [];
    let jsonBuffer = '';
    let textBuffer = '';
    let stderrBuffer = '';
    let sawTextDelta = false;
    let sessionId: string | undefined;
    let interruptedBy: BridgeCommandControl | undefined;
    let completedTurn = false;
    let settled = false;
    let checkingControl = false;
    const heartbeat = setInterval(() => {
      options.onProgress?.('thinking', 'Claude Code 仍在处理');
    }, 30_000);
    const controlTimer = setInterval(() => {
      if (!options.controlSignal || checkingControl || interruptedBy || settled) {
        return;
      }
      checkingControl = true;
      options
        .controlSignal()
        .then((control) => {
          if (!control || interruptedBy || settled) {
            return;
          }
          interruptedBy = control;
          options.onProgress?.(control === 'pause' ? 'interrupted' : 'failed', control === 'pause' ? '正在暂停并保存当前草稿' : '正在终止本次撰写');
          options.onLog?.('system', control === 'pause' ? '收到暂停请求，正在保存已生成内容。' : '收到终止请求，正在结束本次撰写。');
          child.kill('SIGTERM');
        })
        .catch(() => undefined)
        .finally(() => {
          checkingControl = false;
        });
    }, 1200);
    const timeoutMs = Math.max(5 * 60 * 1000, options.timeoutMs || 30 * 60 * 1000);
    const timeout = setTimeout(() => {
      clearInterval(heartbeat);
      clearInterval(controlTimer);
      child.kill('SIGTERM');
      reject(new Error(`Claude Code task timed out after ${Math.round(timeoutMs / 60_000)} minutes.`));
    }, timeoutMs);
    let completionTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleFastFinish = () => {
      completedTurn = true;
      if (completionTimer || settled || interruptedBy) {
        return;
      }
      completionTimer = setTimeout(() => {
        if (settled || interruptedBy) {
          return;
        }
        options.onLog?.('system', '已收到 Claude 完成信号，正在结束收尾阶段。');
        child.kill('SIGTERM');
      }, POST_COMPLETION_GRACE_MS);
    };

    const flushStdout = () => {
      const text = textBuffer.trim();
      if (!text) {
        textBuffer = '';
        return;
      }
      options.onLog?.('stdout', compactReadableText(text, 2000));
      textBuffer = '';
    };

    child.on('spawn', () => {
      options.onProgress?.('thinking', options.resumeSessionId ? '已回到上次 Claude Code 会话' : 'Claude Code 已启动');
      options.onLog?.('system', options.resumeSessionId ? '已回到上次 Claude Code 会话。' : 'Claude Code 进程已启动。');
      child.stdin.write(`${prompt}\n`);
      child.stdin.end();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      jsonBuffer += text;
      const lines = jsonBuffer.split(/\r?\n/);
      jsonBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          const nextSessionId = claudeSessionIdFromEvent(event);
          if (nextSessionId) {
            sessionId = nextSessionId;
            options.onSession?.(nextSessionId);
          }
          const progress = claudeProgressFromEvent(event);
          if (progress) {
            options.onProgress?.(progress.phase, progress.message);
          }
          if (claudeCompletionEvent(event)) {
            scheduleFastFinish();
          }
          const readableLog = claudeReadableLogFromEvent(event);
          if (readableLog) {
            options.onLog?.(readableLog.stream, readableLog.message);
          }
          const delta = claudeTextFromEvent(event);
          if (delta) {
            latestAnswer += delta;
            sawTextDelta = true;
            outputText += delta;
            textBuffer += delta;
            if (delta.includes('\n') || textBuffer.length > 240) {
              flushStdout();
            }
          } else if (event.type === 'result' && !sawTextDelta) {
            const fallbackText = textFromUnknown(event.result);
            if (fallbackText) {
              outputText += fallbackText;
              textBuffer += fallbackText;
              flushStdout();
            }
          }
        } catch {
          options.onLog?.('stdout', compactReadableText(trimmed, 2000));
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += decodeProcessOutput([chunk]);
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          options.onLog?.('stderr', compactReadableText(trimmed, 2000));
        }
      }
    });
    child.on('error', (error) => {
      settled = true;
      clearInterval(heartbeat);
      clearInterval(controlTimer);
      clearTimeout(timeout);
      if (completionTimer) {
        clearTimeout(completionTimer);
      }
      flushStdout();
      const rawMessage = error.message || String(error);
      options.onLog?.('stderr', compactCodexError(rawMessage));
      reject(new Error(rawMessage));
    });
    child.on('close', (code) => {
      settled = true;
      clearInterval(heartbeat);
      clearInterval(controlTimer);
      clearTimeout(timeout);
      if (completionTimer) {
        clearTimeout(completionTimer);
      }
      flushStdout();
      const trailingStderr = stderrBuffer.trim();
      if (trailingStderr) {
        options.onLog?.('stderr', compactReadableText(trailingStderr, 2000));
      }
      const stderr = decodeProcessOutput(stderrChunks);
      const output = [outputText, stderr].filter(Boolean).join('\n').trim();
      if (interruptedBy) {
        resolve({ output, answer: latestAnswer.trim() || undefined, sessionId, interruptedBy });
        return;
      }
      if (code === 0 || completedTurn) {
        options.onLog?.('system', 'Claude Code 正常退出。');
        resolve({ output, answer: latestAnswer.trim() || undefined, sessionId });
      } else {
        const rawMessage = output || `Claude Code exited with code ${code}.`;
        options.onLog?.('stderr', compactCodexError(rawMessage));
        reject(new Error(rawMessage));
      }
    });
  });
}

async function ensureTexorRunning(context: vscode.ExtensionContext): Promise<void> {
  const currentUrl = serverUrl();
  if (await workbenchHealthyAt(currentUrl)) {
    runtimeServerUrl = currentUrl;
    runtimeWebUrl = currentUrl;
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Starting texor',
      cancellable: false,
    },
    async () => {
      const root = bundledAppPath(context);
      await fs.access(path.join(root, 'dist-server', 'index.js'));
      await fs.access(path.join(root, 'web', 'index.html'));

      const launch = await chooseWorkbenchUrl(configuredServerUrl());
      runtimeServerUrl = launch.url;
      runtimeWebUrl = launch.url;
      if (launch.reuse) {
        return;
      }

      if (texorServerProcess && !texorServerProcess.killed) {
        texorServerProcess.kill();
      }

      const configuredUrl = new URL(launch.url);
      const port = configuredUrl.port || '4174';
      texorServerProcess = spawn(process.execPath, [path.join(root, 'dist-server', 'index.js')], {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          ELECTRON_RUN_AS_NODE: '1',
          PORT: port,
          TEXOR_APP_ROOT: root,
          TEXOR_DATA_DIR: context.globalStorageUri.fsPath,
        },
        detached: false,
        stdio: 'ignore',
      });
      texorServerProcess.unref();

      const startedAt = Date.now();
      while (!(await workbenchHealthyAt(launch.url))) {
        if (Date.now() - startedAt > 30_000) {
          throw new Error('texor backend did not start within 30 seconds.');
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
  );

  if (!(await backendHealthy())) {
    throw new Error('texor backend did not start.');
  }
}

async function refreshLatestWorkspaceState(context: vscode.ExtensionContext): Promise<WorkspaceSnapshot | null> {
  const storedPaperId = context.workspaceState.get<string>(stateKeys.paperId);
  if (storedPaperId) {
    try {
      const snapshot = await request<WorkspaceSnapshot>(`/api/papers/${storedPaperId}`);
      await context.workspaceState.update(stateKeys.versionId, snapshot.currentVersion.id);
      return snapshot;
    } catch {
      await context.workspaceState.update(stateKeys.paperId, undefined);
      await context.workspaceState.update(stateKeys.versionId, undefined);
    }
  }

  try {
    const snapshot = await request<WorkspaceSnapshot>('/api/workspace/latest');
    await context.workspaceState.update(stateKeys.paperId, snapshot.paper.id);
    await context.workspaceState.update(stateKeys.versionId, snapshot.currentVersion.id);
    return snapshot;
  } catch {
    return null;
  }
}

async function refreshWorkspaceStateForCommand(context: vscode.ExtensionContext, payload: CodexTaskCommandPayload): Promise<WorkspaceSnapshot | null> {
  if (payload.paperId) {
    try {
      const snapshot = await request<WorkspaceSnapshot>(`/api/papers/${payload.paperId}`);
      await context.workspaceState.update(stateKeys.paperId, snapshot.paper.id);
      await context.workspaceState.update(stateKeys.versionId, snapshot.currentVersion.id);
      return snapshot;
    } catch {
      // Fall back to the latest state so recovery can still continue from the project path.
    }
  }

  if (payload.projectPath) {
    const projectKey = path.resolve(payload.projectPath);
    const summaries = await request<WorkspaceSummary[]>('/api/workspaces').catch(() => []);
    const matched = summaries.find((summary) => summary.projectRoot && path.resolve(summary.projectRoot) === projectKey);
    if (matched) {
      try {
        const snapshot = await request<WorkspaceSnapshot>(`/api/papers/${matched.paperId}`);
        await context.workspaceState.update(stateKeys.paperId, snapshot.paper.id);
        await context.workspaceState.update(stateKeys.versionId, snapshot.currentVersion.id);
        return snapshot;
      } catch {
        // Latest-state fallback below can still recover a draft-only project.
      }
    }
  }

  const snapshot = await refreshLatestWorkspaceState(context);
  if (!payload.projectPath || snapshotMatchesCommand(snapshot, payload)) {
    return snapshot;
  }
  return null;
}

async function scanProjectAnalysis(projectPath: string): Promise<ProjectAnalysis> {
  return request<ProjectAnalysis>('/api/projects/scan', {
    method: 'POST',
    body: JSON.stringify({ rootPath: projectPath }),
  });
}

async function readLatexFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function activeLatex(preferredPath?: string): Promise<string> {
  if (preferredPath) {
    const preferredLatex = await readLatexFile(preferredPath);
    if (preferredLatex) {
      return preferredLatex;
    }
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'latex') {
    return editor.document.getText();
  }
  if (editor && editor.document.uri.fsPath.toLowerCase().endsWith('.tex')) {
    return editor.document.getText();
  }

  const texFiles = await vscode.workspace.findFiles('**/*.tex', '**/{node_modules,.texor-data,dist,dist-server}/**', 20);
  if (texFiles.length === 1) {
    const document = await vscode.workspace.openTextDocument(texFiles[0]);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    return document.getText();
  }

  if (texFiles.length > 1) {
    const picked = await vscode.window.showQuickPick(
      texFiles.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        uri,
      })),
      { title: 'Select LaTeX file to submit to texor' },
    );
    if (picked) {
      const document = await vscode.workspace.openTextDocument(picked.uri);
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      return document.getText();
    }
  }

  throw new Error('Open or create a LaTeX document before submitting to texor.');
}

async function writeCanonicalManuscript(projectRoot: string, latex: string): Promise<string> {
  const manuscriptPath = manuscriptPathForWorkspace(projectRoot);
  await fs.mkdir(path.dirname(manuscriptPath), { recursive: true });
  await fs.writeFile(manuscriptPath, latex, 'utf8');
  return manuscriptPath;
}

function fallbackDocumentClass(targetJournal: string): string {
  const lower = targetJournal.toLowerCase();
  if (lower.includes('ieee')) {
    return '\\documentclass[conference]{IEEEtran}';
  }
  if (lower.includes('acm')) {
    return '\\documentclass[sigconf]{acmart}';
  }
  if (lower.includes('elsevier') || lower.includes('information sciences') || lower.includes('pattern recognition')) {
    return '\\documentclass[preprint,12pt]{elsarticle}';
  }
  if (lower.includes('springer') || lower.includes('lncs')) {
    return '\\documentclass[runningheads]{llncs}';
  }
  return '\\documentclass[11pt]{article}';
}

function escapedLatexComment(value: string): string {
  return value.replace(/\r/g, '').split('\n').map((line) => `% ${line}`).join('\n');
}

function initialDraftSkeleton(rootPath: string, targetJournal: string): string {
  const projectName = path.basename(rootPath) || 'Project';
  return [
    fallbackDocumentClass(targetJournal),
    '',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage{lmodern}',
    '\\usepackage{amsmath,amssymb,amsthm}',
    '\\usepackage{graphicx}',
    '\\usepackage{booktabs}',
    '\\usepackage{hyperref}',
    '',
    `\\title{Draft for ${projectName}}`,
    '\\author{Anonymous Authors}',
    '\\date{}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '\\begin{abstract}',
    'This draft is being constructed from the project workspace. Replace this abstract with a contribution-focused summary grounded in the code, experiments, and results.',
    '\\end{abstract}',
    '',
    '\\section{Introduction}',
    'Describe the problem setting, motivation, and high-level contribution story.',
    '',
    '\\section{Method}',
    'Explain the proposed method, architecture, or workflow based on the project artifacts.',
    '',
    '\\section{Experiments}',
    'Summarize datasets, baselines, metrics, and key quantitative findings supported by project evidence.',
    '',
    '\\section{Results and Discussion}',
    'Interpret the main results, ablations, and limitations.',
    '',
    '\\section{Conclusion}',
    'Conclude the paper and summarize the main takeaway.',
    '',
    escapedLatexComment([
      'TEXOR initial draft scaffold:',
      '- Replace placeholder prose with evidence-backed content from the project.',
      '- Keep the document compilable at every step.',
      '- Add figures, tables, labels, citations, and bibliography entries as they become available.',
    ].join('\n')),
    '',
    '\\bibliographystyle{plain}',
    '\\bibliography{references}',
    '',
    '\\end{document}',
    '',
  ].join('\n');
}

async function seedManuscriptFromVersion(manuscriptPath: string, snapshot: WorkspaceSnapshot | null, versionId?: string): Promise<void> {
  if (!snapshot || !versionId) {
    return;
  }
  const version = snapshot.versions.find((entry) => entry.id === versionId);
  if (!version?.latex) {
    return;
  }
  const current = await fs.readFile(manuscriptPath, 'utf8').catch(() => null);
  if (current === version.latex) {
    return;
  }
  await fs.mkdir(path.dirname(manuscriptPath), { recursive: true });
  await fs.writeFile(manuscriptPath, version.latex, 'utf8');
}

async function seedManuscriptFromSnapshot(manuscriptPath: string, snapshot: WorkspaceSnapshot | null): Promise<boolean> {
  if (!snapshot?.currentVersion?.latex?.trim()) {
    return false;
  }
  const current = await fs.readFile(manuscriptPath, 'utf8').catch(() => null);
  if (current === snapshot.currentVersion.latex) {
    return false;
  }
  await fs.mkdir(path.dirname(manuscriptPath), { recursive: true });
  await fs.writeFile(manuscriptPath, snapshot.currentVersion.latex, 'utf8');
  return true;
}

async function ensureInitialDraftSkeleton(
  rootPath: string,
  manuscriptPath: string,
  targetJournal: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const existing = await fs.readFile(manuscriptPath, 'utf8').catch(() => '');
  if (existing.trim() && !options.force) {
    return false;
  }
  await fs.mkdir(path.dirname(manuscriptPath), { recursive: true });
  await fs.writeFile(manuscriptPath, initialDraftSkeleton(rootPath, targetJournal), 'utf8');
  return true;
}

async function pickTargetJournal(): Promise<string | undefined> {
  const current = config().get<string>('targetJournal', '');
  const query = await vscode.window.showInputBox({
    title: 'Texor Target Journal',
    prompt: 'Type a journal or conference name.',
    value: current,
  });
  if (!query) {
    return undefined;
  }

  const suggestions = await request<TemplateSuggestion[]>(`/api/templates/search?q=${encodeURIComponent(query)}&limit=8`).catch(() => []);
  if (suggestions.length === 0) {
    await config().update('targetJournal', query, vscode.ConfigurationTarget.Workspace);
    return query;
  }

  const picked = await vscode.window.showQuickPick(
    suggestions.map((suggestion) => ({
      label: suggestion.label,
      description: `${suggestion.publisher} · ${suggestion.templateFamily}`,
    })),
    { title: 'Select Target Journal' },
  );
  const target = picked?.label || query;
  await config().update('targetJournal', target, vscode.ConfigurationTarget.Workspace);
  return target;
}

async function handoffCurrentLatex(context: vscode.ExtensionContext): Promise<void> {
  const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!projectRoot) {
    throw new Error('Open the code project folder in VSCode before submitting a manuscript to texor.');
  }
  const targetJournal = config().get<string>('targetJournal') || (await pickTargetJournal());
  if (!targetJournal) {
    return;
  }
  const title = await vscode.window.showInputBox({
    title: 'Texor Paper Title',
    prompt: 'Codex should provide the final title. texor only stores and displays it.',
    value: vscode.window.activeTextEditor?.document.fileName.split(/[\\/]/).pop()?.replace(/\.tex$/i, '') || 'Codex Manuscript',
  });
  if (!title) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'texor is receiving the Codex-written manuscript',
      cancellable: false,
    },
    async () => {
      const latex = await activeLatex(context.workspaceState.get<string>(stateKeys.manuscriptPath));
      const manuscriptPath = await writeCanonicalManuscript(projectRoot, latex);
      const snapshot = await request<WorkspaceSnapshot>('/api/codex/papers', {
        method: 'POST',
        body: JSON.stringify({
          title,
          targetJournal,
          latex,
          summary: 'Codex initial handoff',
          projectRoot,
          sourcePath: manuscriptPath,
          runtimeConfig: buildWorkspaceRuntimeConfig('codex-cli'),
        }),
      });
      await context.workspaceState.update(stateKeys.manuscriptPath, manuscriptPath);
      await context.workspaceState.update(stateKeys.paperId, snapshot.paper.id);
      await context.workspaceState.update(stateKeys.versionId, snapshot.currentVersion.id);
      startFeedbackPolling(context);
      vscode.window.showInformationMessage(`texor stored ${snapshot.currentVersion.label} for ${snapshot.paper.targetJournal}.`);
    },
  );
}

async function submitCurrentLatexFromBrowser(
  context: vscode.ExtensionContext,
  payload: CaptureActiveLatexCommandPayload,
  snapshotContext: WorkspaceSnapshot | null = null,
): Promise<WorkspaceSnapshot> {
  const targetJournal = payload.targetJournal || config().get<string>('targetJournal') || (await pickTargetJournal());
  if (!targetJournal) {
    throw new Error('Target journal is required.');
  }
  const baseVersion = versionForPayload(snapshotContext, payload);
  const canonicalSourcePath = payload.projectRoot ? manuscriptPathForWorkspace(payload.projectRoot) : payload.sourcePath;
  const focusTarget = payload.focusTarget || (
    payload.selectedText || payload.sourceFile || payload.sourceLine
      ? {
          sourceFile: payload.sourceFile || canonicalSourcePath || payload.sourcePath,
          sourceLine: payload.sourceLine,
          sourceColumn: payload.sourceColumn,
          selectedText: payload.selectedText,
        }
      : undefined
  );

  if (!payload.paperId) {
    const projectRoot = payload.projectRoot;
    if (!projectRoot) {
      throw new Error('Project path is required. The LaTeX path is only the manuscript file and cannot be used as the project workspace.');
    }
    const preferredManuscriptPath = manuscriptPathForWorkspace(projectRoot);
    const title =
      payload.title ||
      preferredManuscriptPath?.split(/[\\/]/).pop()?.replace(/\.tex$/i, '') ||
      vscode.window.activeTextEditor?.document.fileName.split(/[\\/]/).pop()?.replace(/\.tex$/i, '') ||
      'Codex Manuscript';
    const latex = await activeLatex(preferredManuscriptPath);
    validateSubmittedLatex(latex);
    const snapshot = await request<WorkspaceSnapshot>('/api/codex/papers', {
      method: 'POST',
      body: JSON.stringify({
        title,
        targetJournal,
        latex,
        summary: payload.summary || 'Codex initial browser handoff',
        projectRoot,
        sourcePath: preferredManuscriptPath,
        runtimeConfig: payload.runtimeConfig,
      }),
    });
    await context.workspaceState.update(stateKeys.paperId, snapshot.paper.id);
    await context.workspaceState.update(stateKeys.versionId, snapshot.currentVersion.id);
    return snapshot;
  }

  const latex = await activeLatex(payload.sourcePath || context.workspaceState.get<string>(stateKeys.manuscriptPath));
  validateSubmittedLatex(latex, baseVersion, {
    selectedText: 'selectedText' in payload ? payload.selectedText : undefined,
    sourceLine: 'sourceLine' in payload ? payload.sourceLine : undefined,
    enforceLocalScope: Boolean('selectedText' in payload && payload.selectedText?.trim()),
  });
  const snapshot = await request<WorkspaceSnapshot>(`/api/codex/papers/${payload.paperId}/versions`, {
    method: 'POST',
      body: JSON.stringify({
        latex,
        summary: payload.summary || 'Codex browser revision',
        sourcePath: canonicalSourcePath || context.workspaceState.get<string>(stateKeys.manuscriptPath),
        basedOnVersionId: payload.basedOnVersionId,
        focusTarget,
      }),
    });
  await context.workspaceState.update(stateKeys.paperId, snapshot.paper.id);
  await context.workspaceState.update(stateKeys.versionId, snapshot.currentVersion.id);
  const activeFeedbackId = context.workspaceState.get<string>(stateKeys.activeFeedbackId);
  if (activeFeedbackId) {
    await updateFeedbackStatus(activeFeedbackId, 'done').catch(() => undefined);
    await context.workspaceState.update(stateKeys.activeFeedbackId, undefined);
  }
  return snapshot;
}

async function handoffLatexVersion(context: vscode.ExtensionContext): Promise<void> {
  const paperId = context.workspaceState.get<string>(stateKeys.paperId);
  if (!paperId) {
    throw new Error('Submit an initial LaTeX manuscript before adding a new version.');
  }
  const snapshotContext = await refreshLatestWorkspaceState(context);
  const projectRoot = snapshotContext?.paper.projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!projectRoot) {
    throw new Error('Project path is required before adding a new texor paper version.');
  }
  const latex = await activeLatex(context.workspaceState.get<string>(stateKeys.manuscriptPath));
  const manuscriptPath = await writeCanonicalManuscript(projectRoot, latex);
  const summary = await vscode.window.showInputBox({
    title: 'Texor Version Summary',
    prompt: 'What did Codex change in this version?',
    value: 'Codex revision',
  });
  if (!summary) {
    return;
  }
  const snapshot = await request<WorkspaceSnapshot>(`/api/codex/papers/${paperId}/versions`, {
    method: 'POST',
    body: JSON.stringify({
      latex,
      summary,
      sourcePath: manuscriptPath,
    }),
  });
  await context.workspaceState.update(stateKeys.manuscriptPath, manuscriptPath);
  await context.workspaceState.update(stateKeys.versionId, snapshot.currentVersion.id);
  const activeFeedbackId = context.workspaceState.get<string>(stateKeys.activeFeedbackId);
  if (activeFeedbackId) {
    await updateFeedbackStatus(activeFeedbackId, 'done').catch(() => undefined);
    await context.workspaceState.update(stateKeys.activeFeedbackId, undefined);
  }
  vscode.window.showInformationMessage(`texor stored ${snapshot.currentVersion.label}.`);
}

async function openReview(context: vscode.ExtensionContext): Promise<void> {
  await ensureTexorRunning(context);
  startFeedbackPolling(context);
  await vscode.env.openExternal(vscode.Uri.parse(webUrl()));
}

async function launchBrowserWorkbench(context: vscode.ExtensionContext): Promise<void> {
  await ensureTexorRunning(context);
  startBridgePolling(context);
  const url = webUrl();
  const choice = await vscode.window.showInformationMessage(`texor is ready at ${url}`, '在浏览器中打开');
  if (choice === '在浏览器中打开') {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

async function openWorkbench(context: vscode.ExtensionContext): Promise<void> {
  await ensureTexorRunning(context);
  startFeedbackPolling(context);
  const panel = vscode.window.createWebviewPanel(
    'texorWorkbench',
    'texor',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  const url = webUrl();
  panel.webview.html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${url}; style-src 'unsafe-inline';" />
    <style>
      html, body, iframe {
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        border: 0;
        background: #e9ecef;
      }
    </style>
  </head>
  <body>
    <iframe src="${url}" title="texor"></iframe>
  </body>
</html>`;
}

function buildFeedbackPrompt(feedback: CodexFeedback, snapshot: WorkspaceSnapshot | null): string {
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const selectedText = feedback.selectedText?.trim();
  const sourceTarget = feedback.sourceFile
    ? `${feedback.sourceFile}${feedback.sourceLine ? `:${feedback.sourceLine}` : ''}`
    : undefined;
  const targetVersion = snapshot?.versions.find((entry) => entry.id === feedback.versionId) || snapshot?.currentVersion;
  const targetLabel = snapshot && targetVersion
    ? `${snapshot.paper.title} / ${snapshot.paper.targetJournal} / ${targetVersion.label}`
    : `${feedback.paperId} / ${feedback.versionId}`;

  return [
    '# texor feedback',
    '',
    `Paper: ${targetLabel}`,
    activeFile ? `Active file: ${activeFile}` : undefined,
    `Feedback id: ${feedback.id}`,
    '',
    'User issue:',
    feedback.issue,
    '',
    'Requested change:',
    feedback.changeRequest,
    '',
    selectedText ? 'Selected text or region context:' : undefined,
    selectedText || undefined,
    sourceTarget ? 'Target LaTeX source:' : undefined,
    sourceTarget,
    feedback.sourceSnippet ? 'Nearby LaTeX source snippet:' : undefined,
    feedback.sourceSnippet || undefined,
    '',
    'Operational constraint: preserve a complete compilable LaTeX manuscript. For PDF annotations, edit the located source area by default; broaden scope only if the user request requires it.',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function initialDraftSkillPack(): string[] {
  return [
    'Initial drafting skills:',
    '',
    'Skill 1 - Project grounding',
    '- Inspect the project workspace before writing manuscript claims.',
    '- Identify the problem, method, datasets, experiments, figures, tables, logs, and runnable scripts from actual files.',
    '- Do not treat this review tool or its implementation files as part of the research project.',
    '',
    'Skill 2 - Contribution strategy',
    '- Formulate one central contribution and 2-4 supporting contributions.',
    '- Make the title, abstract, introduction, method, experiments, and conclusion all support the same contribution story.',
    '- If evidence is missing, add a LaTeX comment describing the missing evidence instead of inventing it.',
    '',
    'Skill 3 - Evidence-first drafting',
    '- Derive numbers, baselines, datasets, and claims only from project files or commands you run.',
    '- If extra experiments or plots are needed and feasible, run or adjust project code in the workspace.',
    '- Keep figure/table references traceable to actual artifacts or generated outputs.',
    '',
    'Skill 4 - Paper architecture',
    '- Build the manuscript in this order: outline, figure/table plan, abstract, introduction, method, experiments/results, related work placeholders if needed, conclusion.',
    '- For a blank manuscript, prefer progressive completion: first create a compilable skeleton with section structure, then fill sections with evidence-backed content, then tighten language.',
    '- If the full paper cannot be finished in one pass, leave a stronger but still compilable draft rather than failing with an empty or partial fragment.',
    '- Prefer concise academic prose and avoid marketing language.',
    '- Preserve terminology and notation consistently across sections.',
    '',
    'Skill 5 - LaTeX discipline',
    '- Write a complete compilable LaTeX document at the main manuscript path.',
    '- Preserve or create stable labels, refs, citations, math macros, figures, tables, and bibliography hooks.',
    '- Never return replacement LaTeX in chat instead of writing the file. If file writes fail, stop and report the tool-layer failure.',
  ];
}

function codexRouteGuidance(route: TexorAgentRoute): string[] {
  if (route === 'quick-polish') {
    return [
      'Make the smallest safe local edit that satisfies the request.',
      'Do not broaden into a full-paper rewrite unless the user explicitly asks for it.',
    ];
  }
  if (route === 'full-revision') {
    return [
      'Broaden only to nearby sections that must change for consistency.',
      'Keep terminology, claims, citations, and notation aligned across the touched sections.',
    ];
  }
  if (route === 'structure-diagram') {
    return [
      'Focus on the requested structure or workflow figure task.',
      'Prefer updating or creating only the figure assets and manuscript references needed for that diagram.',
    ];
  }
  if (route === 'result-figure') {
    return [
      'Focus on the requested result figure or result-backed text.',
      'Do not change metrics or claims unless the underlying project files support them.',
    ];
  }
  if (route === 'references') {
    return [
      'Focus on the requested citation, related-work, or bibliography change.',
      'Keep added references conservative and traceable to inspected sources.',
    ];
  }
  return [
    'Follow the user request literally before doing any optional cleanup.',
    'Avoid unrelated structural rewrites unless they are necessary to complete the requested change.',
  ];
}

function buildBrowserTaskPrompt(
  payload: CodexTaskCommandPayload,
  snapshot: WorkspaceSnapshot | null,
  projectContext?: SavedProjectContext | null,
  analysis?: ProjectAnalysis | null,
  policy: TaskExecutionPolicy = taskExecutionPolicyForPayload(payload),
): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const rootPath = payload.projectPath || workspaceRoot || process.cwd();
  const manuscriptPath = manuscriptPathForWorkspace(rootPath);
  const route = policy.route;
  const taskSpeedMode = policy.speedMode;
  const projectAnalysis = analysis || snapshot?.paper.analysis;
  const sourceTarget = payload.sourceFile
    ? `${payload.sourceFile}${payload.sourceLine ? `:${payload.sourceLine}` : ''}`
    : undefined;
  const targetLabel = snapshot
    ? `${snapshot.paper.title} / ${snapshot.paper.targetJournal} / ${snapshot.currentVersion.label}`
    : payload.draftingMode === 'understand-project'
      ? 'No manuscript version yet. This phase must only build source-repo understanding.'
      : 'No manuscript version has been submitted yet.';
  const manuscriptSummary = snapshot?.currentVersion.changeSummary?.summary;
  const baseVersion = snapshot?.versions.find((entry) => entry.id === (payload.baseVersionId || payload.versionId));
  const skillPack = payload.draftingMode === 'initial-draft' ? initialDraftSkillPack() : [];
  const includeProjectContext = policy.loadProjectContext !== 'none' && Boolean(projectContext?.content) && (isPreDraftWorkflowMode(payload.draftingMode) || route !== 'quick-polish');
  const taskIntent = taskIntentForPayload(payload);
  const requestFirst = [
    '# manuscript task',
    '',
    `Project workspace: ${rootPath}`,
    `Main manuscript path: ${manuscriptPath}`,
    `Target journal: ${payload.targetJournal || snapshot?.paper.targetJournal || 'not specified'}`,
    `Manuscript: ${targetLabel}`,
    `Execution profile: ${executionProfileLabel(policy.profile)}`,
    `Execution scope: ${executionScopeLabel(policy.scope)}`,
    `Task speed mode: ${taskSpeedLabel(taskSpeedMode)}`,
    baseVersion ? `Revision base version: ${baseVersion.label} (${baseVersion.id})` : undefined,
    manuscriptSummary ? `Current manuscript summary: ${manuscriptSummary}` : undefined,
    '',
    'Primary task from user:',
    payload.instruction,
    '',
    payload.selectedText ? 'Selected PDF text/context:' : undefined,
    payload.selectedText || undefined,
    sourceTarget ? 'Target LaTeX source:' : undefined,
    sourceTarget,
    payload.sourceSnippet ? 'Nearby LaTeX source snippet:' : undefined,
    payload.sourceSnippet || undefined,
  ];

  if (backendFromCommandPayload(payload) === 'codex-native') {
    const nativeRequirements = taskIntent === 'chat'
      ? [
          '- Treat the user request literally and answer normally in natural language.',
          '- Inspect repository files when useful, but do not modify the manuscript unless the user explicitly asks for edits.',
          '- If you discuss possible changes, keep them as advice or strategy rather than silently editing files.',
          '- Do not mention TEXOR, browser UI, extension internals, or .texor metadata unless directly asked.',
        ]
      : [
          '- Treat the user request literally and use Codex normally.',
          '- Edit the main manuscript file directly instead of returning only a plan.',
          '- If a selected PDF span or source location is provided, start from there.',
          '- Preserve a complete compilable LaTeX manuscript unless the user explicitly asks for a broader restructure.',
          '- You may inspect and use the project workspace freely when helpful.',
          '- Do not mention TEXOR, browser UI, extension internals, or .texor metadata in manuscript prose.',
        ];
    return [
      '# manuscript task',
      '',
      `Project workspace: ${rootPath}`,
      `Main manuscript path: ${manuscriptPath}`,
      `Target journal: ${payload.targetJournal || snapshot?.paper.targetJournal || 'not specified'}`,
      `Manuscript: ${targetLabel}`,
      `Task intent: ${taskIntent}`,
      baseVersion ? `Revision base version: ${baseVersion.label} (${baseVersion.id})` : undefined,
      manuscriptSummary ? `Current manuscript summary: ${manuscriptSummary}` : undefined,
      '',
      'Primary task from user:',
      payload.instruction,
      '',
      payload.selectedText ? 'Selected PDF text/context:' : undefined,
      payload.selectedText || undefined,
      sourceTarget ? 'Target LaTeX source:' : undefined,
      sourceTarget,
      payload.sourceSnippet ? 'Nearby LaTeX source snippet:' : undefined,
      payload.sourceSnippet || undefined,
      '',
      'Requirements:',
      ...nativeRequirements,
      '',
      payload.draftingMode === 'understand-project'
        ? 'Current workflow note: understand the repository and manuscript context first; do not save a manuscript version until the user asks for writing.'
        : payload.draftingMode === 'initial-draft'
          ? 'Current workflow note: write the first complete compilable draft directly into the main manuscript file.'
          : taskIntent === 'chat'
            ? 'Current workflow note: answer the user directly; only inspect or quote project evidence when helpful.'
            : 'Current workflow note: complete the requested manuscript change directly in the working file.',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
  }
  const projectContextLines = includeProjectContext
    ? [
        '',
        'Saved source-repo context path:',
        projectContext?.path || texorProjectContextPath(rootPath),
        '',
        'Saved source-repo context:',
        projectContextPromptText(projectContext?.content),
      ]
    : [];

  if (policy.profile === 'quick-local-edit' && !isPreDraftWorkflowMode(payload.draftingMode)) {
    return [
      ...requestFirst,
      '',
      'Execution rules:',
      '- Treat the primary user task above as the highest-priority instruction.',
      '- This is a local manuscript-edit lane. Do not inspect unrelated repository files or load broader project context unless the local source snippet is insufficient.',
      '- Do not run project scripts, generate figures, or search papers in this lane.',
      '- Edit only the selected LaTeX span, nearby source snippet, or closest local manuscript paragraph.',
      '- Preserve citations, math, labels, figure/table references, and factual claims.',
      '- As soon as the local edit is written safely, stop immediately without a long wrap-up.',
      '',
      'Task guidance:',
      ...codexRouteGuidance(route).map((line) => `- ${line}`),
      '',
      'Speed mode guidance:',
      ...taskSpeedInstruction(taskSpeedMode).map((line) => `- ${line}`),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
  }

  if (payload.draftingMode === 'understand-project') {
    return [
      ...requestFirst,
      ...projectContextLines,
      '',
      'Reference project dossier:',
      formatProjectDossierForAgent(projectAnalysis),
      '',
      'Execution rules:',
      '- Treat the primary user task above as the highest-priority instruction.',
      '- This phase is source-repo understanding only. Do not create or revise manuscript versions yet.',
      '- Do not edit the main manuscript, bibliography files, or manuscript figures in this phase.',
      '- Inspect the repository, experiment scripts, result files, figures, and runnable commands before updating conclusions.',
      '- Rewrite the saved source-repo context file above so it becomes concise, evidence-backed, and reusable for later writing turns.',
      '- Preserve uncertainty honestly: if a dataset, metric, baseline, or claim is not verified, mark it as unknown instead of guessing.',
      '- Do not start drafting the paper body in this phase. The next stage will generate v1 from the saved understanding.',
      '',
      'Speed mode guidance:',
      ...taskSpeedInstruction(taskSpeedMode).map((line) => `- ${line}`),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
  }

  if (payload.draftingMode === 'initial-draft') {
    return [
      ...requestFirst,
      ...projectContextLines,
      '',
      'Reference project dossier:',
      formatProjectDossierForAgent(projectAnalysis),
      '',
      'Current manuscript state:',
      formatManuscriptStateForAgent(snapshot?.currentVersion.manuscriptState, snapshot?.currentVersion.changeSummary),
      '',
      ...skillPack,
      '',
      'Execution rules:',
      '- Treat the primary user task above as the highest-priority instruction.',
      '- Before broad manuscript drafting, inspect the repository and refresh the saved source-repo context file above.',
      '- Keep the saved source-repo context concise, evidence-backed, and reusable for later revision turns.',
      '- Use the dossier and manuscript state below only as supporting context for the requested drafting task.',
      '- Work only from the project workspace and the main manuscript path above.',
      '- Preserve a complete compilable LaTeX manuscript and write changes directly to the file.',
      '- Do not mention TEXOR, browser UI, extension, routing labels, or .texor metadata in manuscript prose.',
      '',
      'Speed mode guidance:',
      ...taskSpeedInstruction(taskSpeedMode).map((line) => `- ${line}`),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
  }

  return [
    ...requestFirst,
    ...projectContextLines,
    '',
    'Execution rules:',
    '- Treat the primary user task above as the highest-priority instruction.',
    includeProjectContext ? '- Reuse the saved source-repo context above. If you discover better repository grounding during this task, update that context file too.' : undefined,
    policy.profile === 'project-execution' ? '- This task is allowed to use the long-running project-execution lane and can continue through grounded repository operations.' : '- Keep this task in the lightweight writing lane unless the verified task route explicitly requires project execution.',
    policy.allowProjectCommands ? '- Project execution is allowed when grounded in inspected repository evidence or stored command hints.' : '- Avoid project command execution in this task unless the route explicitly requires it.',
    policy.allowFigureGeneration ? '- Figure generation is allowed when the requested route needs a diagram or result asset.' : '- Do not generate new figures unless the task route clearly requires it.',
    policy.allowPaperSearch ? '- External paper search is allowed for citation-focused work.' : '- Avoid external paper search unless the task is explicitly about references.',
    '- Edit the main manuscript file directly instead of returning a detached plan or unrelated overview.',
    '- If selected text or a source location is provided, start there and stay local unless the user explicitly asks for broader changes.',
    '- Preserve citations, labels, math, figures/tables, and a complete compilable LaTeX manuscript.',
    '- Work only from the project workspace and the main manuscript path above.',
    '- Do not mention TEXOR, browser UI, extension, routing labels, or .texor metadata in manuscript prose.',
    '',
    'Task guidance:',
    ...codexRouteGuidance(route).map((line) => `- ${line}`),
    '',
    'Speed mode guidance:',
    ...taskSpeedInstruction(taskSpeedMode).map((line) => `- ${line}`),
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function feedbackFileName(feedback: CodexFeedback): string {
  return `feedback-${feedback.createdAt.replace(/[:.]/g, '-')}-${feedback.id.slice(0, 8)}.md`;
}

async function openTaskDocument(context: vscode.ExtensionContext, feedback: CodexFeedback, prompt: string): Promise<vscode.Uri | null> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    const document = await vscode.workspace.openTextDocument({ content: prompt, language: 'markdown' });
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
    return null;
  }

  const taskDir = vscode.Uri.joinPath(workspaceFolder.uri, '.texor', 'codex-feedback');
  await vscode.workspace.fs.createDirectory(taskDir);
  const taskUri = vscode.Uri.joinPath(taskDir, feedbackFileName(feedback));
  await vscode.workspace.fs.writeFile(taskUri, Buffer.from(prompt, 'utf8'));
  const document = await vscode.workspace.openTextDocument(taskUri);
  await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
  return taskUri;
}

async function openBrowserCommandTaskDocument(command: BridgeCommand, prompt: string): Promise<vscode.Uri | null> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    const document = await vscode.workspace.openTextDocument({ content: prompt, language: 'markdown' });
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
    return null;
  }

  const taskDir = vscode.Uri.joinPath(workspaceFolder.uri, '.texor', 'codex-feedback');
  await vscode.workspace.fs.createDirectory(taskDir);
  const safeDate = command.createdAt.replace(/[:.]/g, '-');
  const taskUri = vscode.Uri.joinPath(taskDir, `browser-${safeDate}-${command.id.slice(0, 8)}.md`);
  await vscode.workspace.fs.writeFile(taskUri, Buffer.from(prompt, 'utf8'));
  const document = await vscode.workspace.openTextDocument(taskUri);
  await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
  return taskUri;
}

async function updateFeedbackStatus(feedbackId: string, status: CodexFeedback['status']): Promise<CodexFeedback> {
  return request<CodexFeedback>(`/api/codex/feedback/${feedbackId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

async function trySendTaskToCodex(taskUri: vscode.Uri | null): Promise<void> {
  try {
    await vscode.commands.executeCommand('chatgpt.openSidebar');
  } catch {
    return;
  }

  if (!taskUri) {
    return;
  }

  for (const command of ['chatgpt.addFileToThread', 'chatgpt.addToThread']) {
    try {
      await vscode.commands.executeCommand(command, taskUri);
      return;
    } catch {
      // Codex command argument contracts are not documented; clipboard + open task document remains the stable path.
    }
  }
}

async function openFeedbackTask(context: vscode.ExtensionContext, feedback: CodexFeedback): Promise<void> {
  const snapshot = await refreshLatestWorkspaceState(context);
  const prompt = buildFeedbackPrompt(feedback, snapshot);
  await vscode.env.clipboard.writeText(prompt);
  const taskUri = await openTaskDocument(context, feedback, prompt);
  await updateFeedbackStatus(feedback.id, 'accepted').catch(() => undefined);
  await context.workspaceState.update(stateKeys.activeFeedbackId, feedback.id);
  await trySendTaskToCodex(taskUri);
  vscode.window.showInformationMessage('texor feedback is ready for Codex. The task text is also on the clipboard.');
}

function initialDraftFollowupInstruction(payload: CodexTaskCommandPayload): string | null {
  const configured = payload.followupInstruction?.trim();
  if (configured) {
    return configured;
  }
  return null;
}

async function executeAgentTaskCommand(context: vscode.ExtensionContext, command: BridgeCommand): Promise<void> {
  const payload = command.payload as CodexTaskCommandPayload;
  if (!payload.instruction?.trim()) {
    throw new Error('Agent task instruction is empty.');
  }
  if (!payload.projectPath?.trim()) {
    throw new Error('Project path is required. TEXOR uses it as the Agent workspace for understanding and controlling the code project.');
  }

  const cwd = payload.projectPath;
  const isUnderstandingOnly = payload.draftingMode === 'understand-project';
  const backend = backendFromCommandPayload(payload);
  const isCodexNative = backend === 'codex-native';
  const taskIntent = taskIntentForPayload(payload);
  const nativeChatIntent = isCodexNative && taskIntent === 'chat' && !isPreDraftWorkflowMode(payload.draftingMode);
  const executionPolicy = taskExecutionPolicyForPayload(payload, backend);
  await updateBridgeProgress(command.id, 'preparing', '正在确认项目可写');
  await assertWritableProjectWorkspace(cwd);
  const manuscriptPath = manuscriptPathForWorkspace(cwd);
  const understandingBaselineLatex = isUnderstandingOnly ? await fs.readFile(manuscriptPath, 'utf8').catch(() => null) : null;
  const agentName = backendLabel(backend);
  await updateBridgeCommand(command.id, 'running', {
    phase: 'preparing',
    message: '正在读取当前论文状态',
  });

  let snapshot: WorkspaceSnapshot | null = null;
  let projectAnalysis: ProjectAnalysis | null = null;
  try {
    snapshot = await refreshWorkspaceStateForCommand(context, payload);
    if (!isCodexNative && executionPolicy.refreshProjectAnalysis) {
      await updateBridgeProgress(
        command.id,
        'preparing',
        isUnderstandingOnly ? '正在扫描源库并建立理解种子' : '正在扫描源库并提炼执行上下文',
      );
      projectAnalysis = await scanProjectAnalysis(cwd);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateBridgeCommand(command.id, undefined, {
      message: '读取论文状态失败，将只基于项目路径继续',
      logs: [bridgeLog('stderr', message)],
    }).catch(() => undefined);
  }

  const resumeSessionId = executionPolicy.resumeSession ? await recentSessionForCommand(command, snapshot) : undefined;
  let latestSessionId = resumeSessionId;
  let persistedSessionId: string | undefined;
  const rememberProjectSession = (paperId: string | undefined, nextSessionId: string | undefined) => {
    if (!executionPolicy.resumeSession) {
      return;
    }
    if (!paperId || !nextSessionId || persistedSessionId === nextSessionId) {
      return;
    }
    persistedSessionId = nextSessionId;
    void updatePaperCodexSession(paperId, nextSessionId, backend);
  };
  rememberProjectSession(payload.paperId || snapshot?.paper.id, resumeSessionId);
  await updateBridgeCommand(command.id, 'running', {
    phase: 'preparing',
    message: backend === 'codex-native'
      ? (resumeSessionId ? '正在回到该项目的原生 Codex 对话' : '正在为该项目开启原生 Codex 对话')
      : backend === 'codex-cli'
      ? (executionPolicy.resumeSession
        ? (resumeSessionId ? '正在回到该项目的 Codex 对话' : '正在为该项目开启 Codex 对话')
        : '正在为本轮快速任务开启临时 Codex 对话')
      : backend === 'claude-code'
        ? (executionPolicy.resumeSession
          ? (resumeSessionId ? '正在回到该项目的 Claude Code 对话' : '正在为该项目开启 Claude Code 对话')
          : '正在为本轮轻量任务开启独立 Claude Code 对话')
        : '正在启动 TEXOR Agent',
    sessionId: resumeSessionId,
  });

  if (!isUnderstandingOnly && !nativeChatIntent) {
    await updateBridgeProgress(command.id, 'preparing', '正在准备论文输出位置');
    await fs.mkdir(path.dirname(manuscriptPath), { recursive: true });
    await seedManuscriptFromVersion(manuscriptPath, snapshot, payload.baseVersionId || payload.versionId);
    if (payload.draftingMode === 'initial-draft' && snapshot) {
      const seededBaseline = await seedManuscriptFromSnapshot(manuscriptPath, snapshot);
      if (seededBaseline) {
        await updateBridgeProgress(command.id, 'preparing', '已写入当前主稿基线');
      } else {
        await updateBridgeProgress(command.id, 'preparing', '当前主稿基线已是最新');
      }
    } else if (payload.draftingMode === 'initial-draft' && !snapshot) {
      const seededSkeleton = await ensureInitialDraftSkeleton(
        cwd,
        manuscriptPath,
        payload.targetJournal || 'not specified',
        { force: Boolean(payload.continuedFromCommandId) },
      );
      if (seededSkeleton) {
        await updateBridgeProgress(command.id, 'preparing', '已建立可编译初稿骨架');
      }
    }
  }

  let projectContext: SavedProjectContext | null = null;
  if (!isCodexNative && executionPolicy.loadProjectContext !== 'none') {
    await updateBridgeProgress(
      command.id,
      'preparing',
      isUnderstandingOnly
        ? '正在准备源库理解上下文'
        : payload.draftingMode === 'initial-draft'
          ? '正在准备源库上下文'
          : executionPolicy.loadProjectContext === 'ensure'
            ? '正在加载并更新源库上下文'
            : '正在读取已有源库上下文',
    );
    if (executionPolicy.loadProjectContext === 'ensure') {
      projectContext = await ensureSavedProjectContext(cwd, snapshot, payload.targetJournal, projectAnalysis || undefined);
      if (projectContext.seeded) {
        await updateBridgeCommand(command.id, undefined, {
          logs: [bridgeLog('system', `已写入源库上下文种子：${projectContext.path}`)],
        }).catch(() => undefined);
      }
    } else {
      const existingContent = await fs.readFile(texorProjectContextPath(cwd), 'utf8').catch(() => '');
      if (existingContent.trim()) {
        projectContext = {
          path: texorProjectContextPath(cwd),
          content: existingContent.trim(),
          seeded: false,
        };
      }
    }
  }

  await updateBridgeCommand(command.id, undefined, {
    logs: [
      bridgeLog(
        'system',
        isCodexNative
          ? `执行策略：原生 Codex · ${taskSpeedLabel(executionPolicy.speedMode)}`
          : `执行策略：${routeLabel(executionPolicy.route)} · ${executionProfileLabel(executionPolicy.profile)} · ${taskSpeedLabel(executionPolicy.speedMode)} · ${executionScopeLabel(executionPolicy.scope)}`,
      ),
      ...(isCodexNative
        ? [
            bridgeLog(
              'system',
              taskIntent === 'chat'
                ? `原生回答模式：${executionPolicy.speedMode === 'quick' ? '优先快速给出结论，不改主稿。' : '允许更完整地阅读项目与稿件上下文，但不会自动保存新版本。'}`
                : `原生修改模式：${executionPolicy.speedMode === 'quick' ? '优先完成局部安全改写。' : '允许更长链路的稿件与项目协同修改。'}`,
            ),
            bridgeLog(
              'system',
              resumeSessionId
                ? '会话策略：继续当前窗口绑定的 Codex 对话。'
                : '会话策略：为当前窗口开启新的 Codex 对话。',
            ),
          ]
        : []),
    ],
  }).catch(() => undefined);

  const prompt = buildBrowserTaskPrompt(payload, snapshot, projectContext, projectAnalysis, executionPolicy);
  const trackedPaths = isCodexNative
    ? undefined
    : trackedPathsForExecution(
      executionPolicy,
      executionPolicy.route,
      snapshot?.currentVersion.manuscriptState,
      projectAnalysis || snapshot?.paper.analysis,
    );
  const workspaceSnapshotBefore = backend === 'texor-agent' || isCodexNative ? null : await captureWorkspaceFileSnapshot(cwd, { trackedPaths });
  const commonRunOptions = {
    onProgress: (phase: BridgeCommandPhase, message: string) => {
      void updateBridgeProgress(command.id, phase, message);
    },
    onLog: (stream: BridgeCommandLogStream, message: string) => {
      void updateBridgeCommand(command.id, undefined, { logs: [bridgeLog(stream, message)] }).catch(() => undefined);
    },
    controlSignal: async () => {
      const latest = await readBridgeCommand(command.id);
      return latest?.control;
    },
  };
  const manuscriptBeforeTask = !isUnderstandingOnly ? await fs.readFile(manuscriptPath, 'utf8').catch(() => null) : null;
  const { output, answer, sessionId, interruptedBy } = backend === 'texor-agent'
    ? await runTexorAgent(payload, snapshot, {
        ...commonRunOptions,
        projectContext,
        analysis: projectAnalysis,
      })
    : backend === 'claude-code'
      ? await runClaudeCodeExec(prompt, cwd, {
          ...commonRunOptions,
          model: claudeModel(payload.modelConfig),
          timeoutMs: executionPolicy.timeoutMs,
          resumeSessionId: executionPolicy.resumeSession ? resumeSessionId : undefined,
          onSession: (nextSessionId) => {
            latestSessionId = nextSessionId;
            void updateBridgeCommand(command.id, undefined, { sessionId: nextSessionId }).catch(() => undefined);
            rememberProjectSession(payload.paperId || snapshot?.paper.id, nextSessionId);
          },
        })
      : await runCodexExec(prompt, cwd, {
        ...commonRunOptions,
        backend,
        model: codexModel(payload.modelConfig),
        reasoningEffort: codexReasoningEffort(payload.modelConfig),
        timeoutMs: executionPolicy.timeoutMs,
        resumeSessionId: executionPolicy.resumeSession ? resumeSessionId : undefined,
        useEphemeralSession: executionPolicy.useEphemeralSession,
        onSession: (nextSessionId) => {
          latestSessionId = nextSessionId;
          void updateBridgeCommand(command.id, undefined, { sessionId: nextSessionId }).catch(() => undefined);
          rememberProjectSession(payload.paperId || snapshot?.paper.id, nextSessionId);
        },
      });
  latestSessionId = latestSessionId || sessionId;
  rememberProjectSession(payload.paperId || snapshot?.paper.id, latestSessionId);
  const finalAnswer = resolvedAssistantAnswer(answer, output, backend);
  const truncatedOutput = output.slice(-8000);
  if (workspaceSnapshotBefore && !isCodexNative) {
    const workspaceSnapshotAfter = await captureWorkspaceFileSnapshot(cwd, { trackedPaths });
    const changedFiles = changedWorkspaceFiles(workspaceSnapshotBefore, workspaceSnapshotAfter);
    const invalidWrites = invalidWorkspaceWrites(
      changedFiles,
      executionPolicy,
      executionPolicy.route,
      snapshot?.currentVersion.manuscriptState,
      projectAnalysis || snapshot?.paper.analysis,
    );
    if (invalidWrites.length > 0) {
      throw new Error(`Agent wrote files outside the allowed lane: ${invalidWrites.slice(0, 8).join(', ')}`);
    }
  }
  if (isUnderstandingOnly) {
    const currentLatex = await fs.readFile(manuscriptPath, 'utf8').catch(() => null);
    if (currentLatex !== understandingBaselineLatex) {
      if (understandingBaselineLatex === null) {
        await fs.unlink(manuscriptPath).catch(() => undefined);
      } else {
        await fs.writeFile(manuscriptPath, understandingBaselineLatex, 'utf8');
      }
      await updateBridgeCommand(command.id, undefined, {
        logs: [bridgeLog('system', '理解阶段检测到正文被改动，已自动还原主稿内容。')],
      }).catch(() => undefined);
    }
  }
  if (!isUnderstandingOnly && !nativeChatIntent) {
    await context.workspaceState.update(stateKeys.manuscriptPath, manuscriptPath);
  }
  const effectivePaperId = payload.paperId || snapshot?.paper.id;
  const effectiveBaseVersionId = payload.baseVersionId || payload.versionId || snapshot?.currentVersion.id;
  const projectContextPath = projectContext?.path;
  const manuscriptAfterTask = !isUnderstandingOnly ? await fs.readFile(manuscriptPath, 'utf8').catch(() => manuscriptBeforeTask) : null;
  const manuscriptChanged = !isUnderstandingOnly && manuscriptBeforeTask !== manuscriptAfterTask;
  if (interruptedBy) {
    if (isUnderstandingOnly) {
      await updateBridgeCommand(command.id, interruptedBy === 'pause' ? 'failed' : 'done', {
        phase: interruptedBy === 'pause' ? 'interrupted' : 'complete',
        message: interruptedBy === 'pause' ? '已暂停源库理解' : '已终止源库理解',
        control: null,
        sessionId: latestSessionId,
        result: {
          mode: backend,
          sessionId: latestSessionId,
          interruptedBy,
          cwd,
          projectContextPath,
          answer: finalAnswer,
          output: truncatedOutput,
        },
      });
      return;
    }
    if (nativeChatIntent || !manuscriptChanged) {
      await updateBridgeCommand(command.id, interruptedBy === 'pause' ? 'failed' : 'done', {
        phase: interruptedBy === 'pause' ? 'interrupted' : 'complete',
        message: interruptedBy === 'pause' ? '已暂停本轮对话' : '已终止本轮对话',
        control: null,
        sessionId: latestSessionId,
        result: {
          mode: backend,
          sessionId: latestSessionId,
          interruptedBy,
          cwd,
          manuscriptPath,
          answer: finalAnswer,
          output: truncatedOutput,
        },
      });
      return;
    }
    const snapshotAfterPause = await submitCurrentLatexFromBrowser(context, {
      paperId: effectivePaperId,
      title: snapshot?.paper.title,
      targetJournal: payload.targetJournal || snapshot?.paper.targetJournal,
      summary: interruptedBy === 'pause' ? `${agentName} paused draft` : `${agentName} terminated draft`,
      basedOnVersionId: effectiveBaseVersionId,
      projectRoot: cwd,
      sourcePath: manuscriptPath,
      selectedText: payload.selectedText,
      sourceFile: payload.sourceFile,
      sourceLine: payload.sourceLine,
      sourceColumn: payload.sourceColumn,
      sourceSnippet: payload.sourceSnippet,
      runtimeConfig: buildWorkspaceRuntimeConfig(backend, payload.taskSpeedMode, payload.modelConfig),
    }, snapshot);
    if (executionPolicy.resumeSession) {
      await updatePaperCodexSession(snapshotAfterPause.paper.id, latestSessionId, backend);
    }
    await updateBridgeCommand(command.id, interruptedBy === 'pause' ? 'failed' : 'done', {
      phase: interruptedBy === 'pause' ? 'interrupted' : 'complete',
      message: interruptedBy === 'pause' ? `已暂停，保存 ${snapshotAfterPause.currentVersion.label}` : `已终止，保存 ${snapshotAfterPause.currentVersion.label}`,
      control: null,
      sessionId: latestSessionId,
      result: {
        mode: backend,
        sessionId: latestSessionId,
        interruptedBy,
        cwd,
        manuscriptPath,
        paperId: snapshotAfterPause.paper.id,
        versionId: snapshotAfterPause.currentVersion.id,
        label: snapshotAfterPause.currentVersion.label,
        answer: finalAnswer,
        output: truncatedOutput,
      },
    });
    return;
  }
  if (isUnderstandingOnly) {
    const followupInstruction = initialDraftFollowupInstruction(payload);
    if (followupInstruction) {
      await updateBridgeProgress(command.id, 'finalizing', '源库理解已完成，正在衔接 v1 起稿');
      const followup = await createBridgeCommandRequest({
        type: 'codex-task',
        payload: {
          ...payload,
          instruction: followupInstruction,
          followupInstruction: undefined,
          paperId: undefined,
          versionId: undefined,
          baseVersionId: undefined,
          selectedText: undefined,
          sourceFile: undefined,
          sourceLine: undefined,
          sourceSnippet: undefined,
          source: 'browser',
          draftingMode: 'initial-draft',
          resumeSessionId: latestSessionId,
          continuedFromCommandId: command.id,
        },
      });
      await updateBridgeCommand(command.id, 'done', {
        phase: 'complete',
        message: '源库理解完成，已进入 v1 起稿阶段',
        sessionId: latestSessionId,
        result: {
          mode: backend,
          sessionId: latestSessionId,
          cwd,
          projectContextPath,
          nextCommandId: followup.id,
          nextDraftingMode: 'initial-draft',
          answer: finalAnswer,
          output: truncatedOutput,
        },
      });
      return;
    }
    await updateBridgeCommand(command.id, 'done', {
      phase: 'complete',
      message: '源库理解完成，等待用户写作指令',
      sessionId: latestSessionId,
      result: {
        mode: backend,
        sessionId: latestSessionId,
        cwd,
        projectContextPath,
        answer: finalAnswer,
        output: truncatedOutput,
      },
    });
    return;
  }
  if (nativeChatIntent) {
    if (manuscriptChanged && manuscriptBeforeTask !== null) {
      await fs.writeFile(manuscriptPath, manuscriptBeforeTask, 'utf8').catch(() => undefined);
      await updateBridgeCommand(command.id, undefined, {
        logs: [bridgeLog('system', '回答模式检测到主稿改动，已自动还原，因此不会保存论文新版本。')],
      }).catch(() => undefined);
    }
    await updateBridgeCommand(command.id, 'done', {
      phase: 'complete',
      message: `${agentName} 已完成回答`,
      sessionId: latestSessionId,
      result: {
        mode: backend,
        sessionId: latestSessionId,
        cwd,
        manuscriptPath,
        answer: finalAnswer,
        output: truncatedOutput,
      },
    });
    return;
  }
  if (!manuscriptChanged) {
    await updateBridgeCommand(command.id, 'done', {
      phase: 'complete',
      message: `${agentName} 已完成，本轮未检测到稿件改动`,
      sessionId: latestSessionId,
      result: {
        mode: backend,
        sessionId: latestSessionId,
        cwd,
        manuscriptPath,
        answer: finalAnswer,
        output: truncatedOutput,
      },
    });
    return;
  }
  await updateBridgeProgress(command.id, 'finalizing', `${agentName} 已完成，正在自动保存版本`);
  const snapshotAfterCodex = await submitCurrentLatexFromBrowser(context, {
    paperId: effectivePaperId,
    title: snapshot?.paper.title,
    targetJournal: payload.targetJournal || snapshot?.paper.targetJournal,
    summary:
      payload.draftingMode === 'initial-draft'
        ? `${agentName} initial draft completion`
        : payload.source === 'annotation'
          ? `${agentName} annotation revision`
          : `${agentName} browser revision`,
    basedOnVersionId: effectiveBaseVersionId,
    projectRoot: cwd,
    sourcePath: manuscriptPath,
    selectedText: payload.selectedText,
    sourceFile: payload.sourceFile,
    sourceLine: payload.sourceLine,
    sourceColumn: payload.sourceColumn,
    sourceSnippet: payload.sourceSnippet,
    runtimeConfig: buildWorkspaceRuntimeConfig(backend, payload.taskSpeedMode, payload.modelConfig),
  }, snapshot);
  if (executionPolicy.resumeSession) {
    await updatePaperCodexSession(snapshotAfterCodex.paper.id, latestSessionId, backend);
  }
  await updateBridgeCommand(command.id, 'done', {
    phase: 'complete',
    message: `${agentName} 已完成，已保存 ${snapshotAfterCodex.currentVersion.label}`,
    sessionId: latestSessionId,
    result: {
      mode: backend,
      sessionId: latestSessionId,
      cwd,
      manuscriptPath,
      paperId: snapshotAfterCodex.paper.id,
      versionId: snapshotAfterCodex.currentVersion.id,
      label: snapshotAfterCodex.currentVersion.label,
      answer: finalAnswer,
      output: truncatedOutput,
    },
  });
  vscode.window.showInformationMessage(`${agentName} finished. texor stored ${snapshotAfterCodex.currentVersion.label}.`);
}

async function executeBridgeCommand(context: vscode.ExtensionContext, command: BridgeCommand): Promise<void> {
  const projectKey = commandProjectExecutionKey(command);
  if (projectKey) {
    activeBridgeProjects.add(projectKey);
  }
  const claimed = await claimBridgeCommand(command.id);
  if (!claimed) {
    if (projectKey) {
      activeBridgeProjects.delete(projectKey);
    }
    return;
  }
  try {
    if (claimed.type === 'codex-task') {
      await executeAgentTaskCommand(context, claimed);
      return;
    }

    await updateBridgeCommand(claimed.id, 'running', {
      phase: 'finalizing',
      message: '正在收取 Codex 生成的 LaTeX',
    });
    const snapshotContext = await refreshLatestWorkspaceState(context);
    const snapshot = await submitCurrentLatexFromBrowser(context, claimed.payload as CaptureActiveLatexCommandPayload, snapshotContext);
    await updateBridgeCommand(claimed.id, 'done', {
      phase: 'complete',
      message: `已保存 ${snapshot.currentVersion.label}`,
      result: {
        paperId: snapshot.paper.id,
        versionId: snapshot.currentVersion.id,
        label: snapshot.currentVersion.label,
      },
    });
    vscode.window.showInformationMessage(`texor stored ${snapshot.currentVersion.label} from the browser command.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnosis = diagnoseFailure(message, claimed.type === 'codex-task'
      ? backendFromCommandPayload(claimed.payload as CodexTaskCommandPayload)
      : undefined);
    const payload = claimed.payload as CodexTaskCommandPayload | CaptureActiveLatexCommandPayload;
    const projectRoot =
      ('projectPath' in payload && payload.projectPath) ||
      ('projectRoot' in payload && payload.projectRoot);
    const manuscriptPath =
      ('projectPath' in payload && payload.projectPath)
        ? manuscriptPathForWorkspace(payload.projectPath)
        : ('projectRoot' in payload && payload.projectRoot)
          ? manuscriptPathForWorkspace(payload.projectRoot)
          : context.workspaceState.get<string>(stateKeys.manuscriptPath);
    const failedDraft =
      projectRoot && manuscriptPath
        ? await captureFailedDraft(projectRoot, manuscriptPath).catch(() => null)
        : null;
    await updateBridgeCommand(claimed.id, 'failed', {
      phase: message.toLowerCase().includes('timed out') ? 'interrupted' : 'failed',
      message: diagnosis.summary,
      result: {
        failureDiagnosis: diagnosis,
        failedDraft,
      },
      logs: [bridgeLog('stderr', message)],
    }).catch(() => undefined);
    throw error;
  } finally {
    if (projectKey) {
      activeBridgeProjects.delete(projectKey);
    }
  }
}

async function fetchOpenFeedback(context: vscode.ExtensionContext): Promise<CodexFeedback[]> {
  const snapshot = await refreshLatestWorkspaceState(context);
  const paperId = snapshot?.paper.id || context.workspaceState.get<string>(stateKeys.paperId);
  if (!paperId) {
    return [];
  }

  const params = new URLSearchParams({
    paperId,
    status: 'open',
    limit: '10',
  });
  return request<CodexFeedback[]>(`/api/codex/feedback?${params.toString()}`);
}

async function pollFeedback(context: vscode.ExtensionContext): Promise<void> {
  if (pollingFeedback) {
    return;
  }

  pollingFeedback = true;
  try {
    const feedback = (await fetchOpenFeedback(context)).find((entry) => !notifiedFeedbackIds.has(entry.id));
    if (!feedback) {
      return;
    }

    notifiedFeedbackIds.add(feedback.id);
    const choice = await vscode.window.showInformationMessage(
      `texor received paper feedback: ${feedback.issue.slice(0, 80)}`,
      'Open Task',
      'Copy',
      'Dismiss',
    );

    if (choice === 'Open Task') {
      await openFeedbackTask(context, feedback);
    } else if (choice === 'Copy') {
      const snapshot = await refreshLatestWorkspaceState(context);
      await vscode.env.clipboard.writeText(buildFeedbackPrompt(feedback, snapshot));
      await updateFeedbackStatus(feedback.id, 'accepted').catch(() => undefined);
      await context.workspaceState.update(stateKeys.activeFeedbackId, feedback.id);
    } else if (choice === 'Dismiss') {
      await updateFeedbackStatus(feedback.id, 'dismissed').catch(() => undefined);
    }
  } catch {
    // Background polling should stay quiet until the user explicitly asks for feedback.
  } finally {
    pollingFeedback = false;
  }
}

function startFeedbackPolling(context: vscode.ExtensionContext): void {
  if (feedbackTimer) {
    return;
  }

  void pollFeedback(context);
  feedbackTimer = setInterval(() => {
    void pollFeedback(context);
  }, FEEDBACK_POLL_INTERVAL_MS);
}

async function pollBridgeCommands(context: vscode.ExtensionContext): Promise<void> {
  if (pollingBridge) {
    return;
  }
  pollingBridge = true;
  try {
    const params = new URLSearchParams({ status: 'queued', limit: '12' });
    const commands = await request<BridgeCommand[]>(`/api/bridge/commands?${params.toString()}`);
    lastBridgeConnectionErrorAt = 0;
    if (!commands.length) {
      return;
    }
    const runnable = commands
      .filter((command) => {
        const projectKey = commandProjectExecutionKey(command);
        return !projectKey || !activeBridgeProjects.has(projectKey);
      })
      .slice(0, 4);
    if (!runnable.length) {
      return;
    }
    const settled = await Promise.allSettled(runnable.map((command) => executeBridgeCommand(context, command)));
    const firstFailure = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
    if (firstFailure) {
      throw firstFailure.reason;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('fetch failed')) {
      showError(error);
      return;
    }
    const now = Date.now();
    if (now - lastBridgeConnectionErrorAt > 60_000) {
      lastBridgeConnectionErrorAt = now;
      vscode.window.showWarningMessage('texor backend is not reachable yet. Run Texor: Open or wait for the local server to start.');
    }
  } finally {
    pollingBridge = false;
  }
}

function startBridgePolling(context: vscode.ExtensionContext): void {
  if (bridgeTimer) {
    return;
  }

  void pollBridgeCommands(context);
  bridgeTimer = setInterval(() => {
    void pollBridgeCommands(context);
  }, BRIDGE_POLL_INTERVAL_MS);
}

async function pullLatestFeedback(context: vscode.ExtensionContext): Promise<void> {
  await ensureTexorRunning(context);
  startFeedbackPolling(context);
  const feedback = await fetchOpenFeedback(context);
  if (feedback.length === 0) {
    vscode.window.showInformationMessage('No open texor feedback.');
    return;
  }
  await openFeedbackTask(context, feedback[0]);
}

async function reviseSelection(context: vscode.ExtensionContext): Promise<void> {
  await ensureTexorRunning(context);
  const snapshot = await refreshLatestWorkspaceState(context);
  const paperId = snapshot?.paper.id || context.workspaceState.get<string>(stateKeys.paperId);
  const versionId = snapshot?.currentVersion.id || context.workspaceState.get<string>(stateKeys.versionId);
  if (!paperId || !versionId) {
    throw new Error('Submit a LaTeX manuscript to texor before sending feedback.');
  }

  const editor = vscode.window.activeTextEditor;
  const selectedText = editor ? editor.document.getText(editor.selection).trim() : '';
  const issue = await vscode.window.showInputBox({ title: 'Texor Issue', prompt: 'What is wrong with the selected text?' });
  if (!issue) {
    return;
  }
  const changeRequest = await vscode.window.showInputBox({ title: 'Texor Change', prompt: 'How should the AI revise it?' });
  if (!changeRequest) {
    return;
  }

  const feedback = await request<CodexFeedback>('/api/codex/feedback', {
    method: 'POST',
    body: JSON.stringify({
      paperId,
      versionId,
      targetBlockId: 'vscode-selection',
      selectedText,
      issue,
      changeRequest,
      source: 'vscode',
    }),
  });
  await openFeedbackTask(context, feedback);
}

function command(handler: () => Promise<void>): () => void {
  return () => {
    void handler().catch(showError);
  };
}

export function activate(context: vscode.ExtensionContext): void {
  console.info('[texor] activate()');
  context.subscriptions.push(
    vscode.commands.registerCommand('texor.open', command(() => launchBrowserWorkbench(context))),
  );
  console.info('[texor] registered command texor.open');
  try {
    startBridgePolling(context);
  } catch (error) {
    console.error('[texor] failed to start bridge polling', error);
    void vscode.window.showWarningMessage(
      'TEXOR bridge polling failed during activation, but the open command is still available.',
    );
  }
}

export function deactivate(): void {
  if (feedbackTimer) {
    clearInterval(feedbackTimer);
  }
  if (bridgeTimer) {
    clearInterval(bridgeTimer);
  }
  if (texorServerProcess && !texorServerProcess.killed) {
    texorServerProcess.kill();
  }
}
