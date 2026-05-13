import * as vscode from 'vscode';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

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
    codexSessionId?: string;
    codexSessionUpdatedAt?: string;
  };
  currentVersion: {
    id: string;
    label: string;
    latex?: string;
  };
  versions: Array<{
    id: string;
    label: string;
    latex: string;
    sourcePath?: string;
  }>;
}

interface WorkspaceSummary {
  paperId: string;
  projectRoot?: string;
  codexSessionId?: string;
}

interface ModelConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
  imageModel?: string;
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
  agentBackend?: 'texor-agent' | 'codex-cli';
  modelConfig?: ModelConfig;
  paperId?: string;
  versionId?: string;
  baseVersionId?: string;
  selectedText?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceSnippet?: string;
  source?: 'browser' | 'annotation';
  draftingMode?: 'initial-draft' | 'continue';
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

const stateKeys = {
  paperId: 'texor.paperId',
  versionId: 'texor.versionId',
  activeFeedbackId: 'texor.activeFeedbackId',
  manuscriptPath: 'texor.manuscriptPath',
};

const texorManuscriptRelativePath = path.join('.texor', 'manuscript', 'main.tex');

const notifiedFeedbackIds = new Set<string>();
let feedbackTimer: ReturnType<typeof setInterval> | undefined;
let pollingFeedback = false;
let bridgeTimer: ReturnType<typeof setInterval> | undefined;
let pollingBridge = false;
let lastBridgeConnectionErrorAt = 0;
let texorServerProcess: ReturnType<typeof spawn> | undefined;
let runtimeServerUrl: string | undefined;
let runtimeWebUrl: string | undefined;

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

function texorAgentModelConfig(payload?: ModelConfig): ModelConfig {
  return {
    provider: payload?.provider || config().get<string>('agentProvider', 'OpenAI-compatible'),
    baseUrl: payload?.baseUrl || config().get<string>('agentBaseUrl', 'https://api.openai.com/v1'),
    model: payload?.model || config().get<string>('agentModel', 'gpt-4.1-mini'),
    imageModel: payload?.imageModel || config().get<string>('agentImageModel', 'gpt-image-1'),
    apiKey: payload?.apiKey || config().get<string>('agentApiKey', '') || process.env.OPENAI_API_KEY || '',
  };
}

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || appPath();
}

function manuscriptPathForWorkspace(rootPath: string): string {
  return path.join(rootPath, texorManuscriptRelativePath);
}

async function assertWritableProjectWorkspace(rootPath: string): Promise<void> {
  const stat = await fs.stat(rootPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`项目路径不存在或不是目录: ${rootPath}`);
  }
  const manuscriptDir = path.dirname(manuscriptPathForWorkspace(rootPath));
  await fs.mkdir(manuscriptDir, { recursive: true });
  const probeFile = path.join(manuscriptDir, `.write-check-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(probeFile, 'ok', 'utf8');
  await fs.unlink(probeFile).catch(() => undefined);
}

function hasFullLatexDocument(latex: string): boolean {
  return /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(latex) && /\\begin\{document\}/.test(latex) && /\\end\{document\}/.test(latex);
}

function latexNonWhitespaceLength(latex: string): number {
  return latex.replace(/\s+/g, '').length;
}

function versionForPayload(snapshot: WorkspaceSnapshot | null, payload: { basedOnVersionId?: string; paperId?: string }): WorkspaceSnapshot['currentVersion'] | undefined {
  if (!snapshot || (payload.paperId && payload.paperId !== snapshot.paper.id)) {
    return undefined;
  }
  const versionId = payload.basedOnVersionId || snapshot.currentVersion.id;
  return snapshot.versions.find((entry) => entry.id === versionId) || snapshot.currentVersion;
}

function validateSubmittedLatex(candidate: string, baseVersion?: WorkspaceSnapshot['currentVersion']): void {
  if (!candidate.trim()) {
    throw new Error('Codex did not leave a manuscript to save.');
  }
  if (!hasFullLatexDocument(candidate)) {
    throw new Error('Codex output is not a complete LaTeX document, so texor refused to save it as a new paper version.');
  }
  if (baseVersion?.latex && hasFullLatexDocument(baseVersion.latex)) {
    const baseLength = latexNonWhitespaceLength(baseVersion.latex);
    const nextLength = latexNonWhitespaceLength(candidate);
    if (baseLength > 1200 && nextLength < baseLength * 0.72) {
      throw new Error('Codex output is much shorter than the selected base version. texor refused to save it to prevent accidental manuscript loss.');
    }
  }
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
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

  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && /^codex(?:\.exe|\.cmd|\.bat)?$/i.test(entry.name) && (await fileExists(candidate))) {
      return candidate;
    }
    if (entry.isDirectory()) {
      const nested = await findCodexBinaryInTree(candidate, depth - 1);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

async function resolveCodexExecutable(): Promise<string> {
  const configured = codexExecutable().trim();
  const candidates = configured && configured !== 'codex' ? [configured, 'codex'] : ['codex'];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
      if (await fileExists(candidate)) {
        return candidate;
      }
      continue;
    }

    try {
      const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
      const { stdout } = await execFileAsync(lookup, [candidate]);
      const resolved = stdout.trim();
      const resolvedCandidates = resolved.split(/\r?\n/).filter(Boolean);
      const first = resolvedCandidates.find((entry) => !isCodexPowerShellShim(entry)) || resolvedCandidates[0];
      if (first && (await fileExists(first))) {
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
        return found;
      }
    }
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
    message: message.length > 4000 ? `${message.slice(-4000)}` : message,
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

function snapshotMatchesCommand(snapshot: WorkspaceSnapshot | null, payload: CodexTaskCommandPayload): boolean {
  if (!snapshot) {
    return false;
  }
  if (payload.paperId) {
    return payload.paperId === snapshot.paper.id;
  }
  if (!snapshot.paper.projectRoot) {
    return false;
  }
  return path.resolve(payload.projectPath) === path.resolve(snapshot.paper.projectRoot);
}

async function recentSessionForCommand(command: BridgeCommand, snapshot: WorkspaceSnapshot | null = null): Promise<string | undefined> {
  const payload = command.payload as CodexTaskCommandPayload;
  if (payload.resumeSessionId) {
    return payload.resumeSessionId;
  }
  if (snapshotMatchesCommand(snapshot, payload) && snapshot?.paper.codexSessionId) {
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
    .filter((entry) => entry.sessionId || typeof entry.result?.sessionId === 'string')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const latest = candidates[candidates.length - 1];
  return latest?.sessionId || (latest?.result?.sessionId as string | undefined);
}

async function updatePaperCodexSession(paperId: string | undefined, sessionId: string | undefined): Promise<void> {
  if (!paperId || !sessionId) {
    return;
  }
  await request<WorkspaceSnapshot>(`/api/papers/${paperId}/codex-session`, {
    method: 'PATCH',
    body: JSON.stringify({ sessionId }),
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

type TexorAgentRoute =
  | 'quick-polish'
  | 'full-revision'
  | 'structure-diagram'
  | 'result-figure'
  | 'references'
  | 'general';

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

function compactCodexError(message: string): string {
  const normalized = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('{'))
    .filter((line) => !line.includes('codex_core_plugins'))
    .filter((line) => !line.includes('file_watcher'))
    .join('\n');

  const lower = normalized.toLowerCase();
  if (lower.includes('authentication') || lower.includes('unauthorized')) {
    return 'Codex 认证不可用，请在 VSCode/Codex CLI 中重新登录后再试。';
  }
  if (lower.includes('timed out')) {
    return 'Codex 任务超时，已停止本次生成。可以从这次会话继续。';
  }
  if (lower.includes('enoent')) {
    return '没有找到 Codex CLI，请检查 texor.codexExecutable 配置。';
  }
  if (lower.includes('eftype')) {
    return 'Windows 无法直接启动当前 Codex 脚本。请安装新版 TEXOR，或把 texor.codexExecutable 指向 codex.cmd / codex.exe，而不是 codex.ps1。';
  }
  return normalized.slice(-600) || 'Codex 没有正常完成，本次生成已结束。';
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

function includesAny(text: string, signals: string[]): boolean {
  return signals.some((signal) => text.includes(signal));
}

function classifyTexorAgentTask(payload: CodexTaskCommandPayload): TexorAgentRoute {
  const text = [
    payload.instruction,
    payload.selectedText,
    payload.sourceSnippet,
  ].filter(Boolean).join('\n').toLowerCase();

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

function texorAgentMemoryPath(rootPath: string): string {
  return path.join(rootPath, '.texor', 'agent', 'memory.json');
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

function texorAgentRouteInstructions(route: TexorAgentRoute): string[] {
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
    ];
  }
  if (route === 'full-revision') {
    return [
      ...common,
      'This is a manuscript-level consistency task. Inspect the current manuscript structure before editing.',
      'After editing, quickly scan related sections for terminology, claim, notation, citation, and contribution consistency.',
      'Do not invent new experiments or citations. If evidence is missing, leave a precise TODO in the manuscript or final summary.',
    ];
  }
  if (route === 'structure-diagram') {
    return [
      ...common,
      'This task asks for an architecture, pipeline, workflow, or schematic figure.',
      'First inspect the project/manuscript enough to understand the method. Then create a figure asset under .texor/figures/ and reference it from main.tex.',
      'Prefer generate_image for bitmap diagrams when an image API is configured; otherwise write a simple project-local script or TikZ/LaTeX figure that can compile.',
    ];
  }
  if (route === 'result-figure') {
    return [
      ...common,
      'This task changes result visualizations. Inspect existing project scripts/data before editing.',
      'Modify or add project-local plotting code, run it when feasible, save outputs under .texor/figures/ or the project figure directory, and update main.tex references.',
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

function texorAgentSystemPrompt(rootPath: string, manuscriptPath: string, route: TexorAgentRoute, modelConfig: ModelConfig): string {
  return [
    'You are TEXOR, a research-paper agent runtime.',
    'You revise and draft LaTeX manuscripts by using explicit tools. You are not Codex and must not mention TEXOR, tooling, browser UI, or .texor metadata in manuscript prose.',
    '',
    `Project workspace: ${rootPath}`,
    `Main manuscript path: ${manuscriptPath}`,
    `Task route: ${routeLabel(route)}`,
    `Text model: ${modelConfig.model || 'gpt-4.1-mini'}`,
    `Image model: ${modelConfig.imageModel || 'gpt-image-1'}`,
    '',
    'You must respond with exactly one JSON object and no markdown.',
    'Allowed forms:',
    '{"thought":"brief status for user","tool":"read_file","args":{"path":"relative/path"}}',
    '{"thought":"brief status for user","tool":"list_files","args":{"path":"relative/path","limit":80}}',
    '{"thought":"brief status for user","tool":"write_file","args":{"path":".texor/manuscript/main.tex","content":"..."}}',
    '{"thought":"brief status for user","tool":"run_command","args":{"command":"python script.py","timeoutMs":120000}}',
    '{"thought":"brief status for user","tool":"generate_image","args":{"prompt":"diagram prompt","outputPath":".texor/figures/diagram.png","size":"1024x1024"}}',
    '{"thought":"brief status for user","tool":"search_papers","args":{"query":"paper search query","limit":5}}',
    '{"thought":"brief status for user","final":"short final summary"}',
    '',
    'Rules:',
    '- Prefer local manuscript edits. For selected PDF text, edit only the located LaTeX area unless consistency requires a broader change.',
    '- Keep a complete compilable LaTeX document at the main manuscript path.',
    '- Read project files before making factual claims.',
    '- Do not invent results, datasets, citations, or experiments.',
    '- Use run_command only for project-local, non-destructive commands.',
    '',
    'Route-specific instructions:',
    ...texorAgentRouteInstructions(route).map((line) => `- ${line}`),
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

async function runTexorAgentTool(rootPath: string, call: TexorAgentToolCall, modelConfig: ModelConfig): Promise<string> {
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
  if (tool === 'write_file') {
    const requested = String(args.path || '');
    const content = String(args.content || '');
    if (!content.trim()) {
      throw new Error('TEXOR Agent refused to write empty content.');
    }
    const filePath = safeRelativePath(rootPath, requested);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return `wrote ${path.relative(rootPath, filePath)} (${content.length} chars)`;
  }
  if (tool === 'run_command') {
    const command = String(args.command || '').trim();
    if (!command) {
      throw new Error('run_command requires command.');
    }
    if (/(\brm\b|\bdel\b|\brmdir\b|\bformat\b|git\s+reset|git\s+checkout\s+--)/i.test(command)) {
      throw new Error(`TEXOR Agent refused destructive command: ${command}`);
    }
    const timeoutMs = Math.max(5_000, Math.min(180_000, Number(args.timeoutMs || 60_000)));
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
      child.on('exit', (code) => {
        const output = compactToolOutput(chunks.join('').trim() || `(exit ${code})`);
        if (code === 0) {
          resolve(output);
          return;
        }
        reject(new Error(output || `command exited with code ${code}`));
      });
    });
  }
  if (tool === 'generate_image') {
    return await generateImage(rootPath, modelConfig, args);
  }
  if (tool === 'search_papers') {
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
  } = {},
): Promise<{ output: string; sessionId: string; interruptedBy?: BridgeCommandControl }> {
  const rootPath = payload.projectPath;
  const manuscriptPath = manuscriptPathForWorkspace(rootPath);
  const modelConfig = texorAgentModelConfig(payload.modelConfig);
  const route = classifyTexorAgentTask(payload);
  const sessionId = `texor-agent:${path.resolve(rootPath)}`;
  options.onProgress?.('connecting', `TEXOR Agent 正在连接 ${modelConfig.provider || '模型 API'}`);
  options.onLog?.('system', `进入${routeLabel(route)}模式。`);
  options.onLog?.('system', `使用 ${modelConfig.provider || 'OpenAI-compatible'} 的 ${modelConfig.model || 'gpt-4.1-mini'}。`);
  const sourceFileRelative = relativePathInsideRoot(rootPath, payload.sourceFile);
  const memory = await loadTexorAgentMemory(rootPath);

  if (route === 'quick-polish') {
    const quickOutput = await runQuickPolishAgent(payload, snapshot, modelConfig, options);
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
    { role: 'system', content: texorAgentSystemPrompt(rootPath, manuscriptPath, route, modelConfig) },
    {
      role: 'user',
      content: [
        `Target journal: ${payload.targetJournal || snapshot?.paper.targetJournal || 'not specified'}`,
        snapshot ? `Current version: ${snapshot.currentVersion.label}` : 'No stored manuscript version yet.',
        `Prior project conversation memory:\n${formatTexorAgentMemory(memory)}`,
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
  const maxSteps = routeStepLimit(route);
  for (let step = 0; step < maxSteps; step += 1) {
    const control = await options.controlSignal?.();
    if (control) {
      return { output, sessionId, interruptedBy: control };
    }
    options.onProgress?.(step === 0 ? 'thinking' : 'working', route === 'quick-polish' ? '正在做局部修改' : `正在${routeLabel(route)}`);
    const response = await callTexorAgentModel(messages, modelConfig);
    output += `\n${response.content}`;
    const parsed = extractJsonObject(response.content);
    if (!parsed) {
      throw new Error(`TEXOR Agent model did not return valid JSON: ${response.content.slice(0, 500)}`);
    }
    const thought = typeof parsed.thought === 'string' ? parsed.thought : 'TEXOR Agent 正在处理';
    options.onLog?.('system', thought);
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
      return { output, sessionId };
    }
    const tool = typeof parsed.tool === 'string' ? parsed.tool : '';
    if (!tool) {
      throw new Error('TEXOR Agent response needs either final or tool.');
    }
    const toolResult = await runTexorAgentTool(rootPath, {
      tool,
      args: parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? parsed.args as Record<string, unknown> : {},
    }, modelConfig);
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
    return { stream: 'stderr', message: 'Codex 本轮没有正常完成。' };
  }

  const item = event.item as Record<string, unknown> | undefined;
  if (!item) {
    return null;
  }

  const itemType = item.type;
  if (itemType === 'agent_message' || itemType === 'message') {
    const text = compactReadableText(textFromUnknown(item));
    if (isNoisyCommandLog(text)) {
      return null;
    }
    return text ? { stream: 'stdout', message: text } : null;
  }

  if (itemType === 'command_execution' || itemType === 'tool_call') {
    const commandText = compactReadableText(commandTextFromItem(item), 220);
    if (isNoisyCommandLog(commandText)) {
      return null;
    }
    const status = typeof item.status === 'string' ? item.status : '';
    if (status === 'in_progress' || status === 'running') {
      return { stream: 'system', message: commandText ? `运行命令: ${commandText}` : 'Codex 正在操作项目文件。' };
    }
    if (status === 'failed' || status === 'error') {
      return { stream: 'stderr', message: commandText ? `命令失败: ${commandText}` : 'Codex 的一步操作失败。' };
    }
    return { stream: 'system', message: commandText ? `完成命令: ${commandText}` : 'Codex 完成一步项目操作。' };
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
      return { phase: 'working', message: 'Codex 正在查看或修改项目文件' };
    }
    return { phase: 'thinking', message: 'Codex 已完成一步项目操作' };
  }
  if (item.type === 'agent_message') {
    return { phase: 'finalizing', message: 'Codex 正在整理结果' };
  }
  return null;
}

async function runCodexExec(
  prompt: string,
  cwd: string,
  options: {
    resumeSessionId?: string;
    onProgress?: (phase: BridgeCommandPhase, message: string) => void;
    onLog?: (stream: BridgeCommandLogStream, message: string) => void;
    onSession?: (sessionId: string) => void;
    controlSignal?: () => Promise<BridgeCommandControl | undefined>;
  } = {},
): Promise<CodexExecResult> {
  const executable = await resolveCodexExecutable();
  const args = options.resumeSessionId
    ? [
        'exec',
        'resume',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--json',
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
        '-',
      ];
  const spawnCommand = codexSpawnCommand(executable, args);
  options.onProgress?.('connecting', '正在连接 Codex');
  options.onLog?.('system', `启动 Codex CLI: ${spawnCommand.display}`);
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
    let stderr = '';
    let jsonBuffer = '';
    let sessionId: string | undefined;
    let interruptedBy: BridgeCommandControl | undefined;
    let toolFailure: Error | undefined;
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
    const timeout = setTimeout(() => {
      clearInterval(heartbeat);
      clearInterval(controlTimer);
      child.kill('SIGTERM');
      reject(new Error('Codex task timed out after 30 minutes.'));
    }, 30 * 60 * 1000);

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
          const readableLog = codexReadableLogFromEvent(event);
          if (readableLog) {
            options.onLog?.(readableLog.stream, readableLog.message);
          }
          if (readableLog && isToolLayerWriteFailure(readableLog.message)) {
            toolFailure = new Error('Codex 工具层写入失败，已停止本次任务；不会保存替代文本为论文版本。');
            options.onProgress?.('failed', 'Codex 工具层写入失败');
            options.onLog?.('stderr', toolFailure.message);
            child.kill('SIGTERM');
            return;
          }
        } catch {
          // Non-JSON chunks should not leak to the browser; Codex will surface failures on close.
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
    });
    child.on('error', (error) => {
      settled = true;
      clearInterval(heartbeat);
      clearInterval(controlTimer);
      clearTimeout(timeout);
      options.onLog?.('stderr', compactCodexError(error.message));
      reject(error);
    });
    child.on('close', (code) => {
      settled = true;
      clearInterval(heartbeat);
      clearInterval(controlTimer);
      clearTimeout(timeout);
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (interruptedBy) {
        resolve({ output, sessionId, interruptedBy });
        return;
      }
      if (toolFailure || isToolLayerWriteFailure(output)) {
        reject(toolFailure || new Error('Codex 工具层写入失败，已停止本次任务；不会保存替代文本为论文版本。'));
        return;
      }
      if (code === 0) {
        options.onLog?.('system', 'Codex CLI 正常退出。');
        resolve({ output, sessionId });
      } else {
        const message = compactCodexError(output || `Codex exited with code ${code}.`);
        options.onLog?.('stderr', message);
        reject(new Error(message));
      }
    });
    child.stdin.end(prompt);
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

async function seedManuscriptFromVersion(manuscriptPath: string, snapshot: WorkspaceSnapshot | null, versionId?: string): Promise<void> {
  if (!snapshot || !versionId) {
    return;
  }
  const version = snapshot.versions.find((entry) => entry.id === versionId);
  if (!version?.latex) {
    return;
  }
  await fs.mkdir(path.dirname(manuscriptPath), { recursive: true });
  await fs.writeFile(manuscriptPath, version.latex, 'utf8');
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
      }),
    });
    await context.workspaceState.update(stateKeys.paperId, snapshot.paper.id);
    await context.workspaceState.update(stateKeys.versionId, snapshot.currentVersion.id);
    return snapshot;
  }

  const latex = await activeLatex(payload.sourcePath || context.workspaceState.get<string>(stateKeys.manuscriptPath));
  validateSubmittedLatex(latex, baseVersion);
  const snapshot = await request<WorkspaceSnapshot>(`/api/codex/papers/${payload.paperId}/versions`, {
    method: 'POST',
      body: JSON.stringify({
        latex,
        summary: payload.summary || 'Codex browser revision',
        sourcePath: canonicalSourcePath || context.workspaceState.get<string>(stateKeys.manuscriptPath),
        basedOnVersionId: payload.basedOnVersionId,
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
  const targetLabel = snapshot
    ? `${snapshot.paper.title} / ${snapshot.paper.targetJournal} / ${snapshot.currentVersion.label}`
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
    '- Prefer concise academic prose and avoid marketing language.',
    '- Preserve terminology and notation consistently across sections.',
    '',
    'Skill 5 - LaTeX discipline',
    '- Write a complete compilable LaTeX document at the main manuscript path.',
    '- Preserve or create stable labels, refs, citations, math macros, figures, tables, and bibliography hooks.',
    '- Never return replacement LaTeX in chat instead of writing the file. If file writes fail, stop and report the tool-layer failure.',
  ];
}

function buildBrowserTaskPrompt(payload: CodexTaskCommandPayload, snapshot: WorkspaceSnapshot | null): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const rootPath = payload.projectPath || workspaceRoot || process.cwd();
  const manuscriptPath = manuscriptPathForWorkspace(rootPath);
  const sourceTarget = payload.sourceFile
    ? `${payload.sourceFile}${payload.sourceLine ? `:${payload.sourceLine}` : ''}`
    : undefined;
  const targetLabel = snapshot
    ? `${snapshot.paper.title} / ${snapshot.paper.targetJournal} / ${snapshot.currentVersion.label}`
    : 'No manuscript version has been submitted yet.';
  const baseVersion = snapshot?.versions.find((entry) => entry.id === (payload.baseVersionId || payload.versionId));
  const skillPack = payload.draftingMode === 'initial-draft' ? initialDraftSkillPack() : [];
  return [
    '# manuscript task',
    '',
    `Project workspace: ${rootPath}`,
    `Main manuscript path: ${manuscriptPath}`,
    `Target journal: ${payload.targetJournal || snapshot?.paper.targetJournal || 'not specified'}`,
    `Manuscript: ${targetLabel}`,
    baseVersion ? `Revision base version: ${baseVersion.label} (${baseVersion.id})` : undefined,
    ...skillPack,
    '',
    'User request, verbatim:',
    payload.instruction,
    '',
    payload.selectedText ? 'Selected PDF text/context:' : undefined,
    payload.selectedText || undefined,
    sourceTarget ? 'Target LaTeX source:' : undefined,
    sourceTarget,
    payload.sourceSnippet ? 'Nearby LaTeX source snippet:' : undefined,
    payload.sourceSnippet || undefined,
    '',
    'Operational constraint: work only from the project workspace and the main manuscript path above. The tool name, task routing, browser UI, extension, and .texor directory are implementation metadata; never mention them in manuscript prose. If local file writes fail, stop and report failure instead of returning replacement LaTeX text. For PDF annotations, edit the located source area by default; broaden scope only if the user request requires it.',
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

async function executeAgentTaskCommand(context: vscode.ExtensionContext, command: BridgeCommand): Promise<void> {
  const payload = command.payload as CodexTaskCommandPayload;
  if (!payload.instruction?.trim()) {
    throw new Error('Agent task instruction is empty.');
  }
  if (!payload.projectPath?.trim()) {
    throw new Error('Project path is required. TEXOR uses it as the Agent workspace for understanding and controlling the code project.');
  }

  const cwd = payload.projectPath;
  await updateBridgeProgress(command.id, 'preparing', '正在确认项目可写');
  await assertWritableProjectWorkspace(cwd);
  const manuscriptPath = manuscriptPathForWorkspace(cwd);
  const backend = payload.agentBackend || (payload.modelConfig?.apiKey ? 'texor-agent' : 'codex-cli');
  const agentName = backend === 'texor-agent' ? 'TEXOR Agent' : 'Codex';
  await updateBridgeCommand(command.id, 'running', {
    phase: 'preparing',
    message: '正在读取当前论文状态',
  });

  let snapshot: WorkspaceSnapshot | null = null;
  try {
    snapshot = await refreshWorkspaceStateForCommand(context, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateBridgeCommand(command.id, undefined, {
      message: '读取论文状态失败，将只基于项目路径继续',
      logs: [bridgeLog('stderr', message)],
    }).catch(() => undefined);
  }

  const resumeSessionId = await recentSessionForCommand(command, snapshot);
  let latestSessionId = resumeSessionId;
  let persistedSessionId: string | undefined;
  const rememberProjectSession = (paperId: string | undefined, nextSessionId: string | undefined) => {
    if (!paperId || !nextSessionId || persistedSessionId === nextSessionId) {
      return;
    }
    persistedSessionId = nextSessionId;
    void updatePaperCodexSession(paperId, nextSessionId);
  };
  rememberProjectSession(payload.paperId || snapshot?.paper.id, resumeSessionId);
  await updateBridgeCommand(command.id, 'running', {
    phase: 'preparing',
    message: backend === 'codex-cli'
      ? (resumeSessionId ? '正在回到该项目的 Codex 对话' : '正在为该项目开启 Codex 对话')
      : '正在启动 TEXOR Agent',
    sessionId: resumeSessionId,
  });

  await updateBridgeProgress(command.id, 'preparing', '正在准备论文输出位置');
  await fs.mkdir(path.dirname(manuscriptPath), { recursive: true });
  await seedManuscriptFromVersion(manuscriptPath, snapshot, payload.baseVersionId || payload.versionId);

  const prompt = buildBrowserTaskPrompt(payload, snapshot);
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
  const { output, sessionId, interruptedBy } = backend === 'texor-agent'
    ? await runTexorAgent(payload, snapshot, commonRunOptions)
    : await runCodexExec(prompt, cwd, {
        ...commonRunOptions,
        resumeSessionId,
        onSession: (nextSessionId) => {
          latestSessionId = nextSessionId;
          void updateBridgeCommand(command.id, undefined, { sessionId: nextSessionId }).catch(() => undefined);
          rememberProjectSession(payload.paperId || snapshot?.paper.id, nextSessionId);
        },
      });
  latestSessionId = latestSessionId || sessionId;
  rememberProjectSession(payload.paperId || snapshot?.paper.id, latestSessionId);
  await context.workspaceState.update(stateKeys.manuscriptPath, manuscriptPath);
  if (interruptedBy) {
    const snapshotAfterPause = await submitCurrentLatexFromBrowser(context, {
      paperId: payload.paperId,
      title: snapshot?.paper.title,
      targetJournal: payload.targetJournal || snapshot?.paper.targetJournal,
      summary: interruptedBy === 'pause' ? `${agentName} paused draft` : `${agentName} terminated draft`,
      basedOnVersionId: payload.baseVersionId || payload.versionId,
      projectRoot: cwd,
      sourcePath: manuscriptPath,
    }, snapshot);
    await updatePaperCodexSession(snapshotAfterPause.paper.id, latestSessionId);
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
        output: output.slice(-8000),
      },
    });
    return;
  }
  await updateBridgeProgress(command.id, 'finalizing', `${agentName} 已完成，正在自动保存版本`);
  const snapshotAfterCodex = await submitCurrentLatexFromBrowser(context, {
    paperId: payload.paperId,
    title: snapshot?.paper.title,
    targetJournal: payload.targetJournal || snapshot?.paper.targetJournal,
    summary: payload.source === 'annotation' ? `${agentName} annotation revision` : `${agentName} browser revision`,
    basedOnVersionId: payload.baseVersionId || payload.versionId,
    projectRoot: cwd,
    sourcePath: manuscriptPath,
  }, snapshot);
  await updatePaperCodexSession(snapshotAfterCodex.paper.id, latestSessionId);
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
      output: output.slice(-8000),
    },
  });
  vscode.window.showInformationMessage(`${agentName} finished. texor stored ${snapshotAfterCodex.currentVersion.label}.`);
}

async function executeBridgeCommand(context: vscode.ExtensionContext, command: BridgeCommand): Promise<void> {
  const claimed = await claimBridgeCommand(command.id);
  if (!claimed) {
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
    await updateBridgeCommand(claimed.id, 'failed', {
      phase: message.toLowerCase().includes('timed out') ? 'interrupted' : 'failed',
      message: compactCodexError(message),
      logs: [bridgeLog('stderr', message)],
    }).catch(() => undefined);
    throw error;
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
  }, 3000);
}

async function pollBridgeCommands(context: vscode.ExtensionContext): Promise<void> {
  if (pollingBridge) {
    return;
  }

  pollingBridge = true;
  try {
    const params = new URLSearchParams({ status: 'queued', limit: '1' });
    const commands = await request<BridgeCommand[]>(`/api/bridge/commands?${params.toString()}`);
    lastBridgeConnectionErrorAt = 0;
    const command = commands[0];
    if (!command) {
      return;
    }
    await executeBridgeCommand(context, command);
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
  }, 2000);
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
  startBridgePolling(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('texor.open', command(() => launchBrowserWorkbench(context))),
  );
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
