import {
  Archive,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CircleAlert,
  Download,
  FilePlus2,
  FolderOpen,
  History,
  LayoutPanelTop,
  LoaderCircle,
  MoreHorizontal,
  Play,
  RotateCcw,
  Sparkles,
  ExternalLink,
  PanelsTopLeft,
  PanelTopClose,
  X,
} from 'lucide-react';
import { diffWordsWithSpace } from 'diff';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  applyRevision,
  compilePaper,
  compileDiff,
  createCodexPaper,
  createBridgeCommand,
  deleteWorkspace,
  downloadBinary,
  getHealth,
  getWorkspace,
  importTexPaper,
  importVSCodeConfig,
  ensureTemplate,
  exportDesktopDiagnosticsBundle,
  exportWorkspaceArchive,
  listBridgeCommands,
  listSSHHosts,
  listWorkspaces,
  listWorkspaceFiles,
  locatePdfSelection,
  locateSourceLine,
  openWorkspaceFromProjectRoot,
  prepareDesktopProject,
  readWorkspaceFile,
  restoreWorkspaceVersion,
  runWorkspaceCommand,
  searchTemplates,
  submitCodexFeedback,
  updateBridgeCommand,
  updateWorkspaceRuntimeConfig,
  writeWorkspaceFile,
} from './api';
import { AnnotationTarget, PaperPreview } from './components/PaperPreview';
import { PdfThumbnailPreview } from './components/PdfThumbnailPreview';
import { QuickIssueBar } from './components/QuickIssueBar';
import { PdfJumpTarget, PdfRegionSelection, SelectablePdf } from './components/SelectablePdf';
import {
  AgentBackend,
  BridgeCommand,
  BridgeCommandLogEntry,
  CodexTaskCommandPayload,
  CodexTaskIntent,
  DesktopPreparedTarget,
  DiffCompileResult,
  DraftingMode,
  HealthResponse,
  ManuscriptAsset,
  ModelConfig,
  PaperVersion,
  ProjectExecutionTarget,
  SSHHostProfile,
  TaskSpeedMode,
  TemplateEnsureResult,
  TemplateSuggestion,
  WorkspaceCommandResult,
  WorkspaceFileNode,
  WorkspaceRuntimeConfig,
  WorkspaceSnapshot,
  WorkspaceSummary,
} from './types';

type ObserverViewMode = 'process' | 'details';

type ObserverProcessTone = 'neutral' | 'warning';

type ScreenMode = 'hub' | 'workspace';
type LeftPaneMode = 'previous' | 'latex' | 'files';
type HistoryFilterMode = 'all' | 'checkpoints' | 'edits' | 'drafts';

const DEFAULT_TARGET_JOURNAL = 'arXiv';
const DEFAULT_TEXOR_AGENT_MODEL = 'gpt-4.1-mini';
const DEFAULT_CODEX_MODEL = 'gpt-5.4';
const DEFAULT_CODEX_REASONING_EFFORT = 'xhigh';
const CODEX_REASONING_OPTIONS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const WORKSPACE_REFRESH_IDLE_INTERVAL_MS = 2400;
const WORKSPACE_REFRESH_ACTIVE_INTERVAL_MS = 1000;
const BRIDGE_COMMAND_REFRESH_IDLE_INTERVAL_MS = 1500;
const BRIDGE_COMMAND_REFRESH_ACTIVE_INTERVAL_MS = 450;
const HISTORY_GROUP_ORDER = ['Checkpoints & Rewinds', 'Draft Origins', 'Edits'] as const;
type HistoryGroupLabel = (typeof HISTORY_GROUP_ORDER)[number];

interface HistoryTimelineGroup {
  label: HistoryGroupLabel;
  versions: PaperVersion[];
  containsDraftPreview: boolean;
  containsViewedVersion: boolean;
  containsLatestCurrent: boolean;
  containsPendingExternal: boolean;
  containsNavigationPath: boolean;
}

interface HistoryNavigationState {
  targetVersionId: string;
  highlightedVersionIds: string[];
}

function requestedPaperIdFromUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get('paperId')?.trim() || '';
}

interface ObserverProcessEntry {
  id: string;
  time: string;
  message: string;
  tone: ObserverProcessTone;
}

interface PendingWorkspaceUpdate {
  versionId: string;
  label: string;
  summary: string;
  createdAt: string;
}

interface VersionPathSegment {
  type: 'version' | 'separator';
  label: string;
  versionId?: string;
}

interface VersionCompareContext {
  referenceVersion: PaperVersion;
  focusVersion: PaperVersion;
  relationLabel: string;
  pathLabel: string;
  pathSegments: VersionPathSegment[];
  sharedAncestor: PaperVersion | null;
}

interface BridgeCommandCompareContext {
  baseVersion: PaperVersion;
  focusVersion: PaperVersion | null;
  focusVersionSource: 'payload' | 'fallback' | 'none';
  relationLabel: string;
  pathLabel: string;
  pathSegments: VersionPathSegment[];
  sharedAncestor: PaperVersion | null;
  compareActionLabel: string;
}

interface ActiveCompareContext extends VersionCompareContext {
  leftVersion: PaperVersion;
  rightVersion: PaperVersion;
  reverseRelationLabel: string;
  compareActionLabel: string;
}

interface HistoryNavigationVersionContext {
  roleLabel: string;
  roleHint: string;
  relationLabel: string;
  routeLabel: string;
  routeSegments: VersionPathSegment[];
  actionLabel: string;
  compareReferenceVersion: PaperVersion | null;
  compareFocusVersion: PaperVersion | null;
}

interface HistoryTimelineCompareContext extends VersionCompareContext {
  compareTarget: PaperVersion;
  compareActionLabel: string;
}

interface SavedVersionContext extends VersionCompareContext {
  message: string;
  revisionNote: string;
  savedVersion: PaperVersion | null;
  savedVersionId: string;
  baseVersion: PaperVersion | null;
  baseVersionId?: string;
  compareActionLabel: string;
}

interface ObserverRevisionStage {
  tone: 'submission' | 'saved';
  heading: string;
  summary: string;
  relationLabel: string;
  relationTitle: string;
  relationReferenceVersion: PaperVersion | null;
  relationFocusVersion: PaperVersion | null;
  pathHeading: string;
  pathLabel: string;
  pathSegments: VersionPathSegment[];
  compareActionLabel: string;
  compareActionTitle: string;
  compareReferenceVersion: PaperVersion | null;
  compareFocusVersion: PaperVersion | null;
  splitActionLabel: string;
  splitActionTitle: string;
  splitVersion: PaperVersion | null;
  splitFocusVersion: PaperVersion | null;
  primaryLinks: Array<{ label: string; versionId: string }>;
  impactRegions: Array<{ label: string; query: string }>;
}

type ObserverSummaryTone = 'submission' | 'saved' | 'neutral' | 'warning' | 'running';

interface ObserverPaneMeta {
  chipLabel: string;
  chipTone: ObserverSummaryTone;
  description: string;
}

interface ObserverEventSummaryItem {
  key: string;
  tone: ObserverSummaryTone;
  label: string;
  value: string;
  title: string;
  compareReferenceVersion: PaperVersion | null;
  compareFocusVersion: PaperVersion | null;
  targetVersion: PaperVersion | null;
  targetQuery?: string;
  segmentedValues?: Array<{ key: string; label: string; targetQuery?: string }>;
}

interface CompareEntrySource {
  kind: 'observer-saved-region';
  regionLabel: string;
  regionQuery: string;
}

interface CompareEntryContext extends CompareEntrySource {
  paperId: string;
  referenceVersionId: string;
  focusVersionId: string;
}

interface CompareEntryPresentation {
  label: string;
  detail: string;
  focusTitle: string;
  revisionTitle: string;
}

interface VersionInsightEntry {
  label: string;
  detail: string;
  title: string;
  chipLabel: string;
  chipTitle: string;
  versionId: string;
  query: string;
  actionLabel?: string;
  actionTitle?: string;
  actionReferenceVersionId?: string;
  actionFocusVersionId?: string;
}

type HistoryPreviewEntrySource = CompareEntrySource & {
  compareReferenceVersionId?: string;
};

interface HistoryPreviewEntryContext extends CompareEntrySource {
  paperId: string;
  versionId: string;
  compareReferenceVersionId?: string;
}

type VersionCompareShortcutKind = 'default' | 'split';
type VersionPathHeadingKind = 'revision' | 'submission' | 'current' | 'focus-route';

function compareEntryContextMatches(
  context: CompareEntryContext | null,
  paperId: string | null | undefined,
  referenceVersionId: string,
  focusVersionId: string,
) {
  return Boolean(
    context &&
    paperId &&
    context.paperId === paperId &&
    context.referenceVersionId === referenceVersionId &&
    context.focusVersionId === focusVersionId,
  );
}

function compareEntryPresentation(
  context: CompareEntryContext | null,
  focusVersion?: PaperVersion | null,
): CompareEntryPresentation | null {
  if (!context) {
    return null;
  }
  const focusLabel = focusVersion?.label || 'saved revision';
  return {
    label: 'Opened from observer',
    detail: `Changed region in ${focusLabel}`,
    focusTitle: `Open ${focusLabel} and focus ${context.regionLabel}`,
    revisionTitle: `Opened from observer on changed region ${context.regionLabel} in ${focusLabel}`,
  };
}

function historyPreviewEntryContextMatches(
  context: HistoryPreviewEntryContext | null,
  paperId: string | null | undefined,
  versionId: string,
) {
  return Boolean(context && paperId && context.paperId === paperId && context.versionId === versionId);
}

function historyPreviewEntryPresentation(
  context: HistoryPreviewEntryContext | null,
  version?: PaperVersion | null,
): CompareEntryPresentation | null {
  if (!context) {
    return null;
  }
  const versionLabel = version?.label || 'saved revision';
  return {
    label: 'Opened from observer',
    detail: `Focused region in ${versionLabel}`,
    focusTitle: `Focus ${context.regionLabel} in ${versionLabel}`,
    revisionTitle: `Opened from observer on changed region ${context.regionLabel} in ${versionLabel}`,
  };
}

function commandStatusLabel(command?: BridgeCommand | null): string {
  if (!command) {
    return '空闲';
  }
  if (command.status === 'queued') {
    return '排队';
  }
  if (command.status === 'running') {
    return '运行';
  }
  if (command.status === 'done') {
    return '完成';
  }
  return '失败';
}

function isRecentCommand(command: BridgeCommand): boolean {
  if (command.status === 'queued' || command.status === 'running') {
    return true;
  }
  return Date.now() - new Date(command.updatedAt).getTime() < 30 * 60 * 1000;
}

function commandIsActive(command?: BridgeCommand | null): boolean {
  return Boolean(command && (command.status === 'queued' || command.status === 'running'));
}

function looksLikeScopedQuickRevision(
  payload: { issue?: string; changeRequest: string; taskSpeedMode: TaskSpeedMode },
  annotation?: AnnotationTarget | null,
): boolean {
  if (!annotation?.selectedText?.trim()) {
    return false;
  }
  if (payload.taskSpeedMode !== 'quick') {
    return false;
  }
  const text = `${payload.issue || ''}\n${payload.changeRequest}`.toLowerCase();
  const heavySignals = [
    'experiment',
    '实验',
    'figure',
    '图',
    'table',
    '表',
    'result',
    '结果',
    'metric',
    '指标',
    'run ',
    '运行',
    '代码',
    'plot',
    '绘图',
    'visual',
    '可视化',
    '全篇',
    '全文',
    'structure',
    '结构',
  ];
  if (heavySignals.some((signal) => text.includes(signal))) {
    return false;
  }
  const quickSignals = ['措辞', '表述', '润色', '改写', '语法', '更自然', '更学术', 'wording', 'phrase', 'polish', 'grammar', 'rewrite'];
  return quickSignals.some((signal) => text.includes(signal));
}

function textBlockForQuickRevision(snapshot: WorkspaceSnapshot, annotation?: AnnotationTarget | null): PaperVersion['blocks'][number] | null {
  if (!annotation?.selectedText?.trim()) {
    return null;
  }
  const selected = annotation.selectedText.replace(/^已选文字:\s*/m, '').replace(/\s+/g, ' ').trim();
  if (!selected) {
    return null;
  }
  const textBlocks = snapshot.currentVersion.blocks.filter((block) => block.type === 'text');
  for (const block of textBlocks) {
    const content = block.content.replace(/\s+/g, ' ').trim();
    if (content.includes(selected) || selected.includes(content.slice(0, Math.min(48, content.length)))) {
      return block;
    }
  }
  return textBlocks[0] || null;
}

function localBridgeLog(stream: BridgeCommandLogEntry['stream'], message: string): BridgeCommandLogEntry {
  return {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    stream,
    message,
  };
}

function commandMessage(command?: BridgeCommand | null): string {
  if (!command) {
    return '等待 TEXOR';
  }
  if (command.message) {
    const derived = commandDerivedFailure(command);
    if (
      command.status === 'failed' &&
      derived &&
      ['本轮没有正常完成', 'TEXOR 没有正常完成'].includes(command.message.trim())
    ) {
      return derived.summary;
    }
    return command.message;
  }
  if (command.status === 'queued') {
    return '等待 VSCode 接收任务';
  }
  if (command.status === 'running') {
    return 'TEXOR 正在处理';
  }
  if (command.status === 'done') {
    return 'TEXOR 已完成';
  }
  return 'TEXOR 没有正常完成';
}

function parsedBridgeLogMessage(message: string): string {
  const text = compactLogMessage(message);
  if (!text.startsWith('{')) {
    return text;
  }
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Ignore malformed JSON fragments and fall through to raw text.
  }
  return text;
}

function commandDerivedFailure(command?: BridgeCommand | null): { summary: string; detail: string } | null {
  if (!command || command.status !== 'failed') {
    return null;
  }
  const logs = [...(command.logs || [])].reverse();
  for (const entry of logs) {
    const detail = parsedBridgeLogMessage(entry.message);
    const lower = detail.toLowerCase();
    if (lower.includes('503 service unavailable') || lower.includes('service temporarily unavailable')) {
      return {
        summary: 'Codex 上游服务暂时不可用',
        detail,
      };
    }
    if (lower.includes('401 unauthorized') || lower.includes('incorrect api key provided') || lower.includes('authentication') || lower.includes('unauthorized')) {
      return {
        summary: 'Codex 认证失败',
        detail,
      };
    }
    if (lower.includes('timed out')) {
      return {
        summary: '任务执行超时',
        detail,
      };
    }
    if (lower.includes('unexpected status')) {
      return {
        summary: 'Codex 请求失败',
        detail,
      };
    }
  }
  return null;
}

function commandFailureHint(command?: BridgeCommand | null): string | null {
  if (!command || command.status !== 'failed') {
    return null;
  }
  const diagnosis = command.result?.failureDiagnosis as
    | { summary?: string; suggestion?: string }
    | undefined;
  if (diagnosis?.suggestion) {
    return diagnosis.suggestion;
  }
  if (diagnosis?.summary) {
    return diagnosis.summary;
  }
  const derived = commandDerivedFailure(command);
  if (derived) {
    return derived.summary;
  }
  return null;
}

function commandDraftHint(command?: BridgeCommand | null): string | null {
  if (!command || command.status !== 'failed') {
    return null;
  }
  const failedDraft = command.result?.failedDraft as
    | { draftPath?: string; bytes?: number }
    | undefined;
  if (!failedDraft?.draftPath) {
    return null;
  }
  return `已保留中间稿：${failedDraft.draftPath}${failedDraft.bytes ? ` (${Math.round(failedDraft.bytes / 1024)} KB)` : ''}`;
}

function commandSavedVersionHint(
  command: BridgeCommand,
  workspace: WorkspaceSnapshot | null,
): SavedVersionContext | null {
  if (!workspace || command.status !== 'done' || command.type !== 'codex-task') {
    return null;
  }
  const payload = codexTaskPayload(command);
  const savedVersionId = typeof command.result?.versionId === 'string' ? command.result.versionId : undefined;
  const savedVersionLabel =
    (typeof command.result?.label === 'string' && command.result.label.trim()) ||
    workspace.versions.find((version) => version.id === savedVersionId)?.label ||
    '';
  if (!payload || !savedVersionId || !savedVersionLabel) {
    return null;
  }
  const baseVersionId = payload.baseVersionId || payload.versionId;
  const baseVersion = baseVersionId ? workspace.versions.find((version) => version.id === baseVersionId) : null;
  const resolvedSavedVersion = workspace.versions.find((version) => version.id === savedVersionId) || null;
  if (!baseVersion || baseVersion.id === savedVersionId) {
    return {
      message: `Saved as ${savedVersionLabel}`,
      revisionNote: `Revision path ${savedVersionLabel} same revision`,
      relationLabel: '',
      pathLabel: `${savedVersionLabel} same revision`,
      pathSegments: [{ type: 'version', label: savedVersionLabel, versionId: savedVersionId }, { type: 'separator', label: 'same revision' }],
      sharedAncestor: null,
      referenceVersion: resolvedSavedVersion || baseVersion || workspace.currentVersion,
      focusVersion: resolvedSavedVersion || baseVersion || workspace.currentVersion,
      savedVersion: resolvedSavedVersion,
      savedVersionId,
      baseVersion: null,
      compareActionLabel: '',
    };
  }
  const savedVersion = resolvedSavedVersion;
  const savedCompareContext = savedVersion ? buildVersionCompareContext(baseVersion, savedVersion, workspace.versions) : null;
  return {
    message: `Saved as ${savedVersionLabel} based on ${baseVersion.label}`,
    revisionNote: savedCompareContext ? `Revision path ${savedCompareContext.pathLabel}` : `Revision path ${baseVersion.label} continues to ${savedVersionLabel}`,
    relationLabel: savedCompareContext?.relationLabel || '',
    pathLabel: savedCompareContext?.pathLabel || `${baseVersion.label} continues to ${savedVersionLabel}`,
    pathSegments: savedCompareContext?.pathSegments || [],
    sharedAncestor: savedCompareContext?.sharedAncestor || null,
    referenceVersion: baseVersion,
    focusVersion: savedVersion || baseVersion,
    savedVersion,
    savedVersionId,
    baseVersion,
    baseVersionId: baseVersion.id,
    compareActionLabel: versionCompareShortcutLabel('default', baseVersion, savedVersion || undefined, workspace.versions),
  };
}

function restoreOutcomeHint(targetVersion?: PaperVersion | null, workspace?: WorkspaceSnapshot | null): string {
  if (!targetVersion) {
    return '恢复会生成一个新的当前版本，不会删除现有历史。';
  }
  if (!workspace?.currentVersion || workspace.currentVersion.id === targetVersion.id) {
    return `会把 ${targetVersion.label} 重新生成成新的当前版本，现有历史仍会保留。`;
  }
  return `会基于 ${targetVersion.label} 生成新的当前版本，保留 ${workspace.currentVersion.label} 及其后续历史。`;
}

function restoreCheckpointSummary(targetVersion: PaperVersion, workspace?: WorkspaceSnapshot | null): string {
  if (!workspace?.currentVersion || workspace.currentVersion.id === targetVersion.id) {
    return `Checkpoint from ${targetVersion.label}`;
  }
  return `Rewind to ${targetVersion.label} from ${workspace.currentVersion.label}`;
}

function commandFailureDetail(command?: BridgeCommand | null): string | null {
  if (!command || command.status !== 'failed') {
    return null;
  }
  const diagnosis = command.result?.failureDiagnosis as
    | { detail?: string; summary?: string; suggestion?: string }
    | undefined;
  const detail = diagnosis?.detail?.trim();
  if (!detail) {
    return null;
  }
  const normalized = detail.replace(/\s+/g, ' ').trim();
  const duplicates = [command.message, diagnosis?.summary, diagnosis?.suggestion]
    .map((value) => value?.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (duplicates.includes(normalized)) {
    const derived = commandDerivedFailure(command);
    return derived?.detail || null;
  }
  return detail;
}

function compactLogMessage(message: string): string {
  return message.replace(/\r/g, '\n').trim();
}

function normalizedAssistantAnswer(message: string): string {
  return compactLogMessage(message).replace(/\s+/g, ' ').trim();
}

function bridgeCommandStdoutCandidates(command: BridgeCommand): string[] {
  return [...(command.logs || [])]
    .filter((entry) => entry.stream === 'stdout')
    .map((entry) => compactLogMessage(entry.message))
    .filter(Boolean);
}

function commandDraftingMode(command?: BridgeCommand | null): DraftingMode | undefined {
  if (!command || !('draftingMode' in command.payload)) {
    return undefined;
  }
  return command.payload.draftingMode;
}

function workspaceBootstrapHeadline(mode?: DraftingMode, status?: BridgeCommand['status']): string {
  if (mode === 'understand-project') {
    return status === 'done' ? '源库理解完成，正在进入起稿阶段' : '正在理解源库';
  }
  if (mode === 'initial-draft') {
    return '正在生成 v1 初稿';
  }
  return '正在准备稿库';
}

function workspaceBootstrapDescription(mode?: DraftingMode, status?: BridgeCommand['status']): string {
  if (mode === 'understand-project') {
    return status === 'failed'
      ? '源库理解阶段中断了，暂时还没有产出论文版本。'
      : '这个阶段只让 Agent 理解代码、实验、结果和素材，暂时不会生成论文，也无法进行正文操作。';
  }
  if (mode === 'initial-draft') {
    return '源库上下文已经准备好，TEXOR 正在基于理解结果生成第一版可编译主稿。首次保存完成后会自动显示为 v1。';
  }
  return '工作区还在初始化，论文视图会在准备完成后自动出现。';
}

function nativeCodexStarterLatex(projectRoot: string, targetJournal: string): string {
  const projectName = projectRoot.trim().split(/[\\/]/).filter(Boolean).pop() || 'Project';
  const safeTitle = projectName.replace(/[_%&#$]/g, ' ').trim() || 'Project';
  return [
    '\\documentclass[11pt]{article}',
    '',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage{lmodern}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{graphicx}',
    '\\usepackage{booktabs}',
    '\\usepackage{hyperref}',
    '',
    `\\title{${safeTitle}}`,
    '\\author{Anonymous Authors}',
    '\\date{}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '\\begin{abstract}',
    `Draft workspace for ${targetJournal}.`,
    '\\end{abstract}',
    '',
    '\\section{Introduction}',
    '',
    '\\bibliographystyle{plain}',
    '\\bibliography{references}',
    '',
    '\\end{document}',
    '',
  ].join('\n');
}

function nativeCodexBootstrapText(mode: 'new' | 'load', hasManuscript: boolean): { headline: string; instruction: string } {
  if (mode === 'new' && !hasManuscript) {
    return {
      headline: '原生 Codex 工作区已准备好',
      instruction: '请直接在 main.tex 中开始写作。你可以自由查看源库、修改稿件，并在需要时自行编译检查。',
    };
  }
  return {
    headline: '原生 Codex 对话已准备好',
    instruction: '请基于当前主稿直接继续工作。可以从选中的 PDF 区域开始，也可以自由检查源库后再修改。',
  };
}

function resolveTargetJournal(value?: string | null, fallback?: string | null): string {
  const journal = value?.trim();
  if (journal) {
    return journal;
  }
  const fallbackJournal = fallback?.trim();
  if (fallbackJournal) {
    return fallbackJournal;
  }
  return DEFAULT_TARGET_JOURNAL;
}

function shouldShowCodexLog(message: string): boolean {
  return message.trim().length > 0;
}

function observerClaudeToolMessage(toolName: string): string | null {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'read') {
    return '正在阅读论文与项目文件';
  }
  if (normalized === 'edit' || normalized === 'write' || normalized === 'multiedit') {
    return '正在把修改写回论文内容';
  }
  if (normalized === 'bash') {
    return '正在执行项目命令核对材料与结果';
  }
  if (normalized === 'grep' || normalized === 'glob' || normalized === 'ls') {
    return '正在定位相关论文与项目文件';
  }
  if (normalized === 'websearch') {
    return '正在补充参考文献与背景线索';
  }
  return '正在调用项目工具推进写作';
}

function observerCommandActivityMessage(commandText: string, phase: 'running' | 'done' | 'failed'): string {
  const command = commandText.split(/\n\n/)[0]?.trim().toLowerCase() || '';
  if (!command) {
    if (phase === 'done') {
      return '已完成一项项目处理';
    }
    if (phase === 'failed') {
      return '在处理项目文件时遇到问题';
    }
    return '正在处理相关项目文件';
  }

  if (/(latexmk|xelatex|pdflatex|lualatex|tectonic|bibtex)/.test(command)) {
    if (phase === 'done') {
      return '已完成一轮论文编译检查';
    }
    if (phase === 'failed') {
      return '在编译论文时遇到问题';
    }
    return '正在编译论文并检查版面结果';
  }

  if (/(plot|figure|diagram|chart|graph|render|draw|matplotlib|seaborn|ggplot)/.test(command)) {
    if (phase === 'done') {
      return '已完成图表素材更新';
    }
    if (phase === 'failed') {
      return '在更新图表素材时遇到问题';
    }
    return '正在生成或更新图表素材';
  }

  if (/(train|eval|test|benchmark|experiment|metric|result|infer)/.test(command)) {
    if (phase === 'done') {
      return '已完成一轮实验结果核对';
    }
    if (phase === 'failed') {
      return '在核对实验结果时遇到问题';
    }
    return '正在运行项目脚本核对实验结果';
  }

  if (/(rg|grep|find|fd|ls|cat|sed|awk|head|tail|wc)\b/.test(command)) {
    if (phase === 'done') {
      return '已完成一轮材料定位与阅读';
    }
    if (phase === 'failed') {
      return '在定位相关材料时遇到问题';
    }
    return '正在定位相关论文与项目文件';
  }

  if (/\b(bib|citation|reference|openalex|arxiv|dblp)\b/.test(command)) {
    if (phase === 'done') {
      return '已完成一轮参考文献核对';
    }
    if (phase === 'failed') {
      return '在核对参考文献时遇到问题';
    }
    return '正在补充参考文献与背景线索';
  }

  if (phase === 'done') {
    return '已完成一项项目处理';
  }
  if (phase === 'failed') {
    return '在处理项目文件时遇到问题';
  }
  return '正在处理相关项目文件';
}

function observerFileChangeMessage(target: string): string {
  const normalized = target.trim().toLowerCase();
  if (!normalized) {
    return '正在保存相关项目修改';
  }
  if (/(^|[\\/])\.texor([\\/]|$)|\.(tex|bib)\b/.test(normalized) || normalized.includes('manuscript')) {
    return '正在把修改写回论文正文';
  }
  if (/\.(png|jpg|jpeg|svg|pdf|eps|tikz)\b/.test(normalized) || normalized.includes('figure') || normalized.includes('figures')) {
    return '正在更新图表素材';
  }
  if (/\.(py|ipynb|jl|m|r)\b/.test(normalized)) {
    return '正在调整实验或绘图脚本';
  }
  return '正在保存相关项目修改';
}

function observerProcessMessage(message: string): string | null {
  const text = compactLogMessage(message);
  if (!text) {
    return null;
  }
  if (/^使用 .+ 的 .+。$/.test(text) || text.startsWith('启动 Claude Code CLI:')) {
    return null;
  }
  if (text === 'TEXOR Agent 正在处理') {
    return '正在推进当前写作任务';
  }
  if (text === 'Codex 会话已启动。' || text === 'Claude Code 进程已启动。' || text === 'Claude Code 会话已启动。') {
    return '已进入当前写作会话';
  }
  if (text === 'Codex 开始处理这一轮请求。') {
    return '正在理解本轮写作需求';
  }
  if (text === 'Codex 完成本轮处理。' || text === 'Claude Code 已生成结果。') {
    return '已完成本轮写作，正在整理结果';
  }
  if (text === 'Codex 正在分析上下文。') {
    return '正在梳理论文与项目上下文';
  }
  if (text === 'Claude Code 正在收尾。') {
    return '正在整理本轮修改结果';
  }
  if (text === 'Claude Code 正在重试 API。') {
    return '正在重新连接写作模型';
  }
  if (text.startsWith('已回到上次')) {
    return '已回到上次写作会话，继续推进当前任务';
  }
  if (text === '会话策略：继续当前窗口绑定的 Codex 对话。') {
    return '继续当前窗口里的 Codex 对话';
  }
  if (text === '会话策略：为当前窗口开启新的 Codex 对话。') {
    return '已为当前窗口开启新的 Codex 对话';
  }
  if (text === '采用快速处理模式。') {
    return '本轮任务会优先快速响应';
  }
  if (text === '采用深度处理模式。') {
    return '本轮任务会做更完整的一致性检查';
  }
  if (text === '原生回答模式：优先快速给出结论，不改主稿。') {
    return '回答模式已启用，本轮只做快速问答';
  }
  if (text === '原生回答模式：允许更完整地阅读项目与稿件上下文，但不会自动保存新版本。') {
    return '回答模式已启用，本轮会做更完整分析，但不会保存新版本';
  }
  if (text === '原生修改模式：优先完成局部安全改写。') {
    return '修改模式已启用，本轮优先完成局部安全改写';
  }
  if (text === '原生修改模式：允许更长链路的稿件与项目协同修改。') {
    return '修改模式已启用，本轮允许更长链路的稿件与项目协同修改';
  }
  if (text.startsWith('进入') && text.endsWith('模式。')) {
    return `${text.slice(0, -1)}，准备开始本轮处理`;
  }
  if (text.startsWith('运行命令:')) {
    return observerCommandActivityMessage(text.slice('运行命令:'.length).trim(), 'running');
  }
  if (text.startsWith('完成命令:')) {
    return observerCommandActivityMessage(text.slice('完成命令:'.length).trim(), 'done');
  }
  if (text.startsWith('命令失败:')) {
    return observerCommandActivityMessage(text.slice('命令失败:'.length).trim(), 'failed');
  }
  if (text.startsWith('修改文件:')) {
    return observerFileChangeMessage(text.slice('修改文件:'.length).trim());
  }
  if (text.startsWith('Claude 正在调用工具:')) {
    return observerClaudeToolMessage(text.slice('Claude 正在调用工具:'.length).trim());
  }
  return text;
}

function observerFailureMessage(message: string): string {
  const text = compactLogMessage(message);
  if (!text) {
    return '本轮处理遇到错误，请查看技术详情';
  }
  if (text.startsWith('命令失败:')) {
    return observerCommandActivityMessage(text.slice('命令失败:'.length).trim(), 'failed');
  }
  if (/timed out/i.test(text)) {
    return '本轮处理超时，请查看技术详情';
  }
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || text;
  return firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine;
}

function observerFallbackMessage(command?: BridgeCommand | null): string | null {
  if (!command) {
    return null;
  }
  if (command.status === 'queued') {
    return '任务已提交，正在等待写作会话启动';
  }
  if (command.status === 'running') {
    return '正在推进当前写作任务';
  }
  if (command.status === 'done') {
    return '本轮写作已完成';
  }
  return '本轮写作中断，请查看上方提示';
}

function observerProcessEntries(command?: BridgeCommand | null): ObserverProcessEntry[] {
  if (!command) {
    return [];
  }
  const entries: ObserverProcessEntry[] = [];
  let lastKey = '';
  for (const entry of command.logs || []) {
    if (entry.stream === 'stdout') {
      continue;
    }
    const message = entry.stream === 'stderr' ? observerFailureMessage(entry.message) : observerProcessMessage(entry.message);
    if (!message) {
      continue;
    }
    const key = `${entry.stream}:${message}`;
    if (key === lastKey) {
      continue;
    }
    lastKey = key;
    entries.push({
      id: entry.id,
      time: entry.time,
      message,
      tone: entry.stream === 'stderr' ? 'warning' : 'neutral',
    });
  }
  if (!entries.length) {
    const fallback = observerFallbackMessage(command);
    if (fallback) {
      entries.push({
        id: `${command.id}-fallback`,
        time: command.updatedAt,
        message: fallback,
        tone: command.status === 'failed' ? 'warning' : 'neutral',
      });
    }
  }
  return entries.slice(-6);
}

function codexTaskPayload(command: BridgeCommand): CodexTaskCommandPayload | null {
  return command.type === 'codex-task' ? (command.payload as CodexTaskCommandPayload) : null;
}

function bridgeCommandUserMessage(command: BridgeCommand): string {
  const payload = codexTaskPayload(command);
  if (!payload) {
    return command.message || '已提交任务';
  }
  if (payload.draftingMode === 'understand-project') {
    return '先理解源库与稿件上下文，暂时不要改动正文。';
  }
  if (payload.draftingMode === 'initial-draft') {
    return '基于源库上下文生成第一版可编译初稿。';
  }
  const chunks = payload.instruction
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (payload.source === 'annotation' && chunks.length > 1) {
    return chunks[chunks.length - 1];
  }
  return chunks[0] || payload.instruction.trim() || '继续推进当前写作任务。';
}

function bridgeCommandSourceLabel(command: BridgeCommand): string {
  const payload = codexTaskPayload(command);
  if (!payload) {
    return '系统任务';
  }
  if (payload.draftingMode === 'understand-project') {
    return '源库理解';
  }
  if (payload.draftingMode === 'initial-draft') {
    return '初稿生成';
  }
  return payload.source === 'annotation' ? 'PDF 选区' : '侧栏输入';
}

function bridgeCommandContextLabel(command: BridgeCommand): string {
  const payload = codexTaskPayload(command);
  if (!payload) {
    return '';
  }
  if (payload.sourceFile && payload.sourceLine) {
    return `${latexSourceFileName(payload.sourceFile)}:${payload.sourceLine}`;
  }
  if (payload.sourceFile) {
    return latexSourceFileName(payload.sourceFile);
  }
  return '';
}

function bridgeCommandCompareContext(
  command: BridgeCommand,
  workspace: WorkspaceSnapshot | null,
  fallbackFocusVersion?: PaperVersion,
): BridgeCommandCompareContext | null {
  const payload = codexTaskPayload(command);
  if (!payload || !workspace) {
    return null;
  }
  const baseVersionId = payload.baseVersionId || payload.versionId;
  if (!baseVersionId) {
    return null;
  }
  const baseVersion = workspace.versions.find((version) => version.id === baseVersionId);
  if (!baseVersion) {
    return null;
  }
  const payloadFocusVersion = payload.focusVersionId ? workspace.versions.find((version) => version.id === payload.focusVersionId) : null;
  const focusVersion = payloadFocusVersion || fallbackFocusVersion || null;
  const focusVersionSource = payloadFocusVersion ? 'payload' : fallbackFocusVersion ? 'fallback' : 'none';
  const compareContext = focusVersion ? buildVersionCompareContext(baseVersion, focusVersion, workspace.versions) : null;
  return {
    baseVersion,
    focusVersion,
    focusVersionSource,
    relationLabel: compareContext?.relationLabel || '',
    pathLabel: compareContext?.pathLabel || '',
    pathSegments: compareContext?.pathSegments || [],
    sharedAncestor: compareContext?.sharedAncestor || null,
    compareActionLabel: compareContext ? versionInsightCompareActionLabel(compareContext.referenceVersion, compareContext.focusVersion, workspace.versions) : '',
  };
}

function bridgeCommandSelectionPreview(command: BridgeCommand): string {
  const payload = codexTaskPayload(command);
  if (!payload) {
    return '';
  }
  const text = payload.selectedText?.replace(/\s+/g, ' ').trim() || '';
  if (!text) {
    return '';
  }
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function bridgeCommandAssistantAnswer(command: BridgeCommand): string {
  const explicit = typeof command.result?.answer === 'string' ? command.result.answer.trim() : '';
  if (explicit) {
    return explicit;
  }
  const payload = codexTaskPayload(command);
  if (payload?.agentBackend === 'codex-native') {
    return '';
  }
  const stdoutLogs = bridgeCommandStdoutCandidates(command);
  if (stdoutLogs.length) {
    const lastStdout = stdoutLogs[stdoutLogs.length - 1];
    if (normalizedAssistantAnswer(lastStdout) !== normalizedAssistantAnswer(commandMessage(command))) {
      return lastStdout;
    }
    return '';
  }
  return '';
}

function undoBaseVersionForCommand(command: BridgeCommand, workspace: WorkspaceSnapshot | null): PaperVersion | null {
  if (!workspace || command.type !== 'codex-task' || command.status !== 'done') {
    return null;
  }
  const payload = codexTaskPayload(command);
  const savedVersionId = typeof command.result?.versionId === 'string' ? command.result.versionId : undefined;
  if (!payload || !savedVersionId) {
    return null;
  }
  const baseVersionId = payload.baseVersionId || payload.versionId;
  if (!baseVersionId || baseVersionId === savedVersionId) {
    return null;
  }
  return workspace.versions.find((version) => version.id === baseVersionId) || null;
}

function defaultNativeTaskIntent(annotation: AnnotationTarget | null, request: string): CodexTaskIntent {
  if (annotation) {
    return 'edit';
  }
  const text = request.toLowerCase();
  const editSignals = [
    '修改',
    '改',
    '润色',
    '重写',
    '补充',
    '删掉',
    '插入',
    'rewrite',
    'edit',
    'revise',
    'polish',
    'update',
    'change',
  ];
  return editSignals.some((signal) => text.includes(signal)) ? 'auto' : 'chat';
}

function storedModelConfig(): { provider?: string; baseUrl?: string; model?: string; apiKey?: string; imageModel?: string } {
  return {
    provider: window.localStorage.getItem('texor.agentProvider') || 'OpenAI-compatible',
    baseUrl: window.localStorage.getItem('texor.agentBaseUrl') || 'https://api.openai.com/v1',
    model: window.localStorage.getItem('texor.agentModel') || DEFAULT_TEXOR_AGENT_MODEL,
    imageModel: window.localStorage.getItem('texor.agentImageModel') || 'gpt-image-1',
    apiKey: window.localStorage.getItem('texor.agentApiKey') || '',
  };
}

function storedCodexConfig(): { model?: string; reasoningEffort?: string } {
  return {
    model: window.localStorage.getItem('texor.codexModel') || DEFAULT_CODEX_MODEL,
    reasoningEffort: window.localStorage.getItem('texor.codexReasoningEffort') || DEFAULT_CODEX_REASONING_EFFORT,
  };
}

function storedClaudeConfig(): { model?: string } {
  return {
    model: window.localStorage.getItem('texor.claudeModel') || '',
  };
}

const LAST_WORKSPACE_PAPER_ID_KEY = 'texor.lastWorkspacePaperId';
const LAST_WORKSPACE_PROJECT_ROOT_KEY = 'texor.lastWorkspaceProjectRoot';

function readLastWorkspacePreference(): { paperId?: string; projectRoot?: string } {
  if (typeof window === 'undefined') {
    return {};
  }
  const paperId = window.localStorage.getItem(LAST_WORKSPACE_PAPER_ID_KEY)?.trim() || '';
  const projectRoot = window.localStorage.getItem(LAST_WORKSPACE_PROJECT_ROOT_KEY)?.trim() || '';
  return {
    paperId: paperId || undefined,
    projectRoot: projectRoot || undefined,
  };
}

function persistLastWorkspacePreference(snapshot: WorkspaceSnapshot): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(LAST_WORKSPACE_PAPER_ID_KEY, snapshot.paper.id);
  const projectRoot = snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath || '';
  if (projectRoot) {
    window.localStorage.setItem(LAST_WORKSPACE_PROJECT_ROOT_KEY, projectRoot);
    return;
  }
  window.localStorage.removeItem(LAST_WORKSPACE_PROJECT_ROOT_KEY);
}

function clearLastWorkspacePreference(paperId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  if (!paperId || window.localStorage.getItem(LAST_WORKSPACE_PAPER_ID_KEY) === paperId) {
    window.localStorage.removeItem(LAST_WORKSPACE_PAPER_ID_KEY);
    window.localStorage.removeItem(LAST_WORKSPACE_PROJECT_ROOT_KEY);
  }
}

function requestedWindowSessionKeyFromUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get('windowSessionKey')?.trim() || '';
}

function ensureWindowSessionKey(): string {
  const desktopProvided = window.texorDesktop?.windowSessionKey?.trim();
  if (desktopProvided) {
    window.sessionStorage.setItem('texor.windowSessionKey', desktopProvided);
    return desktopProvided;
  }
  const requested = requestedWindowSessionKeyFromUrl();
  if (requested) {
    window.sessionStorage.setItem('texor.windowSessionKey', requested);
    return requested;
  }
  const stored = typeof window !== 'undefined' ? window.sessionStorage.getItem('texor.windowSessionKey')?.trim() || '' : '';
  if (stored) {
    return stored;
  }
  const generated = crypto.randomUUID();
  if (typeof window !== 'undefined') {
    window.sessionStorage.setItem('texor.windowSessionKey', generated);
  }
  return generated;
}

function normalizedTexorAgentConfig(modelConfig?: ModelConfig): ModelConfig {
  return {
    provider: modelConfig?.provider?.trim() || 'OpenAI-compatible',
    baseUrl: modelConfig?.baseUrl?.trim() || 'https://api.openai.com/v1',
    model: modelConfig?.model?.trim() || DEFAULT_TEXOR_AGENT_MODEL,
    imageModel: modelConfig?.imageModel?.trim() || 'gpt-image-1',
    apiKey: modelConfig?.apiKey?.trim() || '',
  };
}

function normalizedCodexConfig(config?: WorkspaceRuntimeConfig['codex']): { model: string; reasoningEffort: string } {
  return {
    model: config?.model?.trim() || DEFAULT_CODEX_MODEL,
    reasoningEffort: config?.reasoningEffort?.trim() || DEFAULT_CODEX_REASONING_EFFORT,
  };
}

function normalizedClaudeConfig(config?: WorkspaceRuntimeConfig['claude']): { model: string } {
  return {
    model: config?.model?.trim() || '',
  };
}

function isCodexBackend(backend?: AgentBackend): boolean {
  return backend === 'codex-cli' || backend === 'codex-native';
}

function isStructuredCodexBackend(backend?: AgentBackend): boolean {
  return backend === 'codex-cli';
}

function buildWorkspaceRuntimeConfigFromState(input: {
  agentBackend: AgentBackend;
  projectTaskSpeedMode: TaskSpeedMode;
  agentProvider: string;
  agentBaseUrl: string;
  agentModel: string;
  agentImageModel: string;
  agentApiKey: string;
  codexModel: string;
  codexReasoningEffort: string;
  claudeModel: string;
}): WorkspaceRuntimeConfig {
  return {
    agentBackend: input.agentBackend,
    taskSpeedMode: input.projectTaskSpeedMode,
    texorAgent: {
      provider: input.agentProvider.trim() || 'OpenAI-compatible',
      baseUrl: input.agentBaseUrl.trim() || 'https://api.openai.com/v1',
      model: input.agentModel.trim() || DEFAULT_TEXOR_AGENT_MODEL,
      imageModel: input.agentImageModel.trim() || 'gpt-image-1',
      apiKey: input.agentApiKey.trim(),
    },
    codex: {
      model: input.codexModel.trim() || DEFAULT_CODEX_MODEL,
      reasoningEffort: input.codexReasoningEffort.trim() || DEFAULT_CODEX_REASONING_EFFORT,
    },
    claude: {
      model: input.claudeModel.trim(),
    },
  };
}

function workspaceRuntimeConfigFromCommand(command: BridgeCommand | null): WorkspaceRuntimeConfig | null {
  if (!command || command.type !== 'codex-task') {
    return null;
  }
  const payload = command.payload;
  const backend = commandBackend(command);
  if (!backend) {
    return null;
  }
  const modelConfig = 'modelConfig' in payload ? payload.modelConfig : undefined;
  return {
    agentBackend: backend,
    taskSpeedMode: 'taskSpeedMode' in payload ? payload.taskSpeedMode : undefined,
    texorAgent: backend === 'texor-agent'
      ? {
          provider: modelConfig?.provider,
          baseUrl: modelConfig?.baseUrl,
          model: modelConfig?.model,
          imageModel: modelConfig?.imageModel,
          apiKey: modelConfig?.apiKey,
        }
      : undefined,
    codex: isCodexBackend(backend)
      ? {
          model: modelConfig?.model,
          reasoningEffort: modelConfig?.reasoningEffort,
        }
      : undefined,
    claude: backend === 'claude-code'
      ? {
          model: modelConfig?.model,
        }
      : undefined,
  };
}

function reasoningEffortLabel(value?: string): string {
  switch ((value || '').trim()) {
    case 'minimal':
      return '极低';
    case 'low':
      return '低';
    case 'medium':
      return '中';
    case 'high':
      return '高';
    case 'xhigh':
      return '超高';
    default:
      return '超高';
  }
}

function compactModelLabel(model?: string): string {
  const text = (model || '').trim();
  if (!text) {
    return '模型';
  }
  return text.replace(/^gpt-/i, '').replace(/^claude-/i, '').replace(/-20\d{6,}$/i, '').trim() || text;
}

function backendDisplayLabel(backend?: AgentBackend): string {
  if (backend === 'texor-agent') {
    return '自定义 API';
  }
  if (backend === 'claude-code') {
    return 'Claude';
  }
  if (backend === 'codex-native') {
    return '原生 Codex';
  }
  return 'Codex';
}

function displayCodexModelToken(model?: string): string {
  const text = compactModelLabel(model);
  return text.replace(/^gpt-/i, '').trim() || '5.4';
}

function taskSpeedModeLabel(mode: TaskSpeedMode): string {
  return mode === 'quick' ? '快速' : '深度';
}

function taskSpeedModeHint(mode: TaskSpeedMode): string {
  return mode === 'quick' ? '局部改写，不跑脚本' : '允许源库检查与长时任务';
}

function normalizeCodexModelInput(value: string): string {
  const text = value.trim();
  if (!text) {
    return '';
  }
  if (/^gpt-/i.test(text)) {
    return text;
  }
  if (/^\d/.test(text)) {
    return `gpt-${text}`;
  }
  return text;
}

function normalizedRuntimeConfigForComparison(config?: WorkspaceRuntimeConfig | null) {
  const backend = config?.agentBackend || 'texor-agent';
  return {
    agentBackend: backend,
    taskSpeedMode: config?.taskSpeedMode || 'deep',
    texorAgent: normalizedTexorAgentConfig(config?.texorAgent),
    codex: normalizedCodexConfig(config?.codex),
    claude: normalizedClaudeConfig(config?.claude),
  };
}

function runtimeConfigEquals(left?: WorkspaceRuntimeConfig | null, right?: WorkspaceRuntimeConfig | null): boolean {
  return JSON.stringify(normalizedRuntimeConfigForComparison(left)) === JSON.stringify(normalizedRuntimeConfigForComparison(right));
}

function commandTimeLabel(time: string): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function dateLabel(time: string): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
}

function versionBranchLabel(version: PaperVersion, versions: PaperVersion[]): string {
  if (!version.basedOnVersionId) {
    return '';
  }
  const baseVersion = versions.find((entry) => entry.id === version.basedOnVersionId);
  if (!baseVersion) {
    return '';
  }
  return `Based on ${baseVersion.label}`;
}

function versionLatestStatusLabel(
  version: PaperVersion | undefined,
  currentVersion: PaperVersion | undefined,
  pendingVersionId?: string,
): string {
  if (!version || !currentVersion) {
    return '';
  }
  if (pendingVersionId && version.id === pendingVersionId) {
    return 'Latest in other window';
  }
  if (version.id === currentVersion.id) {
    return 'Latest current version';
  }
  return 'Historical branch view';
}

function versionLineageTrail(version: PaperVersion | undefined, versions: PaperVersion[]): PaperVersion[] {
  if (!version) {
    return [];
  }
  const trail: PaperVersion[] = [];
  const seen = new Set<string>();
  let current: PaperVersion | undefined = version;
  while (current && !seen.has(current.id)) {
    const active: PaperVersion = current;
    trail.push(active);
    seen.add(active.id);
    current = active.basedOnVersionId ? versions.find((entry) => entry.id === active.basedOnVersionId) : undefined;
  }
  return trail.reverse();
}

function versionLineageLabels(version: PaperVersion | undefined, versions: PaperVersion[], maxLabels = 5): string[] {
  const labels = versionLineageTrail(version, versions).map((entry) => entry.label);
  if (labels.length <= maxLabels) {
    return labels;
  }
  return [labels[0], '...', ...labels.slice(-(maxLabels - 2))];
}

function versionLineageSummaryLabel(version: PaperVersion | undefined, versions: PaperVersion[], maxLabels = 4): string {
  const labels = versionLineageLabels(version, versions, maxLabels);
  return labels.length ? `Lineage ${labels.join(' / ')}` : '';
}

function versionLineageBreadcrumb(version: PaperVersion | undefined, versions: PaperVersion[], maxLabels = 5): Array<{ id: string; label: string }> {
  const trail = versionLineageTrail(version, versions).map((entry) => ({ id: entry.id, label: entry.label }));
  if (trail.length <= maxLabels) {
    return trail;
  }
  return [trail[0], { id: '__ellipsis__', label: '...' }, ...trail.slice(-(maxLabels - 2))];
}

function versionSharedAncestor(
  reference: PaperVersion | undefined,
  focus: PaperVersion | undefined,
  versions: PaperVersion[],
): PaperVersion | null {
  const referenceTrail = versionLineageTrail(reference, versions);
  const focusTrail = versionLineageTrail(focus, versions);
  const length = Math.min(referenceTrail.length, focusTrail.length);
  let shared: PaperVersion | null = null;
  for (let index = 0; index < length; index += 1) {
    if (referenceTrail[index].id !== focusTrail[index].id) {
      break;
    }
    shared = referenceTrail[index];
  }
  return shared;
}

function versionCompareRelationshipLabel(
  reference: PaperVersion | undefined,
  focus: PaperVersion | undefined,
  versions: PaperVersion[],
): string {
  if (!reference || !focus || reference.id === focus.id) {
    return '';
  }
  if (focus.basedOnVersionId === reference.id) {
    return `Directly continues from ${reference.label}`;
  }
  if (reference.basedOnVersionId === focus.id) {
    return `Direct base for ${reference.label}`;
  }
  const shared = versionSharedAncestor(reference, focus, versions);
  if (!shared) {
    return 'Separate saved roots';
  }
  if (shared.id === reference.id) {
    return `Descends from ${reference.label}`;
  }
  if (shared.id === focus.id) {
    return `Ancestor of ${reference.label}`;
  }
  return `Branch split at ${shared.label}`;
}

function versionComparePathLabel(
  reference: PaperVersion | undefined,
  focus: PaperVersion | undefined,
  versions: PaperVersion[],
): string {
  if (!reference || !focus) {
    return '';
  }
  if (reference.id === focus.id) {
    return `${reference.label} -> same revision`;
  }
  const shared = versionSharedAncestor(reference, focus, versions);
  if (!shared) {
    return `${reference.label} -> separate root -> ${focus.label}`;
  }
  if (focus.basedOnVersionId === reference.id) {
    return `${reference.label} -> ${focus.label}`;
  }
  if (reference.basedOnVersionId === focus.id) {
    return `${reference.label} based on ${focus.label}`;
  }
  if (shared.id === reference.id) {
    return `${reference.label} -> ${focus.label}`;
  }
  if (shared.id === focus.id) {
    return `${reference.label} descends from ${focus.label}`;
  }
  return `${reference.label} -> ${shared.label} -> ${focus.label}`;
}

function versionComparePathSegments(
  reference: PaperVersion | undefined,
  focus: PaperVersion | undefined,
  versions: PaperVersion[],
): VersionPathSegment[] {
  if (!reference || !focus) {
    return [];
  }
  if (reference.id === focus.id) {
    return [
      { type: 'version', label: reference.label, versionId: reference.id },
      { type: 'separator', label: 'same revision' },
    ];
  }
  const shared = versionSharedAncestor(reference, focus, versions);
  if (!shared) {
    return [
      { type: 'version', label: reference.label, versionId: reference.id },
      { type: 'separator', label: 'separate root' },
      { type: 'version', label: focus.label, versionId: focus.id },
    ];
  }
  if (focus.basedOnVersionId === reference.id) {
    return [
      { type: 'version', label: reference.label, versionId: reference.id },
      { type: 'separator', label: 'continues to' },
      { type: 'version', label: focus.label, versionId: focus.id },
    ];
  }
  if (reference.basedOnVersionId === focus.id) {
    return [
      { type: 'version', label: reference.label, versionId: reference.id },
      { type: 'separator', label: 'based on' },
      { type: 'version', label: focus.label, versionId: focus.id },
    ];
  }
  if (shared.id === reference.id) {
    return [
      { type: 'version', label: reference.label, versionId: reference.id },
      { type: 'separator', label: 'continues to' },
      { type: 'version', label: focus.label, versionId: focus.id },
    ];
  }
  if (shared.id === focus.id) {
    return [
      { type: 'version', label: reference.label, versionId: reference.id },
      { type: 'separator', label: 'descends from' },
      { type: 'version', label: focus.label, versionId: focus.id },
    ];
  }
  return [
    { type: 'version', label: reference.label, versionId: reference.id },
    { type: 'separator', label: 'split at' },
    { type: 'version', label: shared.label, versionId: shared.id },
    { type: 'separator', label: 'to' },
    { type: 'version', label: focus.label, versionId: focus.id },
  ];
}

function versionComparePathNote(
  reference: PaperVersion | undefined,
  focus: PaperVersion | undefined,
  versions: PaperVersion[],
): string {
  return versionComparePathSegments(reference, focus, versions).map((item) => item.label).join(' ');
}

function buildVersionCompareContext(
  reference: PaperVersion | undefined,
  focus: PaperVersion | undefined,
  versions: PaperVersion[],
): VersionCompareContext | null {
  if (!reference || !focus) {
    return null;
  }
  return {
    referenceVersion: reference,
    focusVersion: focus,
    relationLabel: versionCompareRelationshipLabel(reference, focus, versions),
    pathLabel: versionComparePathNote(reference, focus, versions),
    pathSegments: versionComparePathSegments(reference, focus, versions),
    sharedAncestor: versionSharedAncestor(reference, focus, versions),
  };
}

function activeCompareContext(
  leftVersion: PaperVersion | undefined,
  rightVersion: PaperVersion | undefined,
  versions: PaperVersion[],
): ActiveCompareContext | null {
  const context = buildVersionCompareContext(leftVersion, rightVersion, versions);
  if (!context || !leftVersion || !rightVersion) {
    return null;
  }
  return {
    ...context,
    leftVersion,
    rightVersion,
    reverseRelationLabel: versionCompareRelationshipLabel(rightVersion, leftVersion, versions),
    compareActionLabel: versionInsightCompareActionLabel(leftVersion, rightVersion, versions),
  };
}

function historyNavigationVersionContext(
  version: PaperVersion,
  navigationState: HistoryNavigationState | null,
  versions: PaperVersion[],
  compareContext?: ActiveCompareContext | null,
): HistoryNavigationVersionContext | null {
  if (!navigationState || !navigationState.highlightedVersionIds.includes(version.id)) {
    return null;
  }
  const target = versions.find((entry) => entry.id === navigationState.targetVersionId);
  if (!target) {
    return null;
  }
  if (version.id === navigationState.targetVersionId) {
    const compareHint = compareContext
      ? target.id === compareContext.rightVersion.id
        ? `当前 compare 正在把 ${compareContext.leftVersion.label} 放在左侧，对比这个 focus。`
        : `当前 compare 正在看 ${compareContext.leftVersion.label} 对 ${compareContext.rightVersion.label}。`
      : '';
    return {
      roleLabel: 'Focus',
      roleHint: ['这是你刚刚跳转进来的目标版本。', compareHint].filter(Boolean).join(' '),
      relationLabel: '',
      routeLabel: '',
      routeSegments: [],
      actionLabel: '',
      compareReferenceVersion: null,
      compareFocusVersion: target,
    };
  }
  const highlightedVersions = navigationState.highlightedVersionIds
    .map((id) => versions.find((entry) => entry.id === id))
    .filter((entry): entry is PaperVersion => Boolean(entry));
  if (!highlightedVersions.length) {
    return null;
  }
  const originVersion = highlightedVersions[0];
  const shared = versionSharedAncestor(version, target, versions);
  const compareHint = compareContext
    ? target.id === compareContext.rightVersion.id
      ? `当前 compare 右侧已经在看这个 focus，左侧是 ${compareContext.leftVersion.label}。`
      : `当前 compare 正在看 ${compareContext.leftVersion.label} 对 ${compareContext.rightVersion.label}。`
    : '';
  const comparePair =
    version.id === target.id
      ? null
      : buildVersionCompareContext(version, target, versions);
  if (originVersion.id === version.id) {
    return {
      roleLabel: 'Origin',
      roleHint: [`这条高亮路径从这里开始，可直接对比它与 ${target.label}。`, compareHint].filter(Boolean).join(' '),
      relationLabel: comparePair?.relationLabel || '',
      routeLabel: comparePair?.pathLabel || '',
      routeSegments: comparePair?.pathSegments || [],
      actionLabel: comparePair ? versionCompareShortcutLabel('default', version, target, versions) : '',
      compareReferenceVersion: version,
      compareFocusVersion: target,
    };
  }
  if (shared?.id === version.id && version.id !== target.id && version.id !== originVersion.id) {
    return {
      roleLabel: 'Split point',
      roleHint: [`这是通往 ${target.label} 的共同分叉点，可直接对比分叉点与目标版本。`, compareHint].filter(Boolean).join(' '),
      relationLabel: comparePair?.relationLabel || '',
      routeLabel: comparePair?.pathLabel || '',
      routeSegments: comparePair?.pathSegments || [],
      actionLabel: comparePair ? versionCompareShortcutLabel('split', version, target, versions) : '',
      compareReferenceVersion: version,
      compareFocusVersion: target,
    };
  }
  return {
    roleLabel: 'Lineage',
    roleHint: ['这是从起点通往目标版本的中间 lineage 节点。', compareHint].filter(Boolean).join(' '),
    relationLabel: comparePair?.relationLabel || '',
    routeLabel: comparePair?.pathLabel || '',
    routeSegments: comparePair?.pathSegments || [],
    actionLabel: comparePair ? versionCompareShortcutLabel('default', version, target, versions) : '',
    compareReferenceVersion: version,
    compareFocusVersion: target,
  };
}

function historyCompareTargetVersion(
  workspace: WorkspaceSnapshot | null,
  rightVersion: PaperVersion | undefined,
  candidateVersion: PaperVersion | undefined,
): PaperVersion | null {
  if (!workspace) {
    return null;
  }
  if (rightVersion && rightVersion.id !== candidateVersion?.id) {
    return rightVersion;
  }
  return workspace.currentVersion || null;
}

function historyTimelineCompareContext(
  version: PaperVersion | undefined,
  workspace: WorkspaceSnapshot | null,
  rightVersion: PaperVersion | undefined,
): HistoryTimelineCompareContext | null {
  if (!workspace || !version) {
    return null;
  }
  const compareTarget = historyCompareTargetVersion(workspace, rightVersion, version);
  if (!compareTarget || compareTarget.id === version.id) {
    return null;
  }
  const compareContext = buildVersionCompareContext(version, compareTarget, workspace.versions);
  if (!compareContext) {
    return null;
  }
  return {
    ...compareContext,
    compareTarget,
    compareActionLabel: versionCompareShortcutLabel('default', version, compareTarget, workspace.versions),
  };
}

function diffOpacity(value: string): number {
  return Math.min(0.82, 0.2 + value.trim().length / 110);
}

function renderLatexSourceDiff(previous: string, current: string, side: 'previous' | 'current') {
  return diffWordsWithSpace(previous, current)
    .filter((part) => {
      if (side === 'current' && part.removed) {
        return false;
      }
      if (side === 'previous' && part.added) {
        return false;
      }
      return true;
    })
    .map((part, index) => {
      const changed = side === 'current' ? part.added : part.removed;
      const color =
        side === 'current'
          ? `rgba(22, 163, 74, ${diffOpacity(part.value)})`
          : `rgba(239, 68, 68, ${diffOpacity(part.value)})`;
      return (
        <span className={changed ? 'source-diff-token is-changed' : undefined} key={`${side}-${index}`} style={{ backgroundColor: changed ? color : undefined }}>
          {part.value}
        </span>
      );
    });
}

function firstLatexError(log?: string): string {
  if (!log) {
    return '';
  }
  const match =
    log.match(/! (?:LaTeX Error|Package .*? Error|Undefined control sequence|Emergency stop)[\s\S]{0,420}/) ||
    log.match(/! [^\n]+(?:\n[^\n]+){0,4}/);
  return match ? match[0].replace(/\s+/g, ' ').trim() : '';
}

function diffCompileFailureMessage(result: DiffCompileResult): string {
  const currentError = !result.current.ok ? firstLatexError(result.current.log) : '';
  const previousError = result.previous && !result.previous.ok ? firstLatexError(result.previous.log) : '';
  const detail = currentError || previousError;
  return detail ? `PDF 编译失败，已显示源码差异：${detail}` : 'PDF 编译失败，已显示源码差异。';
}

function SourceDiffFallback({
  version,
  reference,
  side,
  message,
}: {
  version: WorkspaceSnapshot['currentVersion'];
  reference: WorkspaceSnapshot['currentVersion'];
  side: 'previous' | 'current';
  message: string;
}) {
  return (
    <div className={`source-diff-fallback is-${side}`}>
      <div className="source-diff-fallback__notice">
        <CircleAlert size={15} />
        <span>{message}</span>
      </div>
      <pre>
        <code>{renderLatexSourceDiff(side === 'current' ? reference.latex : version.latex, side === 'current' ? version.latex : reference.latex, side)}</code>
      </pre>
    </div>
  );
}

function normalizeLatexSourcePath(sourcePath?: string): string {
  return (sourcePath || '').replace(/\\/g, '/');
}

function latexSourceFileName(sourcePath?: string): string {
  const normalized = normalizeLatexSourcePath(sourcePath);
  if (!normalized) {
    return 'main.tex';
  }
  return normalized.split('/').filter(Boolean).pop() || 'main.tex';
}

function latexSourceDisplayPath(sourcePath?: string): string {
  const normalized = normalizeLatexSourcePath(sourcePath);
  if (!normalized) {
    return '.texor/manuscript/main.tex';
  }
  const marker = normalized.lastIndexOf('/.texor/');
  if (marker >= 0) {
    return normalized.slice(marker + 1);
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 4) {
    return normalized;
  }
  return `.../${parts.slice(-4).join('/')}`;
}

function basenameFromPath(filePath?: string): string {
  if (!filePath) {
    return '';
  }
  return filePath.split(/[\\/]/).filter(Boolean).pop() || '';
}

function sanitizeDownloadName(value: string, fallback: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
}

interface LatexOutlineItem {
  id: string;
  title: string;
  line: number;
  depth: number;
}

interface LatexCtrlClickTarget {
  line: number;
  column: number;
  selectedText?: string;
}

const LATEX_MIN_ZOOM_PERCENT = 55;
const LATEX_MAX_ZOOM_PERCENT = 220;
const LATEX_DEFAULT_ZOOM_PERCENT = 100;
const LATEX_ZOOM_PANEL_ACTIVE_MS = 900;

function clampLatexZoomPercent(value: number): number {
  return Math.max(LATEX_MIN_ZOOM_PERCENT, Math.min(LATEX_MAX_ZOOM_PERCENT, Math.round(value)));
}

function extractLatexClickText(line: string, column: number): string | undefined {
  const tokens = Array.from(line.matchAll(/[A-Za-z0-9\u00C0-\u024F\u0370-\u1FFF\u2C00-\uD7FF\u4E00-\u9FFF%+./:-]+/gu))
    .map((match) => {
      const value = match[0];
      const start = match.index || 0;
      return {
        value,
        start,
        end: start + value.length,
        isCommand: start > 0 && line[start - 1] === '\\',
      };
    })
    .filter((token) => token.value.trim().length > 0);
  if (!tokens.length) {
    return undefined;
  }

  const targetIndex = Math.max(0, Math.min(Math.max(0, line.length - 1), column - 1));
  const best = tokens
    .map((token) => {
      const distance =
        targetIndex >= token.start && targetIndex < token.end
          ? 0
          : Math.min(Math.abs(targetIndex - token.start), Math.abs(targetIndex - (token.end - 1)));
      const commandPenalty = token.isCommand ? 7 : 0;
      const shortPenalty = token.value.length <= 2 ? 3 : 0;
      const lengthBonus = Math.min(14, token.value.length) * 0.08;
      return {
        token,
        score: distance * 10 + commandPenalty + shortPenalty - lengthBonus,
      };
    })
    .sort((left, right) => left.score - right.score)[0]?.token;

  return best?.value || undefined;
}

function latexOutlineItems(latex: string, manuscriptState?: PaperVersion['manuscriptState']): LatexOutlineItem[] {
  const fromState = manuscriptState?.sectionMap
    ?.filter((region) => ['abstract', 'section', 'subsection', 'subsubsection', 'bibliography'].includes(region.kind))
    .map((region, index) => ({
      id: `outline-${region.kind}-${region.lineStart}-${index}`,
      title: region.title || (region.kind === 'abstract' ? 'Abstract' : region.kind === 'bibliography' ? 'Bibliography' : 'Untitled section'),
      line: Math.max(1, region.lineStart || 1),
      depth:
        region.kind === 'subsection'
          ? 1
          : region.kind === 'subsubsection'
            ? 2
            : 0,
    }));
  if (fromState && fromState.length) {
    return fromState;
  }

  const lines = latex.split('\n');
  const items: LatexOutlineItem[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const match = trimmed.match(/^\\(section|subsection|subsubsection)\*?\{(.+?)\}/);
    if (match) {
      items.push({
        id: `outline-${match[1]}-${index + 1}`,
        title: match[2].trim(),
        line: index + 1,
        depth: match[1] === 'section' ? 0 : match[1] === 'subsection' ? 1 : 2,
      });
      return;
    }
    if (/^\\begin\{abstract\}/.test(trimmed)) {
      items.push({
        id: `outline-abstract-${index + 1}`,
        title: 'Abstract',
        line: index + 1,
        depth: 0,
      });
    }
    if (/^\\bibliography\{/.test(trimmed)) {
      items.push({
        id: `outline-bibliography-${index + 1}`,
        title: 'Bibliography',
        line: index + 1,
        depth: 0,
      });
    }
  });
  return items;
}

function LatexSourceViewer({
  latex,
  heading,
  versionLabel,
  projectTitle,
  manuscriptState,
  onCtrlClickLine,
}: {
  latex: string;
  heading: string;
  versionLabel?: string;
  projectTitle?: string;
  manuscriptState?: PaperVersion['manuscriptState'];
  onCtrlClickLine?: (target: LatexCtrlClickTarget) => void;
}) {
  const lines = latex.split('\n');
  const nonEmptyLineCount = lines.filter((line) => line.trim().length > 0).length;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomPanelTimerRef = useRef<number | null>(null);
  const outlineItems = useMemo(() => latexOutlineItems(latex, manuscriptState), [latex, manuscriptState]);
  const [activeOutlineId, setActiveOutlineId] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.localStorage.getItem('texor.latexSidebarCollapsed') === 'true';
  });
  const [latexZoomPercent, setLatexZoomPercent] = useState(() => {
    if (typeof window === 'undefined') {
      return LATEX_DEFAULT_ZOOM_PERCENT;
    }
    const stored = Number(window.localStorage.getItem('texor.latexZoomPercent') || '');
    return Number.isFinite(stored) ? clampLatexZoomPercent(stored) : LATEX_DEFAULT_ZOOM_PERCENT;
  });
  const [zoomPanelActive, setZoomPanelActive] = useState(false);
  const activeOutline = outlineItems.find((item) => item.id === activeOutlineId) || outlineItems[0] || null;
  const editorScaleStyle = useMemo(
    () =>
      ({
        '--latex-editor-font-size': `${0.8 * (latexZoomPercent / 100)}rem`,
        '--latex-editor-gutter-font-size': `${0.72 * (latexZoomPercent / 100)}rem`,
      }) as CSSProperties,
    [latexZoomPercent],
  );

  useEffect(() => {
    setActiveOutlineId((current) => (outlineItems.some((item) => item.id === current) ? current : outlineItems[0]?.id || ''));
  }, [outlineItems]);

  useEffect(() => {
    window.localStorage.setItem('texor.latexZoomPercent', String(latexZoomPercent));
  }, [latexZoomPercent]);

  useEffect(() => {
    window.localStorage.setItem('texor.latexSidebarCollapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    const rootElement = rootRef.current;
    if (!rootElement) {
      return undefined;
    }
    const activeRoot = rootElement;

    function flashZoomPanel() {
      setZoomPanelActive(true);
      if (zoomPanelTimerRef.current !== null) {
        window.clearTimeout(zoomPanelTimerRef.current);
      }
      zoomPanelTimerRef.current = window.setTimeout(() => {
        setZoomPanelActive(false);
        zoomPanelTimerRef.current = null;
      }, LATEX_ZOOM_PANEL_ACTIVE_MS);
    }

    function handleWheel(event: WheelEvent) {
      const target = event.target;
      if (!event.ctrlKey || !(target instanceof Node) || !activeRoot.contains(target)) {
        return;
      }
      if (target instanceof HTMLElement && target.closest('input[type="range"], button')) {
        return;
      }
      event.preventDefault();
      const delta = event.deltaY > 0 ? -8 : 8;
      setLatexZoomPercent((current) => clampLatexZoomPercent(current + delta));
      flashZoomPanel();
    }

    activeRoot.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      activeRoot.removeEventListener('wheel', handleWheel);
      if (zoomPanelTimerRef.current !== null) {
        window.clearTimeout(zoomPanelTimerRef.current);
        zoomPanelTimerRef.current = null;
      }
    };
  }, []);

  function jumpToOutline(item: LatexOutlineItem) {
    setActiveOutlineId(item.id);
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-line="${item.line}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function renderLatexLine(line: string, lineIndex: number) {
    if (!line) {
      return <span className="latex-editor__line-empty">{'\u00A0'}</span>;
    }

    const tokens = line.split(/(\\[A-Za-z@]+(?:\*+)?|%.*|\{|\}|\[[^[\]]*\])/g).filter(Boolean);
    return tokens.map((token, tokenIndex) => {
      let className = 'latex-editor__text';
      if (token.startsWith('%')) {
        className = 'latex-editor__comment';
      } else if (token.startsWith('\\')) {
        className = 'latex-editor__command';
      } else if (token === '{' || token === '}') {
        className = 'latex-editor__brace';
      } else if (token.startsWith('[') && token.endsWith(']')) {
        className = 'latex-editor__option';
      }
      return (
        <span className={className} key={`${lineIndex}-${tokenIndex}`}>
          {token}
        </span>
      );
    });
  }

  function handleCodeClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!event.ctrlKey || !onCtrlClickLine) {
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-line]');
    if (!row) {
      return;
    }
    const line = Number(row.dataset.line || '0');
    if (!Number.isFinite(line) || line <= 0) {
      return;
    }
    const content = row.querySelector<HTMLElement>('.latex-editor__line-content');
    const sourceLine = lines[line - 1] || '';
    let column = 1;
    if (content && sourceLine.length > 0) {
      const text = sourceLine.replace(/\t/g, '  ');
      const probe = document.createElement('span');
      const computed = window.getComputedStyle(content);
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'pre';
      probe.style.pointerEvents = 'none';
      probe.style.fontFamily = computed.fontFamily;
      probe.style.fontSize = computed.fontSize;
      probe.style.fontWeight = computed.fontWeight;
      probe.style.letterSpacing = computed.letterSpacing;
      probe.style.lineHeight = computed.lineHeight;
      probe.style.fontStyle = computed.fontStyle;
      document.body.appendChild(probe);
      const offsetX = event.clientX - content.getBoundingClientRect().left;
      let bestColumn = 1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index <= text.length; index += 1) {
        probe.textContent = text.slice(0, index);
        const width = probe.getBoundingClientRect().width;
        const distance = Math.abs(width - offsetX);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestColumn = index + 1;
        }
      }
      document.body.removeChild(probe);
      column = Math.max(1, Math.min(sourceLine.length + 1, bestColumn));
    }
    event.preventDefault();
    onCtrlClickLine({
      line,
      column,
      selectedText: extractLatexClickText(sourceLine, column),
    });
  }

  return (
    <div ref={rootRef} className="latex-editor-view" style={editorScaleStyle}>
      <div className="latex-editor-view__chrome">
        <div className="latex-editor-view__traffic" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="latex-editor-view__workspace">
          <strong>{versionLabel || 'Current manuscript'}</strong>
          <span>{heading}</span>
        </div>
        <div className="latex-editor-view__badge">Read only</div>
      </div>
      <div className="latex-editor-view__toolbar">
        <div className="latex-editor-view__modes" aria-hidden="true">
          <span className="latex-editor-view__mode is-active">Source</span>
          <span className="latex-editor-view__mode">Outline</span>
          <span className="latex-editor-view__mode">Read only</span>
        </div>
        <div className="latex-editor-view__meta">
          <span>{lines.length} lines</span>
          <span>{nonEmptyLineCount} filled</span>
          <span>{outlineItems.length} sections</span>
        </div>
      </div>
      <div className={`latex-editor-shell ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
        <aside id="latex-editor-sidebar" className={`latex-editor-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`} aria-hidden={sidebarCollapsed}>
          <section className="latex-editor-sidebar__section">
            <div className="latex-editor-sidebar__header">
              <span>Workspace</span>
            </div>
            <div className="latex-editor-project">
              <div className="latex-editor-project__folder">
                <strong>{projectTitle || 'texor manuscript'}</strong>
                <span>{versionLabel || 'Current draft'}</span>
              </div>
            </div>
            {manuscriptState?.stats ? (
              <div className="latex-editor-sidebar__chips">
                <span>{manuscriptState.stats.wordCount} words</span>
                <span>{manuscriptState.stats.figureCount} figs</span>
                <span>{manuscriptState.stats.citationCount} cites</span>
              </div>
            ) : null}
          </section>

          <section className="latex-editor-sidebar__section is-outline">
            <div className="latex-editor-sidebar__header">
              <span>Outline</span>
            </div>
            <div className="latex-editor-outline">
              {outlineItems.length ? (
                outlineItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`latex-editor-outline__item is-depth-${item.depth} ${activeOutlineId === item.id ? 'is-active' : ''}`}
                    onClick={() => jumpToOutline(item)}
                  >
                    <strong>{item.title}</strong>
                    <span>L{item.line}</span>
                  </button>
                ))
              ) : (
                <div className="latex-editor-outline__empty">No outline detected</div>
              )}
            </div>
          </section>
        </aside>

        <button
          type="button"
          className={`latex-sidebar-edge-toggle ${sidebarCollapsed ? 'is-collapsed' : ''}`}
          onClick={() => setSidebarCollapsed((value) => !value)}
          aria-expanded={!sidebarCollapsed}
          aria-controls="latex-editor-sidebar"
          aria-label={sidebarCollapsed ? '展开左侧信息栏' : '收起左侧信息栏'}
          title={sidebarCollapsed ? '展开左侧信息栏' : '收起左侧信息栏'}
        >
          {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>

        <div className="latex-editor-main">
          <div className="latex-editor">
            <div
              ref={scrollRef}
              className="latex-editor__scroll"
              role="textbox"
              aria-label="Current LaTeX source"
              aria-multiline="true"
              aria-readonly="true"
              onClick={handleCodeClick}
            >
              {lines.map((line, index) => (
                <div className="latex-editor__row" key={`line-${index + 1}`} data-line={index + 1}>
                  <span className="latex-editor__line-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="latex-editor__line-content">{renderLatexLine(line, index)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="latex-editor__statusbar">
        <div className="latex-editor__statusbar-main">
          <div className="latex-editor__status-meta">
            <span>{versionLabel || 'Current'}</span>
            <span>{lines.length} lines</span>
          </div>
          <div className="latex-editor__status-context" title={activeOutline ? `${activeOutline.title} · L${activeOutline.line}` : `${lines.length} Ln`}>
            {activeOutline ? `${activeOutline.title} · L${activeOutline.line}` : `${lines.length} Ln`}
          </div>
        </div>
        {zoomPanelActive ? (
          <div className="latex-editor__zoom-indicator" aria-live="polite">
            <span>Wrap on</span>
            <strong>{latexZoomPercent}%</strong>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function resumePrompt(command: BridgeCommand): string {
  const payload = command.payload;
  const request = 'instruction' in payload ? payload.instruction : '继续完成刚才的任务';
  return [
    '刚才的 texor 任务中断了，请基于同一个项目和论文上下文继续完成。',
    '',
    '原始需求:',
    request,
    '',
    command.error ? '上次中断信息:' : undefined,
    command.error || undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function sourcePathForVersion(snapshot: WorkspaceSnapshot | null, version?: WorkspaceSnapshot['currentVersion']): string | undefined {
  if (!snapshot) {
    return version?.sourcePath;
  }
  const projectRoot = snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath;
  return (
    (projectRoot ? `${projectRoot}/.texor/manuscript/main.tex` : undefined) ||
    version?.sourcePath
  );
}

function canonicalManuscriptPath(projectRoot: string): string {
  return `${projectRoot.replace(/[\\/]+$/, '')}/.texor/manuscript/main.tex`;
}

function inferSessionBackend(sessionId?: string): AgentBackend | undefined {
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

function commandBackend(command: BridgeCommand | null): AgentBackend | undefined {
  if (!command || command.type !== 'codex-task') {
    return undefined;
  }
  const payload = command.payload;
  if ('agentBackend' in payload && payload.agentBackend) {
    return payload.agentBackend;
  }
  if ('modelConfig' in payload && payload.modelConfig?.apiKey) {
    return 'texor-agent';
  }
  return 'codex-cli';
}

function reusableSessionCommand(
  commands: BridgeCommand[],
  backend?: AgentBackend,
  options: {
    projectKey?: string;
    workspace?: WorkspaceSnapshot | null;
    windowSessionKey?: string;
  } = {},
): BridgeCommand | null {
  const candidates = commands
    .filter((command) => command.type === 'codex-task' && (command.sessionId || typeof command.result?.sessionId === 'string'))
    .filter((command) => !backend || commandBackend(command) === backend)
    .filter((command) => {
      if (!options.projectKey) {
        return true;
      }
      return commandMatchesProject(command, options.projectKey, options.workspace || null);
    })
    .filter((command) => {
      if (backend !== 'codex-native' || !options.windowSessionKey) {
        return true;
      }
      return commandMatchesWindowSession(command, options.windowSessionKey);
    })
    .filter((command) => command.status === 'done' || command.status === 'running' || command.status === 'failed')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  return candidates[candidates.length - 1] || null;
}

function sessionIdFromCommand(command: BridgeCommand | null): string | undefined {
  return command?.sessionId || (command?.result?.sessionId as string | undefined);
}

function commandWindowSessionKey(command: BridgeCommand | null): string | undefined {
  const payload = codexTaskPayload(command as BridgeCommand);
  return payload?.windowSessionKey?.trim() || undefined;
}

function normalizeProjectKey(projectRoot?: string): string {
  return (projectRoot || '').trim().replace(/[\\/]+$/, '');
}

function commandMatchesProject(command: BridgeCommand | null, projectKey: string, workspace: WorkspaceSnapshot | null): boolean {
  if (!command || !projectKey) {
    return false;
  }
  const payload = command.payload;
  if ('projectPath' in payload && normalizeProjectKey(payload.projectPath) === projectKey) {
    return true;
  }
  if ('projectRoot' in payload && normalizeProjectKey(payload.projectRoot) === projectKey) {
    return true;
  }
  if ('paperId' in payload && payload.paperId && workspace?.paper.id === payload.paperId) {
    const workspaceKey = normalizeProjectKey(workspace.paper.projectRoot || workspace.paper.analysis?.rootPath);
    return workspaceKey === projectKey;
  }
  return false;
}

function commandMatchesWindowSession(command: BridgeCommand | null, windowSessionKey: string): boolean {
  if (!command || !windowSessionKey) {
    return false;
  }
  return commandWindowSessionKey(command) === windowSessionKey;
}

function commandVisibleInScope(
  command: BridgeCommand | null,
  options: {
    projectKey?: string;
    workspace?: WorkspaceSnapshot | null;
    windowSessionKey?: string;
  } = {},
): boolean {
  if (!command) {
    return false;
  }
  if (options.projectKey && !commandMatchesProject(command, options.projectKey, options.workspace || null)) {
    return false;
  }
  if (commandBackend(command) !== 'codex-native') {
    return true;
  }
  if (!options.windowSessionKey) {
    return true;
  }
  return commandMatchesWindowSession(command, options.windowSessionKey);
}

function versionSummaryLabel(version?: PaperVersion): string {
  if (!version) {
    return '未载入版本';
  }
  return version.changeSummary?.summary || version.summary || version.label;
}

function versionTypeLabel(version?: PaperVersion): 'checkpoint' | 'rewind' | 'edit' | 'draft' {
  if (!version) {
    return 'edit';
  }
  const summary = (version.summary || '').trim().toLowerCase();
  if (summary.startsWith('checkpoint from ')) {
    return 'checkpoint';
  }
  if (summary.startsWith('rewind to ')) {
    return 'rewind';
  }
  if (summary.includes('initial ai draft') || summary.includes('codex handoff') || summary.includes('workspace bootstrap')) {
    return 'draft';
  }
  return 'edit';
}

function versionTypeBadge(version?: PaperVersion): string {
  switch (versionTypeLabel(version)) {
    case 'checkpoint':
      return 'Checkpoint';
    case 'rewind':
      return 'Rewind';
    case 'draft':
      return 'Draft';
    default:
      return 'Edit';
  }
}

function versionGroupLabel(versionType: ReturnType<typeof versionTypeLabel>): HistoryGroupLabel {
  switch (versionType) {
    case 'checkpoint':
    case 'rewind':
      return 'Checkpoints & Rewinds';
    case 'draft':
      return 'Draft Origins';
    default:
      return 'Edits';
  }
}

function defaultHistoryGroupCollapsed(filterMode: HistoryFilterMode): Record<HistoryGroupLabel, boolean> {
  if (filterMode === 'all') {
    return {
      'Checkpoints & Rewinds': false,
      'Draft Origins': true,
      Edits: false,
    };
  }
  return {
    'Checkpoints & Rewinds': false,
    'Draft Origins': false,
    Edits: false,
  };
}

function versionMatchesHistoryFilter(version: PaperVersion, filterMode: HistoryFilterMode): boolean {
  const versionType = versionTypeLabel(version);
  switch (filterMode) {
    case 'checkpoints':
      return versionType === 'checkpoint' || versionType === 'rewind';
    case 'edits':
      return versionType === 'edit';
    case 'drafts':
      return versionType === 'draft';
    default:
      return true;
  }
}

function historyFilterLabel(filterMode: HistoryFilterMode): string {
  switch (filterMode) {
    case 'checkpoints':
      return 'Checkpoints';
    case 'edits':
      return 'Edits';
    case 'drafts':
      return 'Drafts';
    default:
      return 'All';
  }
}

function historyFilterEmptyLabel(filterMode: HistoryFilterMode): string {
  switch (filterMode) {
    case 'checkpoints':
      return '这个分支里还没有 checkpoint 或 rewind。';
    case 'edits':
      return '这里还没有常规编辑版本。';
    case 'drafts':
      return '这里还没有 draft origin。';
    default:
      return '还没有可显示的版本。';
  }
}

function versionStatsChips(version?: PaperVersion): string[] {
  const stats = version?.manuscriptState?.stats;
  if (!stats) {
    return [];
  }
  const chips = [
    `${stats.wordCount} 词`,
    `${stats.sectionCount} 节`,
    `${stats.figureCount} 图`,
    `${stats.tableCount} 表`,
    `${stats.citationCount} 引文`,
    `${stats.todoCount} 待处理`,
  ];
  if (stats.missingAssetCount > 0) {
    chips.push(`${stats.missingAssetCount} 缺失资产`);
  }
  return chips;
}

function versionTouchedRegions(version?: PaperVersion, limit = 6): string[] {
  return version?.changeSummary?.touchedRegions?.slice(0, limit) || [];
}

function inferJumpQueryFromVersion(version?: PaperVersion): string {
  if (!version) {
    return '';
  }
  const focusedText = version.focusTarget?.selectedText?.replace(/\s+/g, ' ').trim();
  if (focusedText) {
    return focusedText;
  }
  const focusedRegion = version.focusTarget?.regionTitle?.trim();
  if (focusedRegion) {
    return focusedRegion;
  }
  const touched = versionTouchedRegions(version, 1)[0];
  if (touched) {
    return touched;
  }
  const summary = version.changeSummary?.summary || version.summary || '';
  return summary.replace(/^Structured patch revision:\s*/i, '').replace(/^Quick wording revision:\s*/i, '').trim();
}

function versionOpenItems(version?: PaperVersion, limit = 4): string[] {
  const state = version?.manuscriptState;
  if (!state) {
    return [];
  }
  const items = state.unresolvedEvidenceGaps?.length
    ? state.unresolvedEvidenceGaps
    : state.todos?.map((todo) => todo.text).filter(Boolean) || [];
  return items.slice(0, limit);
}

function manuscriptAssetLabel(asset: ManuscriptAsset): string {
  const label = asset.label || asset.kind;
  const primaryPath = asset.assetPath || asset.assetPaths?.[0] || asset.missingAssetPaths?.[0] || '';
  if (!primaryPath) {
    return '';
  }
  return `${label} -> ${primaryPath}${asset.assetExists === false ? ' (missing)' : ''}`;
}

function versionAssetLinks(version?: PaperVersion, limit = 4): string[] {
  const assets = [
    ...(version?.manuscriptState?.figures || []),
    ...(version?.manuscriptState?.tables || []),
  ];
  return [...assets]
    .sort((left, right) => Number(right.assetExists === false) - Number(left.assetExists === false) || left.line - right.line)
    .map((asset) => manuscriptAssetLabel(asset))
    .filter(Boolean)
    .slice(0, limit);
}

function versionTimelineMeta(version?: PaperVersion): string {
  if (!version) {
    return '';
  }
  const created = new Date(version.createdAt);
  const createdLabel = Number.isNaN(created.getTime()) ? version.createdAt : created.toLocaleString();
  return `${version.label} · ${createdLabel}`;
}

function versionInsightCompareActionLabel(
  version: PaperVersion | undefined,
  compareTargetVersion: PaperVersion | undefined,
  versions: PaperVersion[],
): string {
  if (!version || !compareTargetVersion || version.id === compareTargetVersion.id) {
    return '';
  }
  const shared = versionSharedAncestor(version, compareTargetVersion, versions);
  if (compareTargetVersion.basedOnVersionId === version.id) {
    return 'Compare base to focus';
  }
  if (version.basedOnVersionId === compareTargetVersion.id) {
    return 'Compare branch to base';
  }
  if (shared?.id === version.id) {
    return 'Compare origin to focus';
  }
  if (shared?.id === compareTargetVersion.id) {
    return 'Compare descendant to base';
  }
  if (shared) {
    return 'Compare branch to focus';
  }
  return 'Compare roots';
}

function versionCompareShortcutLabel(
  kind: VersionCompareShortcutKind,
  reference: PaperVersion | undefined,
  focus: PaperVersion | undefined,
  versions: PaperVersion[],
): string {
  if (!reference || !focus || reference.id === focus.id) {
    return '';
  }
  if (kind === 'split') {
    return 'Compare at split';
  }
  return versionInsightCompareActionLabel(reference, focus, versions);
}

function versionPathHeadingLabel(kind: VersionPathHeadingKind): string {
  switch (kind) {
    case 'submission':
      return 'Submission path';
    case 'current':
      return 'Current path';
    case 'focus-route':
      return 'Route to focus';
    default:
      return 'Revision path';
  }
}

function versionCompareRelationTitle(
  reference: PaperVersion | undefined,
  focus: PaperVersion | undefined,
  scope: 'submit' | 'current' | 'generic',
): string {
  if (!reference) {
    return '查看这条分支关系';
  }
  if (!focus) {
    return `查看 ${reference.label} 的分支关系`;
  }
  if (scope === 'submit') {
    return `检查 ${reference.label} 与 ${focus.label} 的提交时分支关系`;
  }
  if (scope === 'current') {
    return `检查 ${reference.label} 与 ${focus.label} 的当前分支关系`;
  }
  return `检查 ${reference.label} 与 ${focus.label} 的分支关系`;
}

function versionCompareActionTitle(
  reference: PaperVersion | undefined,
  focus: PaperVersion | undefined,
  pathLabel?: string,
): string {
  if (pathLabel) {
    return pathLabel;
  }
  if (!reference || !focus) {
    return '打开这组版本对比';
  }
  return `对比 ${reference.label} 与 ${focus.label}`;
}

function versionCompareSplitTitle(
  splitVersion: PaperVersion | undefined,
  focus: PaperVersion | undefined,
): string {
  if (!splitVersion || !focus) {
    return '从分叉点打开对比';
  }
  return `从分叉点 ${splitVersion.label} 对比到 ${focus.label}`;
}

function observerRevisionStage(
  config: {
    tone: 'submission' | 'saved';
    heading: string;
    summary: string;
    relationLabel?: string;
    relationReferenceVersion?: PaperVersion | null;
    relationFocusVersion?: PaperVersion | null;
    relationScope?: 'submit' | 'current' | 'generic';
    pathHeadingKind: VersionPathHeadingKind;
    pathLabel?: string;
    pathSegments?: VersionPathSegment[];
    compareActionLabel?: string;
    compareReferenceVersion?: PaperVersion | null;
    compareFocusVersion?: PaperVersion | null;
    splitVersion?: PaperVersion | null;
    splitFocusVersion?: PaperVersion | null;
    splitVersions?: PaperVersion[];
    primaryLinks?: Array<{ label: string; versionId: string }>;
  },
): ObserverRevisionStage {
  const relationReference = config.relationReferenceVersion || null;
  const relationFocus = config.relationFocusVersion || null;
  const compareReference = config.compareReferenceVersion || null;
  const compareFocus = config.compareFocusVersion || null;
  const splitVersion = config.splitVersion || null;
  const splitFocus = config.splitFocusVersion || null;
  return {
    tone: config.tone,
    heading: config.heading,
    summary: config.summary,
    relationLabel: config.relationLabel || '',
    relationTitle: versionCompareRelationTitle(relationReference || undefined, relationFocus || undefined, config.relationScope || 'generic'),
    relationReferenceVersion: relationReference,
    relationFocusVersion: relationFocus,
    pathHeading: versionPathHeadingLabel(config.pathHeadingKind),
    pathLabel: config.pathLabel || '',
    pathSegments: config.pathSegments || [],
    compareActionLabel: config.compareActionLabel || '',
    compareActionTitle: versionCompareActionTitle(compareReference || undefined, compareFocus || undefined, config.pathLabel),
    compareReferenceVersion: compareReference,
    compareFocusVersion: compareFocus,
    splitActionLabel: splitVersion && splitFocus && config.splitVersions?.length
      ? versionCompareShortcutLabel('split', splitVersion, splitFocus, config.splitVersions)
      : '',
    splitActionTitle: versionCompareSplitTitle(splitVersion || undefined, splitFocus || undefined),
    splitVersion,
    splitFocusVersion: splitFocus,
    primaryLinks: config.primaryLinks || [],
    impactRegions: config.tone === 'saved' ? observerSavedRevisionImpactRegions(compareFocus) : [],
  };
}

function renderObserverRevisionStage(
  stage: ObserverRevisionStage,
  options: {
    onOpenVersion: (versionId: string) => void;
    onOpenVersionRegion: (versionId: string, query: string) => void;
    onOpenCompare: (referenceId: string, focusId: string, focusQuery?: string, entrySource?: CompareEntrySource | null) => void;
  },
) {
  return (
    <div className={`workspace-chat-bubble__revision-stage workspace-chat-bubble__revision-stage--${stage.tone}`}>
      <div className="workspace-chat-bubble__revision-stage-head">
        <strong>{stage.heading}</strong>
        {stage.relationLabel && stage.relationReferenceVersion ? (
          <button
            type="button"
            className="workspace-chat-bubble__chip workspace-chat-bubble__chip--relation is-link"
            title={stage.relationTitle}
            onClick={() => {
              const relationReferenceVersion = stage.relationReferenceVersion;
              const relationFocusVersion = stage.relationFocusVersion;
              if (relationReferenceVersion && relationFocusVersion) {
                options.onOpenCompare(relationReferenceVersion.id, relationFocusVersion.id);
                return;
              }
              if (relationReferenceVersion) {
                options.onOpenVersion(relationReferenceVersion.id);
              }
            }}
          >
            {stage.relationLabel}
          </button>
        ) : null}
      </div>
      <span>{stage.summary}</span>
      {stage.pathSegments.length ? (
        <span className={`workspace-chat-bubble__revision-path ${stage.tone === 'submission' ? 'workspace-chat-bubble__revision-path--submission' : ''}`}>
          <strong>{stage.pathHeading}</strong>
          {stage.pathSegments.map((item, index) =>
            item.type === 'version' && item.versionId ? (
              <button
                type="button"
                key={`${stage.heading}-${item.versionId}-${index}`}
                className="workspace-chat-bubble__revision-link"
                onClick={() => options.onOpenVersion(item.versionId || '')}
              >
                {item.label}
              </button>
            ) : (
              <span key={`${stage.heading}-${item.label}-${index}`} className="workspace-chat-bubble__revision-separator">
                {item.label}
              </span>
            ),
          )}
        </span>
      ) : null}
      {stage.compareActionLabel || stage.splitActionLabel ? (
        <div className="workspace-chat-bubble__revision-actions">
          {stage.compareActionLabel && stage.compareReferenceVersion && stage.compareFocusVersion ? (
            <button
              type="button"
              className="workspace-chat-bubble__revision-action workspace-chat-bubble__revision-action--compare"
              title={stage.compareActionTitle}
              onClick={() => options.onOpenCompare(stage.compareReferenceVersion?.id || '', stage.compareFocusVersion?.id || '')}
            >
              {stage.compareActionLabel}
            </button>
          ) : null}
          {stage.splitActionLabel && stage.splitVersion && stage.splitFocusVersion ? (
            <button
              type="button"
              className="workspace-chat-bubble__revision-action workspace-chat-bubble__revision-action--split"
              title={stage.splitActionTitle}
              onClick={() => options.onOpenCompare(stage.splitVersion?.id || '', stage.splitFocusVersion?.id || '')}
            >
              {stage.splitActionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      {stage.impactRegions.length && stage.compareFocusVersion ? (
        <div className="workspace-chat-bubble__revision-impact">
          <strong>Changed regions</strong>
          <div className="workspace-chat-bubble__revision-impact-chips">
            {stage.impactRegions.map((region) => (
              <button
                type="button"
                key={`${stage.heading}-${region.query}`}
                className="workspace-chat-bubble__revision-impact-chip"
                onClick={() => {
                  if (stage.compareReferenceVersion && stage.compareFocusVersion) {
                    options.onOpenCompare(stage.compareReferenceVersion.id, stage.compareFocusVersion.id, region.query, stage.tone === 'saved'
                      ? {
                          kind: 'observer-saved-region',
                          regionLabel: region.label,
                          regionQuery: region.query,
                        }
                      : null);
                    return;
                  }
                  options.onOpenVersionRegion(stage.compareFocusVersion?.id || '', region.query);
                }}
              >
                {region.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {stage.primaryLinks.length ? (
        <div className="workspace-chat-bubble__revision-stage-links">
          {stage.primaryLinks.map((item) => (
            <button
              type="button"
              key={`${stage.heading}-${item.versionId}-${item.label}`}
              className="workspace-chat-bubble__notice-link workspace-chat-bubble__notice-link--history"
              onClick={() => options.onOpenVersion(item.versionId)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function observerRevisionSummaryLabel(stage: ObserverRevisionStage): string {
  if (stage.tone === 'saved') {
    return 'Saved path';
  }
  return stage.pathHeading;
}

function observerSavedRevisionIdentity(savedVersion: PaperVersion): string {
  const typeLabel = versionTypeBadge(savedVersion);
  const summaryLabel = versionSummaryLabel(savedVersion);
  if (summaryLabel && summaryLabel !== savedVersion.label) {
    return `${typeLabel} · ${savedVersion.label} · ${summaryLabel}`;
  }
  return `${typeLabel} · ${savedVersion.label}`;
}

function observerSavedRevisionRegionSummary(
  savedVersion: PaperVersion | null,
  limit = 3,
): { value: string; title: string; segments: Array<{ key: string; label: string; targetQuery: string }> } | null {
  const touchedRegions = savedVersion?.changeSummary?.touchedRegions || [];
  if (!touchedRegions.length) {
    return null;
  }
  const visibleRegions = touchedRegions.slice(0, limit);
  const remainingCount = touchedRegions.length - visibleRegions.length;
  const segments = visibleRegions.map((region, index) => ({
    key: `${savedVersion?.id || 'version'}-region-${index}`,
    label: region,
    targetQuery: region,
  }));
  if (remainingCount > 0) {
    segments.push({
      key: `${savedVersion?.id || 'version'}-region-more`,
      label: `+${remainingCount} more`,
      targetQuery: visibleRegions[0] || '',
    });
  }
  return {
    value: remainingCount > 0 ? `${visibleRegions.join(' · ')} +${remainingCount} more` : visibleRegions.join(' · '),
    title: touchedRegions.join(' / '),
    segments,
  };
}

function observerSavedRevisionImpactRegions(savedVersion: PaperVersion | null, limit = 4): Array<{ label: string; query: string }> {
  const touchedRegions = savedVersion?.changeSummary?.touchedRegions || [];
  return touchedRegions.slice(0, limit).map((region) => ({ label: region, query: region }));
}

function openCompareWithFocusQuery(
  workspace: WorkspaceSnapshot | null,
  previousVersionId: string,
  currentVersionId: string,
  focusQuery: string,
  controls: {
    setDraftOpen: (value: boolean) => void;
    setDraftFocusQuery: (value: string) => void;
    setHistoryNavigationState: (value: HistoryNavigationState | null) => void;
    setLeftPaneMode: (value: LeftPaneMode) => void;
    setLeftPaneOpen: (value: boolean) => void;
    setManualVersionSelection: (value: boolean) => void;
    setLeftVersionId: (value: string) => void;
    setRightVersionId: (value: string) => void;
    refreshDiffPdf: (snapshot: WorkspaceSnapshot, leftId: string, rightId: string) => Promise<void>;
    pendingVersionJumpRef: { current: { versionId: string; query: string; line?: number; column?: number; selectedText?: string; pageHint?: number } | null };
  },
) {
  if (!workspace) {
    return;
  }
  if (!workspace.versions.some((version) => version.id === previousVersionId) || !workspace.versions.some((version) => version.id === currentVersionId)) {
    return;
  }
  controls.setDraftOpen(false);
  controls.setDraftFocusQuery('');
  controls.setHistoryNavigationState(null);
  controls.setLeftPaneMode('previous');
  controls.setLeftPaneOpen(true);
  controls.setManualVersionSelection(true);
  controls.setLeftVersionId(previousVersionId);
  controls.setRightVersionId(currentVersionId);
  const focusVersion = workspace.versions.find((version) => version.id === currentVersionId);
  controls.pendingVersionJumpRef.current = {
    versionId: currentVersionId,
    query: focusQuery.trim(),
    line: focusVersion?.focusTarget?.sourceLine,
    column: focusVersion?.focusTarget?.sourceColumn,
    selectedText: focusVersion?.focusTarget?.selectedText,
    pageHint: focusVersion?.focusTarget?.pageHint,
  };
  void controls.refreshDiffPdf(workspace, previousVersionId, currentVersionId);
}

function observerSubmissionPaneMeta(command: BridgeCommand): ObserverPaneMeta {
  const payload = codexTaskPayload(command);
  if (payload?.draftingMode === 'understand-project') {
    return {
      chipLabel: 'Before revision · Understand',
      chipTone: 'neutral',
      description: 'Repository analysis phase before TEXOR starts drafting manuscript revisions.',
    };
  }
  if (payload?.draftingMode === 'initial-draft') {
    return {
      chipLabel: 'Before revision · Draft',
      chipTone: 'submission',
      description: 'Initial manuscript drafting launched from the active writing context.',
    };
  }
  if (payload?.taskIntent === 'chat') {
    return {
      chipLabel: 'Before revision · Discuss',
      chipTone: 'neutral',
      description: 'Discussion request captured against the current manuscript context.',
    };
  }
  return {
    chipLabel: 'Before revision · Edit',
    chipTone: 'submission',
    description: 'Revision request launched from the active writing context.',
  };
}

function observerResultPaneMeta(
  command: BridgeCommand,
  savedVersionHint: SavedVersionContext | null,
  failureHint: string | null,
): ObserverPaneMeta {
  if (savedVersionHint?.savedVersionId) {
    const savedRevisionLabel = savedVersionHint.savedVersion ? observerSavedRevisionIdentity(savedVersionHint.savedVersion) : '';
    return {
      chipLabel: 'After revision · Saved',
      chipTone: 'saved',
      description: savedRevisionLabel
        ? `Saved ${savedRevisionLabel}.`
        : 'This run produced a saved manuscript revision on the current branch line.',
    };
  }
  if (command.status === 'failed') {
    return {
      chipLabel: 'After revision · Failed',
      chipTone: 'warning',
      description: failureHint || 'The run stopped before TEXOR could save a new manuscript revision.',
    };
  }
  if (command.status === 'running' || command.status === 'queued') {
    return {
      chipLabel: 'After revision · Pending',
      chipTone: 'running',
      description: 'TEXOR is still working, so this event has not settled into a saved revision yet.',
    };
  }
  const payload = codexTaskPayload(command);
  if (payload?.taskIntent === 'chat') {
    return {
      chipLabel: 'After revision · Discussion',
      chipTone: 'neutral',
      description: 'This run returned discussion output without saving a new manuscript revision.',
    };
  }
  return {
    chipLabel: 'After revision · No save',
    chipTone: 'neutral',
    description: 'This run finished without creating a saved manuscript revision.',
  };
}

function observerEventSummaryItems(
  stages: ObserverRevisionStage[],
  resultPaneMeta: ObserverPaneMeta,
  savedVersionHint: SavedVersionContext | null,
): ObserverEventSummaryItem[] {
  const items: ObserverEventSummaryItem[] = stages.map((stage) => {
    const summaryLabel = observerRevisionSummaryLabel(stage);
    const summaryValue = stage.pathLabel || stage.summary || stage.heading;
    const summaryTargetVersion =
      stage.compareFocusVersion ||
      stage.relationFocusVersion ||
      stage.relationReferenceVersion ||
      null;
    const canOpenCompare = Boolean(stage.compareReferenceVersion && stage.compareFocusVersion);
    const summaryTitle = canOpenCompare
      ? stage.compareActionTitle
      : summaryTargetVersion
        ? `${summaryLabel}: ${summaryValue}`
        : summaryValue;
    return {
      key: `${stage.tone}-${stage.heading}-${stage.pathLabel}`,
      tone: stage.tone,
      label: summaryLabel,
      value: summaryValue,
      title: summaryTitle,
      compareReferenceVersion: stage.compareReferenceVersion,
      compareFocusVersion: stage.compareFocusVersion,
      targetVersion: summaryTargetVersion,
    };
  });
  if (savedVersionHint?.savedVersion) {
    const savedSummaryPrefixItems: ObserverEventSummaryItem[] = [];
    if (savedVersionHint.baseVersion) {
      savedSummaryPrefixItems.push({
        key: `mutation-${savedVersionHint.baseVersion.id}-${savedVersionHint.savedVersion.id}`,
        tone: 'saved',
        label: 'Revision mutation',
        value: `${savedVersionHint.baseVersion.label} -> ${observerSavedRevisionIdentity(savedVersionHint.savedVersion)}`,
        title: savedVersionHint.pathLabel || resultPaneMeta.description,
        compareReferenceVersion: savedVersionHint.baseVersion,
        compareFocusVersion: savedVersionHint.savedVersion,
        targetVersion: savedVersionHint.savedVersion,
      });
    }
    const savedRegionSummary = observerSavedRevisionRegionSummary(savedVersionHint.savedVersion);
    if (savedRegionSummary) {
      savedSummaryPrefixItems.push({
        key: `saved-regions-${savedVersionHint.savedVersion.id}`,
        tone: 'saved',
        label: 'Changed regions',
        value: savedRegionSummary.value,
        title: savedRegionSummary.title,
        compareReferenceVersion: savedVersionHint.baseVersion,
        compareFocusVersion: savedVersionHint.savedVersion,
        targetVersion: savedVersionHint.savedVersion,
        segmentedValues: savedRegionSummary.segments,
      });
    }
    items.unshift(...savedSummaryPrefixItems);
    items.push({
      key: `saved-revision-${savedVersionHint.savedVersion.id}`,
      tone: 'saved',
      label: 'Saved revision',
      value: observerSavedRevisionIdentity(savedVersionHint.savedVersion),
      title: resultPaneMeta.description,
      compareReferenceVersion: null,
      compareFocusVersion: null,
      targetVersion: savedVersionHint.savedVersion,
    });
  } else {
    items.push({
      key: `result-${resultPaneMeta.chipLabel}`,
      tone: resultPaneMeta.chipTone,
      label: 'Outcome',
      value: resultPaneMeta.chipLabel.replace(/^After revision · /, ''),
      title: resultPaneMeta.description,
      compareReferenceVersion: null,
      compareFocusVersion: null,
      targetVersion: null,
    });
  }
  return items;
}

function renderObserverRevisionSummary(
  items: ObserverEventSummaryItem[],
  options: {
    onOpenVersion: (versionId: string) => void;
    onOpenVersionRegion: (versionId: string, query: string, entrySource?: HistoryPreviewEntrySource | null) => void;
    onOpenCompare: (referenceId: string, focusId: string, focusQuery?: string) => void;
  },
) {
  if (!items.length) {
    return null;
  }
  return (
    <div className="workspace-chat-turn__summary">
      <strong className="workspace-chat-turn__summary-title">Revision flow</strong>
      <div className="workspace-chat-turn__summary-items">
        {items.map((item) => {
          const canOpenCompare = Boolean(item.compareReferenceVersion && item.compareFocusVersion);
          const isClickable = Boolean(canOpenCompare || item.targetVersion);
          return (
            <div className={`workspace-chat-turn__summary-item is-${item.tone}`} key={item.key}>
              <span className="workspace-chat-turn__summary-label">{item.label}</span>
              {item.segmentedValues?.length && item.targetVersion ? (
                <div className="workspace-chat-turn__summary-chips" title={item.title}>
                  {item.segmentedValues.map((segment) => (
                    <button
                      type="button"
                      key={segment.key}
                      className="workspace-chat-turn__summary-chip"
                      onClick={() => options.onOpenVersionRegion(
                        item.targetVersion?.id || '',
                        segment.targetQuery || segment.label,
                        item.compareReferenceVersion
                          ? {
                              kind: 'observer-saved-region',
                              regionLabel: segment.label,
                              regionQuery: segment.targetQuery || segment.label,
                              compareReferenceVersionId: item.compareReferenceVersion.id,
                            }
                          : null,
                      )}
                    >
                      {segment.label}
                    </button>
                  ))}
                </div>
              ) : isClickable ? (
                <button
                  type="button"
                  className="workspace-chat-turn__summary-route"
                  title={item.title}
                  onClick={() => {
                    if (item.compareReferenceVersion && item.compareFocusVersion) {
                      options.onOpenCompare(item.compareReferenceVersion.id, item.compareFocusVersion.id);
                      return;
                    }
                    if (item.targetVersion) {
                      options.onOpenVersion(item.targetVersion.id);
                    }
                  }}
                >
                  {item.value}
                </button>
              ) : (
                <span className="workspace-chat-turn__summary-route is-static" title={item.title}>{item.value}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VersionInsightCard({
  version,
  tone,
  heading,
  branchLabel,
  statusLabel,
  lineageLabel,
  relationLabel,
  lineageBreadcrumb,
  compareReferenceVersion,
  compareFocusVersion,
  compareVersions,
  onCompareVersions,
  onSelectVersion,
  entry,
  onOpenEntryRegion,
}: {
  version?: PaperVersion;
  tone: 'previous' | 'current' | 'neutral';
  heading: string;
  branchLabel?: string;
  statusLabel?: string;
  lineageLabel?: string;
  relationLabel?: string;
  lineageBreadcrumb?: Array<{ id: string; label: string }>;
  compareReferenceVersion?: PaperVersion;
  compareFocusVersion?: PaperVersion;
  compareVersions?: PaperVersion[];
  onCompareVersions?: (referenceId: string, focusId: string) => void;
  onSelectVersion?: (versionId: string) => void;
  entry?: VersionInsightEntry | null;
  onOpenEntryRegion?: (versionId: string, query: string) => void;
}) {
  if (!version) {
    return null;
  }

  const touched = versionTouchedRegions(version, 5);
  const gaps = versionOpenItems(version, 3);
  const stats = versionStatsChips(version);
  const assets = versionAssetLinks(version, 3);
  const compareActionLabel = compareReferenceVersion && compareFocusVersion && compareVersions?.length
    ? versionCompareShortcutLabel('default', compareReferenceVersion, compareFocusVersion, compareVersions)
    : '';
  const sharedCompareAncestor = compareReferenceVersion && compareFocusVersion && compareVersions?.length
    ? versionSharedAncestor(compareReferenceVersion, compareFocusVersion, compareVersions)
    : null;
  const canCompareToTarget = Boolean(
    compareActionLabel &&
    compareReferenceVersion &&
    compareFocusVersion &&
    compareReferenceVersion.id !== compareFocusVersion.id &&
    onCompareVersions,
  );
  const canCompareAtSplit = Boolean(
    sharedCompareAncestor &&
    compareReferenceVersion &&
    compareFocusVersion &&
    onCompareVersions &&
    sharedCompareAncestor.id !== compareReferenceVersion.id &&
    sharedCompareAncestor.id !== compareFocusVersion.id,
  );

  return (
    <div className={`version-insight-card is-${tone}`}>
      <div className="version-insight-card__header">
        <span>{heading}</span>
        <strong>{version.label}</strong>
      </div>
      <div className={`version-insight-card__type is-${versionTypeLabel(version)}`}>{versionTypeBadge(version)}</div>
      <p>{versionSummaryLabel(version)}</p>
      <em>{versionTimelineMeta(version)}</em>
      {branchLabel || statusLabel || lineageLabel || relationLabel || lineageBreadcrumb?.length ? (
        <div className="version-insight-card__meta">
          {statusLabel ? <span className="version-insight-card__meta-chip">{statusLabel}</span> : null}
          {branchLabel ? <span className="version-insight-card__meta-chip">{branchLabel}</span> : null}
          {lineageBreadcrumb?.length ? (
            <span className="version-insight-card__lineage">
              <strong>Lineage</strong>
              {lineageBreadcrumb.map((item) =>
                item.id === '__ellipsis__' ? (
                  <em key={`${heading}-ellipsis`}>...</em>
                ) : onSelectVersion ? (
                  <button type="button" key={item.id} className="version-insight-card__lineage-link" onClick={() => onSelectVersion(item.id)}>
                    {item.label}
                  </button>
                ) : (
                  <span key={item.id} className="is-lineage">{item.label}</span>
                ),
              )}
            </span>
          ) : lineageLabel ? <span className="version-insight-card__meta-chip is-lineage">{lineageLabel}</span> : null}
          {relationLabel ? (
            canCompareToTarget ? (
              <button
                type="button"
                className="version-insight-card__meta-chip is-relation is-link"
                title={versionCompareRelationTitle(compareReferenceVersion, compareFocusVersion, 'generic')}
                onClick={() => onCompareVersions?.(compareReferenceVersion?.id || '', compareFocusVersion?.id || '')}
              >
                {relationLabel}
              </button>
            ) : (
              <span className="version-insight-card__meta-chip is-relation">{relationLabel}</span>
            )
          ) : null}
        </div>
      ) : null}
      {entry && onOpenEntryRegion ? (
        <div className="version-insight-card__entry" title={entry.title}>
          <span className="version-insight-card__entry-label">{entry.label}</span>
          <span className="version-insight-card__entry-copy">{entry.detail}</span>
          <button
            type="button"
            className="version-insight-card__entry-chip"
            onClick={() => onOpenEntryRegion(entry.versionId, entry.query)}
            title={entry.chipTitle}
          >
            {entry.chipLabel}
          </button>
          {entry.actionLabel && entry.actionReferenceVersionId && entry.actionFocusVersionId && onCompareVersions ? (
            <button
              type="button"
              className="version-insight-card__entry-action"
              onClick={() => onCompareVersions(entry.actionReferenceVersionId || '', entry.actionFocusVersionId || '')}
              title={entry.actionTitle || entry.actionLabel}
            >
              {entry.actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      {canCompareToTarget || canCompareAtSplit ? (
        <div className="version-insight-card__actions">
          {canCompareToTarget ? (
            <button
              type="button"
              className="version-insight-card__action version-insight-card__action--compare"
              onClick={() => onCompareVersions?.(compareReferenceVersion?.id || '', compareFocusVersion?.id || '')}
            >
              {compareActionLabel}
            </button>
          ) : null}
          {canCompareAtSplit ? (
            <button
              type="button"
              className="version-insight-card__action version-insight-card__action--split"
              onClick={() => onCompareVersions?.(sharedCompareAncestor?.id || '', compareFocusVersion?.id || '')}
            >
              {versionCompareShortcutLabel('split', sharedCompareAncestor || undefined, compareFocusVersion, compareVersions || [])}
            </button>
          ) : null}
        </div>
      ) : null}
      {stats.length ? (
        <div className="version-insight-card__chips">
          {stats.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
      {touched.length ? (
        <div className="version-insight-card__regions">
          {touched.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
      {gaps.length ? (
        <div className="version-insight-card__gaps">
          {gaps.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
      {assets.length ? (
        <div className="version-insight-card__assets">
          {assets.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const LAYOUT_RESIZER_SIZE = 14;
const PREVIOUS_PANE_MIN_WIDTH = 280;
const CURRENT_PANE_MIN_WIDTH = 280;
const OBSERVER_PANE_MIN_WIDTH = 300;
const WORKSPACE_MAIN_MIN_WIDTH = 520;

type ResizeTarget = 'previous-pane' | 'observer-pane';

function storedPixelWidth(key: string, fallback: number): number {
  const stored = window.localStorage.getItem(key);
  if (!stored) {
    return fallback;
  }
  const parsed = Number.parseFloat(stored);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampWidth(width: number, min: number, max: number): number {
  if (max <= min) {
    return min;
  }
  return Math.min(max, Math.max(min, width));
}

function isDesktopResizableLayout(): boolean {
  return window.innerWidth > 980;
}

function storedObserverPaneWidth(): number {
  const fallback = 344;
  const stored = window.localStorage.getItem('texor.observerPaneWidth');
  if (!stored) {
    return fallback;
  }
  const parsed = Number.parseFloat(stored);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed === 420 || parsed === 384 ? fallback : parsed;
}

function clampPreviousPaneWidth(width: number, compareWidth: number): number {
  const max = Math.max(PREVIOUS_PANE_MIN_WIDTH, compareWidth - CURRENT_PANE_MIN_WIDTH - LAYOUT_RESIZER_SIZE);
  return clampWidth(width, PREVIOUS_PANE_MIN_WIDTH, max);
}

function clampObserverPaneWidth(width: number, canvasWidth: number): number {
  const max = Math.max(OBSERVER_PANE_MIN_WIDTH, canvasWidth - WORKSPACE_MAIN_MIN_WIDTH - LAYOUT_RESIZER_SIZE);
  return clampWidth(width, OBSERVER_PANE_MIN_WIDTH, max);
}

function executionTargetLabel(target?: ProjectExecutionTarget): string {
  if (!target) {
    return '本地项目';
  }
  return target.kind === 'ssh' ? `SSH · ${target.hostAlias}` : '本地项目';
}

function workspaceExecutionTarget(workspace: WorkspaceSnapshot | null, fallbackProjectPath?: string): ProjectExecutionTarget | null {
  if (workspace?.paper.executionTarget) {
    return workspace.paper.executionTarget;
  }
  if (workspace?.paper.projectRoot) {
    return {
      kind: 'local',
      rootPath: workspace.paper.projectRoot,
    };
  }
  if (fallbackProjectPath?.trim()) {
    return {
      kind: 'local',
      rootPath: fallbackProjectPath.trim(),
    };
  }
  return null;
}

function isLikelyTextFile(filePath: string): boolean {
  return /\.(?:tex|bib|cls|sty|md|txt|py|js|ts|tsx|jsx|json|yml|yaml|sh|bash|zsh|csv|svg|xml|html|css|scss|c|cc|cpp|h|hpp|java|r|m|jl)$/i.test(filePath);
}

function workspaceDisplayRoot(snapshot: WorkspaceSnapshot | null, preparedTarget: DesktopPreparedTarget | null, projectPath: string): string {
  if (snapshot?.paper.executionTarget?.kind === 'ssh') {
    return `${snapshot.paper.executionTarget.hostAlias}:${snapshot.paper.executionTarget.remoteRoot}`;
  }
  if (snapshot?.paper.executionTarget?.kind === 'local') {
    return snapshot.paper.executionTarget.rootPath;
  }
  if (preparedTarget?.displayLabel) {
    return preparedTarget.displayLabel;
  }
  return projectPath.trim();
}

function App() {
  const pdfCompareRef = useRef<HTMLElement>(null);
  const workspaceCanvasRef = useRef<HTMLDivElement>(null);
  const chatComposerRef = useRef<HTMLTextAreaElement>(null);
  const chatTimelineRef = useRef<HTMLDivElement>(null);
  const chatStickToBottomRef = useRef(true);
  const windowSessionKeyRef = useRef(ensureWindowSessionKey());
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const workspaceListRequestSeqRef = useRef(0);
  const workspaceRequestSerialRef = useRef(0);
  const workspaceRequestByPaperRef = useRef<Record<string, number>>({});
  const workspaceTargetPaperIdRef = useRef<string | null>(null);
  const startupWorkspaceRestoreAttemptedRef = useRef(false);
  const sessionReuseBarrierRef = useRef<Record<string, string>>({});
  const diffRequestSeqRef = useRef(0);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [desktopReady, setDesktopReady] = useState(false);
  const [vscodeImported, setVscodeImported] = useState(false);
  const [sshHosts, setSshHosts] = useState<SSHHostProfile[]>([]);
  const [connectionMode, setConnectionMode] = useState<'local' | 'ssh'>('local');
  const [sshHostAlias, setSshHostAlias] = useState('');
  const [preparedTarget, setPreparedTarget] = useState<DesktopPreparedTarget | null>(null);
  const [remoteProjectPath, setRemoteProjectPath] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [texPath, setTexPath] = useState('');
  const [targetJournal, setTargetJournal] = useState('');
  const [projectMode, setProjectMode] = useState<'load' | 'new'>('new');
  const [agentBackend, setAgentBackend] = useState<AgentBackend>(() => (window.localStorage.getItem('texor.agentBackend') as AgentBackend) || 'texor-agent');
  const [agentProvider, setAgentProvider] = useState(() => storedModelConfig().provider || 'OpenAI-compatible');
  const [agentBaseUrl, setAgentBaseUrl] = useState(() => storedModelConfig().baseUrl || 'https://api.openai.com/v1');
  const [agentModel, setAgentModel] = useState(() => storedModelConfig().model || DEFAULT_TEXOR_AGENT_MODEL);
  const [agentImageModel, setAgentImageModel] = useState(() => storedModelConfig().imageModel || 'gpt-image-1');
  const [agentApiKey, setAgentApiKey] = useState(() => storedModelConfig().apiKey || '');
  const [codexModel, setCodexModel] = useState(() => storedCodexConfig().model || DEFAULT_CODEX_MODEL);
  const [codexReasoningEffort, setCodexReasoningEffort] = useState(() => storedCodexConfig().reasoningEffort || DEFAULT_CODEX_REASONING_EFFORT);
  const [claudeModel, setClaudeModel] = useState(() => storedClaudeConfig().model || '');
  const [projectTaskSpeedMode, setProjectTaskSpeedMode] = useState<TaskSpeedMode>(() => (window.localStorage.getItem('texor.projectTaskSpeedMode') as TaskSpeedMode) || 'deep');
  const [nativeTaskIntent, setNativeTaskIntent] = useState<CodexTaskIntent>(() => (window.localStorage.getItem('texor.nativeTaskIntent') as CodexTaskIntent) || 'auto');
  const [workspaceList, setWorkspaceList] = useState<WorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [diffPdf, setDiffPdf] = useState<DiffCompileResult | null>(null);
  const [leftVersionId, setLeftVersionId] = useState('');
  const [rightVersionId, setRightVersionId] = useState('');
  const [compareEntryContext, setCompareEntryContext] = useState<CompareEntryContext | null>(null);
  const [historyPreviewEntryContext, setHistoryPreviewEntryContext] = useState<HistoryPreviewEntryContext | null>(null);
  const [manualVersionSelection, setManualVersionSelection] = useState(false);
  const [leftPaneMode, setLeftPaneMode] = useState<LeftPaneMode>('previous');
  const [leftPaneOpen, setLeftPaneOpen] = useState(() => window.localStorage.getItem('texor.leftPaneOpen') === 'true');
  const [annotationTarget, setAnnotationTarget] = useState<AnnotationTarget | null>(null);
  const [pdfSelectionClearSignal, setPdfSelectionClearSignal] = useState(0);
  const [pdfJumpTarget, setPdfJumpTarget] = useState<PdfJumpTarget | null>(null);
  const [templateSuggestions, setTemplateSuggestions] = useState<TemplateSuggestion[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateSuggestion | null>(null);
  const [templateStatus, setTemplateStatus] = useState<TemplateEnsureResult | null>(null);
  const [templateDownloadingId, setTemplateDownloadingId] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftVersionId, setDraftVersionId] = useState('');
  const [draftFocusQuery, setDraftFocusQuery] = useState('');
  const [historyFilterMode, setHistoryFilterMode] = useState<HistoryFilterMode>('all');
  const [collapsedHistoryGroups, setCollapsedHistoryGroups] = useState<Record<HistoryGroupLabel, boolean>>(() => defaultHistoryGroupCollapsed('all'));
  const [historyNavigationState, setHistoryNavigationState] = useState<HistoryNavigationState | null>(null);
  const [bridgeCommands, setBridgeCommands] = useState<BridgeCommand[]>([]);
  const [screenMode, setScreenMode] = useState<ScreenMode>('hub');
  const [observerOpen, setObserverOpen] = useState(() => window.localStorage.getItem('texor.codexObserverOpen') !== 'false');
  const [observerViewMode, setObserverViewMode] = useState<ObserverViewMode>(() => window.localStorage.getItem('texor.codexObserverViewMode') === 'details' ? 'details' : 'process');
  const [sidebarPrompt, setSidebarPrompt] = useState('');
  const [composerModelMenuOpen, setComposerModelMenuOpen] = useState(false);
  const [workspaceActionsOpen, setWorkspaceActionsOpen] = useState(false);
  const [previousContextVisible, setPreviousContextVisible] = useState(() => window.localStorage.getItem('texor.previousContextVisible') !== 'false');
  const [currentContextVisible, setCurrentContextVisible] = useState(() => window.localStorage.getItem('texor.currentContextVisible') !== 'false');
  const [workspaceToolbarVisible, setWorkspaceToolbarVisible] = useState(() => window.localStorage.getItem('texor.workspaceToolbarVisible') !== 'false');
  const [projectLoaderOpen, setProjectLoaderOpen] = useState(false);
  const [previousPaneWidth, setPreviousPaneWidth] = useState(() => storedPixelWidth('texor.previousPaneWidth', 392));
  const [observerPaneWidth, setObserverPaneWidth] = useState(() => storedObserverPaneWidth());
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileNode[]>([]);
  const [activeWorkspaceFile, setActiveWorkspaceFile] = useState('');
  const [workspaceFileContent, setWorkspaceFileContent] = useState('');
  const [workspaceFileDirty, setWorkspaceFileDirty] = useState(false);
  const [workspaceCommandInput, setWorkspaceCommandInput] = useState('latexmk -pdf .texor/manuscript/main.tex');
  const [workspaceCommandResult, setWorkspaceCommandResult] = useState<WorkspaceCommandResult | null>(null);
  const [activeResizeTarget, setActiveResizeTarget] = useState<ResizeTarget | null>(null);
  const [busyState, setBusyState] = useState<string | null>(null);
  const [pendingWindowPaperId, setPendingWindowPaperId] = useState<string | null>(null);
  const [pendingWorkspaceUpdate, setPendingWorkspaceUpdate] = useState<PendingWorkspaceUpdate | null>(null);
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState<string | null>(null);
  const desktopWindowSessionKey = health?.desktop?.windowSessionKey || windowSessionKeyRef.current;
  const shortWindowSessionKey = desktopWindowSessionKey ? desktopWindowSessionKey.slice(0, 8) : '';
  const workspaceProjectKey = normalizeProjectKey(projectPath.trim() || workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath);
  const requestedPaperIdRef = useRef(requestedPaperIdFromUrl());
  const syncedCommandVersionIdsRef = useRef<Record<string, string>>({});
  const pendingVersionJumpRef = useRef<{ versionId: string; query: string; line?: number; column?: number; selectedText?: string; pageHint?: number } | null>(null);
  const activeWorkspaceVersionIdRef = useRef<string>('');
  const deferredWorkspaceUpdateVersionIdRef = useRef<string>('');
  const persistedRuntimeConfig = workspace ? runtimeConfigForSnapshot(workspace) : null;
  const draftRuntimeConfig = runtimeConfigFromCurrentState(agentBackend);
  const hasRuntimeConfigChanges = !runtimeConfigEquals(draftRuntimeConfig, persistedRuntimeConfig || draftRuntimeConfig);
  const activeRuntimeConfig = hasRuntimeConfigChanges ? draftRuntimeConfig : (persistedRuntimeConfig || draftRuntimeConfig);
  const windowSessionKey = windowSessionKeyRef.current;
  const visibleBridgeCommands = useMemo(() => {
    if (!workspaceProjectKey) {
      return bridgeCommands.filter((command) =>
        commandVisibleInScope(command, {
          windowSessionKey,
        }),
      );
    }
    return bridgeCommands.filter((command) =>
      commandVisibleInScope(command, {
        projectKey: workspaceProjectKey,
        workspace,
        windowSessionKey,
      }),
    );
  }, [bridgeCommands, workspaceProjectKey, workspace, windowSessionKey]);
  const hasActiveBridgeCommand = useMemo(
    () => visibleBridgeCommands.some((command) => commandIsActive(command)),
    [visibleBridgeCommands],
  );

  function beginWorkspaceListRequest(): number {
    workspaceListRequestSeqRef.current += 1;
    return workspaceListRequestSeqRef.current;
  }

  function isWorkspaceListRequestCurrent(requestId: number): boolean {
    return workspaceListRequestSeqRef.current === requestId;
  }

  function beginWorkspaceRequest(paperId: string, options: { focus?: boolean } = {}): number {
    if (options.focus) {
      workspaceTargetPaperIdRef.current = paperId;
    }
    const requestId = workspaceRequestSerialRef.current + 1;
    workspaceRequestSerialRef.current = requestId;
    workspaceRequestByPaperRef.current[paperId] = requestId;
    return requestId;
  }

  function isWorkspaceRequestCurrent(paperId: string, requestId: number): boolean {
    const latestRequestId = workspaceRequestByPaperRef.current[paperId];
    const targetPaperId = workspaceTargetPaperIdRef.current;
    return latestRequestId === requestId && (!targetPaperId || targetPaperId === paperId);
  }

  function markWorkspaceSnapshotApplied(paperId: string) {
    workspaceTargetPaperIdRef.current = paperId;
    const requestId = workspaceRequestSerialRef.current + 1;
    workspaceRequestSerialRef.current = requestId;
    workspaceRequestByPaperRef.current[paperId] = requestId;
  }

  function clearWorkspaceData() {
    workspaceTargetPaperIdRef.current = null;
    workspaceRequestSerialRef.current += 1;
    diffRequestSeqRef.current += 1;
    sessionReuseBarrierRef.current = {};
    activeWorkspaceVersionIdRef.current = '';
    deferredWorkspaceUpdateVersionIdRef.current = '';
    setWorkspace(null);
    setDiffPdf(null);
    setLeftVersionId('');
    setRightVersionId('');
    setCompareEntryContext(null);
    setHistoryPreviewEntryContext(null);
    setManualVersionSelection(false);
    setDraftVersionId('');
    setPendingWorkspaceUpdate(null);
  }

  function runtimeConfigFromCurrentState(selectedBackend: AgentBackend = agentBackend): WorkspaceRuntimeConfig {
    return buildWorkspaceRuntimeConfigFromState({
      agentBackend: selectedBackend,
      projectTaskSpeedMode,
      agentProvider,
      agentBaseUrl,
      agentModel,
      agentImageModel,
      agentApiKey,
      codexModel,
      codexReasoningEffort,
      claudeModel,
    });
  }

  function latestCommandForSnapshot(snapshot: WorkspaceSnapshot | null): BridgeCommand | null {
    if (!snapshot) {
      return null;
    }
    const key = normalizeProjectKey(snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath);
    const ordered = [...bridgeCommands].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return [...ordered].reverse().find((command) =>
      commandVisibleInScope(command, {
        projectKey: key,
        workspace: snapshot,
        windowSessionKey: windowSessionKeyRef.current,
      }),
    ) || null;
  }

  function runtimeConfigForSnapshot(snapshot: WorkspaceSnapshot | null): WorkspaceRuntimeConfig | null {
    if (!snapshot) {
      return null;
    }
    if (snapshot.paper.runtimeConfig?.agentBackend) {
      return snapshot.paper.runtimeConfig;
    }
    return workspaceRuntimeConfigFromCommand(latestCommandForSnapshot(snapshot));
  }

  function applyRuntimeConfigToState(runtimeConfig: WorkspaceRuntimeConfig | null | undefined) {
    if (!runtimeConfig?.agentBackend) {
      return;
    }
    setAgentBackend(runtimeConfig.agentBackend);
    if (runtimeConfig.taskSpeedMode) {
      setProjectTaskSpeedMode(runtimeConfig.taskSpeedMode);
    }
    if (runtimeConfig.texorAgent) {
      const texorConfig = normalizedTexorAgentConfig(runtimeConfig.texorAgent);
      setAgentProvider(texorConfig.provider || 'OpenAI-compatible');
      setAgentBaseUrl(texorConfig.baseUrl || 'https://api.openai.com/v1');
      setAgentModel(texorConfig.model || DEFAULT_TEXOR_AGENT_MODEL);
      setAgentImageModel(texorConfig.imageModel || 'gpt-image-1');
      setAgentApiKey(texorConfig.apiKey || '');
    }
    if (runtimeConfig.codex) {
      const codexConfig = normalizedCodexConfig(runtimeConfig.codex);
      setCodexModel(codexConfig.model);
      setCodexReasoningEffort(codexConfig.reasoningEffort);
    }
    if (runtimeConfig.claude) {
      const claudeConfig = normalizedClaudeConfig(runtimeConfig.claude);
      setClaudeModel(claudeConfig.model);
    }
  }

  function modelConfigForRuntimeConfig(runtimeConfig: WorkspaceRuntimeConfig): ModelConfig | undefined {
    if (runtimeConfig.agentBackend === 'texor-agent') {
      return normalizedTexorAgentConfig(runtimeConfig.texorAgent);
    }
    if (isCodexBackend(runtimeConfig.agentBackend)) {
      const codexConfig = normalizedCodexConfig(runtimeConfig.codex);
      return {
        model: codexConfig.model,
        reasoningEffort: codexConfig.reasoningEffort,
      };
    }
    const claudeConfig = normalizedClaudeConfig(runtimeConfig.claude);
    return claudeConfig.model ? { model: claudeConfig.model } : undefined;
  }

  function runtimeConfigValidationError(runtimeConfig: WorkspaceRuntimeConfig): string | null {
    if (runtimeConfig.agentBackend !== 'texor-agent') {
      return null;
    }
    const texorConfig = normalizedTexorAgentConfig(runtimeConfig.texorAgent);
    const localModelEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(texorConfig.baseUrl || '');
    if (!texorConfig.apiKey && !localModelEndpoint) {
      return 'TEXOR 需要模型 API Key。可以切换到本机 CLI 兼容模式，或填写 OpenAI-compatible API。';
    }
    return null;
  }

  async function persistWorkspaceRuntimeConfig(nextRuntimeConfig: WorkspaceRuntimeConfig) {
    applyRuntimeConfigToState(nextRuntimeConfig);
    if (!workspace) {
      return;
    }
    setBusyState('save-runtime-config');
    setError(null);
    try {
      const snapshot = await updateWorkspaceRuntimeConfig(workspace.paper.id, nextRuntimeConfig);
      setWorkspace((current) => current && current.paper.id === snapshot.paper.id ? { ...current, paper: snapshot.paper } : snapshot);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存模型配置失败。');
    } finally {
      setBusyState(null);
    }
  }

  function runtimeStateInput(overrides: Partial<{
    agentBackend: AgentBackend;
    projectTaskSpeedMode: TaskSpeedMode;
    agentProvider: string;
    agentBaseUrl: string;
    agentModel: string;
    agentImageModel: string;
    agentApiKey: string;
    codexModel: string;
    codexReasoningEffort: string;
    claudeModel: string;
  }> = {}) {
    return {
      agentBackend,
      projectTaskSpeedMode,
      agentProvider,
      agentBaseUrl,
      agentModel,
      agentImageModel,
      agentApiKey,
      codexModel,
      codexReasoningEffort,
      claudeModel,
      ...overrides,
    };
  }

  async function persistRuntimeConfigSelection(
    overrides: Partial<{
      agentBackend: AgentBackend;
      projectTaskSpeedMode: TaskSpeedMode;
      agentProvider: string;
      agentBaseUrl: string;
      agentModel: string;
      agentImageModel: string;
      agentApiKey: string;
      codexModel: string;
      codexReasoningEffort: string;
      claudeModel: string;
    }> = {},
  ) {
    const nextRuntimeConfig = buildWorkspaceRuntimeConfigFromState(runtimeStateInput(overrides));
    const validationError = runtimeConfigValidationError(nextRuntimeConfig);
    if (validationError) {
      setError(validationError);
      return;
    }
    await persistWorkspaceRuntimeConfig(nextRuntimeConfig);
  }

  function handleFooterInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>, commit: () => void) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  }

  useEffect(() => {
    void getHealth()
      .then(async (payload) => {
        const desktopBootstrap =
          window.texorDesktop && payload.desktop?.isDesktop
            ? await window.texorDesktop.bootstrap().catch(() => payload.desktop)
            : payload.desktop;
        const nextPayload = desktopBootstrap ? { ...payload, desktop: desktopBootstrap } : payload;
        return nextPayload;
      })
      .then((payload) => {
        setHealth(payload);
        setDesktopReady(Boolean(payload.desktop?.isDesktop || window.texorDesktop));
        setVscodeImported(Boolean(payload.desktop?.importedConfig));
        if (payload.desktop?.windowSessionKey?.trim()) {
          windowSessionKeyRef.current = payload.desktop.windowSessionKey.trim();
          window.sessionStorage.setItem('texor.windowSessionKey', payload.desktop.windowSessionKey.trim());
        }
      })
      .catch((reason: Error) => setError(reason.message));

    void refreshWorkspaceList(false);
  }, []);

  useEffect(() => {
    if (!desktopReady) {
      return;
    }
    void listSSHHosts()
      .then((hosts) => {
        setSshHosts(hosts);
        setSshHostAlias((current) => current || hosts[0]?.alias || '');
      })
      .catch(() => undefined);
  }, [desktopReady]);

  useEffect(() => {
    const refreshIntervalMs = hasActiveBridgeCommand ? WORKSPACE_REFRESH_ACTIVE_INTERVAL_MS : WORKSPACE_REFRESH_IDLE_INTERVAL_MS;
    const interval = window.setInterval(() => {
      void refreshWorkspaceList(false);
      if (!workspace) {
        return;
      }
      const paperId = workspace.paper.id;
      const requestId = beginWorkspaceRequest(paperId);
      void getWorkspace(paperId)
        .then((snapshot) => {
          if (!isWorkspaceRequestCurrent(paperId, requestId)) {
            return;
          }
          const hasNewVersion = snapshot.currentVersion.id !== workspace.currentVersion.id || snapshot.versions.length !== workspace.versions.length;
          if (
            snapshot.currentVersion.id === workspace.currentVersion.id &&
            snapshot.versions.length === workspace.versions.length &&
            snapshot.paper.codexSessionId === workspace.paper.codexSessionId
          ) {
            return;
          }
          if (
            hasNewVersion &&
            activeWorkspaceVersionIdRef.current &&
            snapshot.currentVersion.id !== activeWorkspaceVersionIdRef.current
          ) {
            if (deferredWorkspaceUpdateVersionIdRef.current === snapshot.currentVersion.id) {
              setWorkspace((current) =>
                current && current.paper.id === snapshot.paper.id
                  ? {
                      ...current,
                      paper: snapshot.paper,
                      currentVersion:
                        snapshot.versions.find((version) => version.id === current.currentVersion.id) || current.currentVersion,
                      versions: snapshot.versions,
                    }
                  : snapshot,
              );
              return;
            }
            setWorkspace((current) =>
              current && current.paper.id === snapshot.paper.id
                ? {
                    ...current,
                    paper: snapshot.paper,
                    currentVersion:
                      snapshot.versions.find((version) => version.id === current.currentVersion.id) || current.currentVersion,
                    versions: snapshot.versions,
                  }
                : snapshot,
            );
            setDraftVersionId((current) => snapshot.versions.some((version) => version.id === current) ? current : snapshot.currentVersion.id);
            setPendingWorkspaceUpdate({
              versionId: snapshot.currentVersion.id,
              label: snapshot.currentVersion.label,
              summary: versionSummaryLabel(snapshot.currentVersion),
              createdAt: snapshot.currentVersion.createdAt,
            });
            setStatus(`检测到外部更新：${snapshot.currentVersion.label}`);
            return;
          }
          applyWorkspace(snapshot, {
            keepManualComparison: !hasNewVersion,
            focusVersionChange: hasNewVersion
              ? {
                  versionId: snapshot.currentVersion.id,
                  query: inferJumpQueryFromVersion(snapshot.currentVersion),
                }
              : null,
          });
        })
        .catch(() => undefined);
    }, refreshIntervalMs);

    return () => window.clearInterval(interval);
  }, [hasActiveBridgeCommand, projectPath, screenMode, workspace]);

  useEffect(() => {
    const workspaceMode = screenMode === 'workspace';
    document.documentElement.classList.toggle('is-workspace-mode', workspaceMode);
    document.body.classList.toggle('is-workspace-mode', workspaceMode);
    return () => {
      document.documentElement.classList.remove('is-workspace-mode');
      document.body.classList.remove('is-workspace-mode');
    };
  }, [screenMode]);

  useEffect(() => {
    function refreshCommands() {
      void listBridgeCommands(undefined, {
        paperId: workspace?.paper.id,
        projectPath: projectPath.trim() || workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath,
        limit: 40,
      })
        .then((commands) => {
          setBridgeCommands(commands);
          const active = [...commands]
            .filter((command) =>
              commandVisibleInScope(command, {
                projectKey: workspaceProjectKey || undefined,
                workspace,
                windowSessionKey: windowSessionKeyRef.current,
              }),
            )
            .reverse()
            .find((command) => command.status === 'queued' || command.status === 'running');
          if (active) {
            setStatus(active.status === 'queued' ? '等待 VSCode' : 'Agent 处理中');
            return;
          }
        })
        .catch(() => undefined);
    }

    refreshCommands();
    const refreshIntervalMs = hasActiveBridgeCommand ? BRIDGE_COMMAND_REFRESH_ACTIVE_INTERVAL_MS : BRIDGE_COMMAND_REFRESH_IDLE_INTERVAL_MS;
    const interval = window.setInterval(refreshCommands, refreshIntervalMs);

    return () => window.clearInterval(interval);
  }, [hasActiveBridgeCommand, projectPath, workspace]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    const completedCommand = [...visibleBridgeCommands]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .reverse()
      .find((command) => {
        if (command.status !== 'done') {
          return false;
        }
        const savedVersionId = typeof command.result?.versionId === 'string' ? command.result.versionId : undefined;
        if (!savedVersionId) {
          return false;
        }
        const payloadPaperId = 'paperId' in command.payload ? command.payload.paperId : undefined;
        return !payloadPaperId || payloadPaperId === workspace.paper.id;
      });
    if (!completedCommand) {
      return;
    }
    const savedVersionId = typeof completedCommand.result?.versionId === 'string' ? completedCommand.result.versionId : undefined;
    if (!savedVersionId || syncedCommandVersionIdsRef.current[completedCommand.id] === savedVersionId) {
      return;
    }
    if (workspace.currentVersion.id === savedVersionId) {
      syncedCommandVersionIdsRef.current[completedCommand.id] = savedVersionId;
      return;
    }
    syncedCommandVersionIdsRef.current[completedCommand.id] = savedVersionId;
    const requestId = beginWorkspaceRequest(workspace.paper.id, { focus: true });
    void getWorkspace(workspace.paper.id)
      .then((snapshot) => {
        if (!isWorkspaceRequestCurrent(workspace.paper.id, requestId)) {
          return;
        }
        const hasNewVersion = snapshot.currentVersion.id !== workspace.currentVersion.id || snapshot.versions.length !== workspace.versions.length;
        applyWorkspace(snapshot, {
          keepManualComparison: !hasNewVersion,
          focusVersionChange: hasNewVersion
            ? {
                versionId: snapshot.currentVersion.id,
                query: inferJumpQueryFromVersion(snapshot.currentVersion),
              }
            : null,
        });
      })
      .catch(() => {
        delete syncedCommandVersionIdsRef.current[completedCommand.id];
      });
  }, [visibleBridgeCommands, workspace]);

  useEffect(() => {
    if (!workspace || workspace.paper.runtimeConfig?.agentBackend) {
      return;
    }
    const fallbackConfig = runtimeConfigForSnapshot(workspace);
    if (fallbackConfig) {
      applyRuntimeConfigToState(fallbackConfig);
      void updateWorkspaceRuntimeConfig(workspace.paper.id, fallbackConfig)
        .then((snapshot) => {
          setWorkspace((current) => current && current.paper.id === snapshot.paper.id ? { ...current, paper: snapshot.paper } : snapshot);
        })
        .catch(() => undefined);
    }
  }, [visibleBridgeCommands, workspace]);

  useEffect(() => {
    if (!workspace) {
      activeWorkspaceVersionIdRef.current = '';
      return;
    }
    activeWorkspaceVersionIdRef.current = rightVersionId || workspace.currentVersion.id;
  }, [rightVersionId, workspace]);

  useEffect(() => {
    if (!workspace || !pendingWorkspaceUpdate) {
      return;
    }
    const stillExists = workspace.versions.some((version) => version.id === pendingWorkspaceUpdate.versionId);
    if (!stillExists || activeWorkspaceVersionIdRef.current === pendingWorkspaceUpdate.versionId) {
      setPendingWorkspaceUpdate(null);
    }
  }, [pendingWorkspaceUpdate, rightVersionId, workspace]);

  useEffect(() => {
    const target = workspaceExecutionTarget(workspace, projectPath);
    if (!target) {
      setWorkspaceFiles([]);
      setActiveWorkspaceFile('');
      setWorkspaceFileContent('');
      setWorkspaceFileDirty(false);
      setWorkspaceCommandResult(null);
      return;
    }
    void listWorkspaceFiles(target)
      .then((files) => {
        setWorkspaceFiles(files);
        const firstTextFile = files.find((item) => item.kind === 'file' && isLikelyTextFile(item.path));
        setActiveWorkspaceFile((current) => {
          if (current && files.some((item) => item.path === current)) {
            return current;
          }
          return firstTextFile?.path || '';
        });
      })
      .catch(() => undefined);
  }, [projectPath, workspace]);

  useEffect(() => {
    const target = workspaceExecutionTarget(workspace, projectPath);
    if (!target || !activeWorkspaceFile) {
      if (!activeWorkspaceFile) {
        setWorkspaceFileContent('');
        setWorkspaceFileDirty(false);
      }
      return;
    }
    void readWorkspaceFile(target, activeWorkspaceFile)
      .then((file) => {
        setWorkspaceFileContent(file.content);
        setWorkspaceFileDirty(false);
      })
      .catch(() => undefined);
  }, [activeWorkspaceFile, projectPath, workspace]);

  useEffect(() => {
    const input = chatComposerRef.current;
    if (!input) {
      return;
    }
    input.style.height = '0px';
    input.style.height = `${Math.min(124, Math.max(68, input.scrollHeight))}px`;
  }, [sidebarPrompt, observerOpen]);

  useEffect(() => {
    window.localStorage.setItem('texor.codexObserverOpen', String(observerOpen));
  }, [observerOpen]);

  useEffect(() => {
    window.localStorage.setItem('texor.workspaceToolbarVisible', String(workspaceToolbarVisible));
  }, [workspaceToolbarVisible]);

  useEffect(() => {
    window.localStorage.setItem('texor.codexObserverViewMode', observerViewMode);
  }, [observerViewMode]);

  useEffect(() => {
    if (!composerModelMenuOpen) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.closest('.workspace-chat-sidebar__composer-shell')) {
        return;
      }
      setComposerModelMenuOpen(false);
    }
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [composerModelMenuOpen]);

  useEffect(() => {
    if (!workspaceActionsOpen) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.closest('.workspace-toolbar__actions-menu')) {
        return;
      }
      setWorkspaceActionsOpen(false);
    }
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [workspaceActionsOpen]);

  useEffect(() => {
    window.localStorage.setItem('texor.previousContextVisible', String(previousContextVisible));
  }, [previousContextVisible]);

  useEffect(() => {
    window.localStorage.setItem('texor.currentContextVisible', String(currentContextVisible));
  }, [currentContextVisible]);

  useEffect(() => {
    window.localStorage.setItem('texor.leftPaneOpen', String(leftPaneOpen));
  }, [leftPaneOpen]);

  useEffect(() => {
    window.localStorage.setItem('texor.previousPaneWidth', String(Math.round(previousPaneWidth)));
  }, [previousPaneWidth]);

  useEffect(() => {
    window.localStorage.setItem('texor.observerPaneWidth', String(Math.round(observerPaneWidth)));
  }, [observerPaneWidth]);

  useEffect(() => {
    window.localStorage.setItem('texor.agentBackend', agentBackend);
    window.localStorage.setItem('texor.agentProvider', agentProvider);
    window.localStorage.setItem('texor.agentBaseUrl', agentBaseUrl);
    window.localStorage.setItem('texor.agentModel', agentModel);
    window.localStorage.setItem('texor.agentImageModel', agentImageModel);
    window.localStorage.setItem('texor.agentApiKey', agentApiKey);
    window.localStorage.setItem('texor.codexModel', codexModel);
    window.localStorage.setItem('texor.codexReasoningEffort', codexReasoningEffort);
    window.localStorage.setItem('texor.claudeModel', claudeModel);
  }, [agentBackend, agentProvider, agentBaseUrl, agentModel, agentImageModel, agentApiKey, codexModel, codexReasoningEffort, claudeModel]);

  useEffect(() => {
    window.localStorage.setItem('texor.projectTaskSpeedMode', projectTaskSpeedMode);
  }, [projectTaskSpeedMode]);

  useEffect(() => {
    window.localStorage.setItem('texor.nativeTaskIntent', nativeTaskIntent);
  }, [nativeTaskIntent]);

  useEffect(() => {
    if (!projectLoaderOpen) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setProjectLoaderOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projectLoaderOpen]);

  useEffect(() => {
    if (!draftOpen) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setDraftOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draftOpen]);

  useEffect(() => {
    if (!draftOpen) {
      setHistoryFilterMode('all');
      setCollapsedHistoryGroups(defaultHistoryGroupCollapsed('all'));
      setHistoryNavigationState(null);
    }
  }, [draftOpen]);

  useEffect(() => {
    if (!draftOpen) {
      return;
    }
    setCollapsedHistoryGroups(defaultHistoryGroupCollapsed(historyFilterMode));
  }, [draftOpen, historyFilterMode]);

  useEffect(() => {
    function syncResizableWidths() {
      if (!isDesktopResizableLayout()) {
        return;
      }
      const compareWidth = pdfCompareRef.current?.clientWidth || 0;
      if (compareWidth > 0) {
        setPreviousPaneWidth((current) => clampPreviousPaneWidth(current, compareWidth));
      }
      const canvasWidth = workspaceCanvasRef.current?.clientWidth || 0;
      if (canvasWidth > 0) {
        setObserverPaneWidth((current) => clampObserverPaneWidth(current, canvasWidth));
      }
    }

    syncResizableWidths();
    const compareElement = pdfCompareRef.current;
    const canvasElement = workspaceCanvasRef.current;
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          syncResizableWidths();
        })
      : null;
    if (resizeObserver) {
      if (compareElement) {
        resizeObserver.observe(compareElement);
      }
      if (canvasElement) {
        resizeObserver.observe(canvasElement);
      }
    }
    window.addEventListener('resize', syncResizableWidths);
    return () => {
      window.removeEventListener('resize', syncResizableWidths);
      resizeObserver?.disconnect();
    };
  }, [observerOpen, screenMode]);

  useEffect(() => {
    if (!activeResizeTarget) {
      return undefined;
    }

    function handlePointerMove(event: PointerEvent) {
      const resizeState = resizeStateRef.current;
      if (!resizeState) {
        return;
      }
      if (activeResizeTarget === 'previous-pane') {
        const compareWidth = pdfCompareRef.current?.clientWidth || 0;
        if (compareWidth <= 0) {
          return;
        }
        const nextWidth = clampPreviousPaneWidth(resizeState.startWidth + (event.clientX - resizeState.startX), compareWidth);
        setPreviousPaneWidth(nextWidth);
        return;
      }
      const canvasWidth = workspaceCanvasRef.current?.clientWidth || 0;
      if (canvasWidth <= 0) {
        return;
      }
      const nextWidth = clampObserverPaneWidth(resizeState.startWidth - (event.clientX - resizeState.startX), canvasWidth);
      setObserverPaneWidth(nextWidth);
    }

    function finishResize() {
      resizeStateRef.current = null;
      setActiveResizeTarget(null);
      document.body.classList.remove('is-resizing-columns');
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      document.body.classList.remove('is-resizing-columns');
    };
  }, [activeResizeTarget]);

  useEffect(() => {
    const query = targetJournal.trim();
    const selectedLabel = selectedTemplate?.label || '';
    if (selectedLabel && query !== selectedLabel) {
      setSelectedTemplate(null);
      setTemplateStatus(null);
    }
    if (query.length < 2) {
      setTemplateSuggestions([]);
      return;
    }

    const requestId = window.setTimeout(() => {
      void searchTemplates(query)
        .then((results) => {
          setTemplateSuggestions(results);
          setSuggestionsOpen(results.length > 0);
        })
        .catch(() => setTemplateSuggestions([]));
    }, 120);

    return () => window.clearTimeout(requestId);
  }, [targetJournal, selectedTemplate?.label]);

  function defaultComparison(snapshot: WorkspaceSnapshot): { left: string; right: string } {
    const right = snapshot.currentVersion.id;
    const currentVersion = snapshot.versions.find((version) => version.id === right) || snapshot.currentVersion;
    const left = currentVersion.basedOnVersionId && snapshot.versions.some((version) => version.id === currentVersion.basedOnVersionId)
      ? currentVersion.basedOnVersionId
      : '';
    return { left, right };
  }

  function applyWorkspace(
    snapshot: WorkspaceSnapshot,
    options: { keepManualComparison?: boolean; focusVersionChange?: { versionId: string; query?: string } | null } = {},
  ) {
    markWorkspaceSnapshotApplied(snapshot.paper.id);
    persistLastWorkspacePreference(snapshot);
    setWorkspace(snapshot);
    applyRuntimeConfigToState(runtimeConfigForSnapshot(snapshot));
    setTargetJournal(snapshot.paper.targetJournal);
    setProjectPath(snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath || '');
    setTexPath(sourcePathForVersion(snapshot, snapshot.currentVersion) || '');
    setDraftVersionId((current) => snapshot.versions.some((version) => version.id === current) ? current : snapshot.currentVersion.id);
    setDraftFocusQuery('');
    setDraftOpen(false);
    setStatus(snapshot.currentVersion.label);
    const nextComparison = options.keepManualComparison
      ? { left: leftVersionId, right: snapshot.currentVersion.id }
      : defaultComparison(snapshot);
    if (!options.keepManualComparison) {
      setManualVersionSelection(false);
    }
    setLeftVersionId(nextComparison.left);
    setRightVersionId(nextComparison.right);
    setCompareEntryContext((current) => compareEntryContextMatches(current, snapshot.paper.id, nextComparison.left, nextComparison.right) ? current : null);
    activeWorkspaceVersionIdRef.current = nextComparison.right;
    deferredWorkspaceUpdateVersionIdRef.current = '';
    setPendingWorkspaceUpdate((current) => current?.versionId === nextComparison.right ? null : current);
    if (options.focusVersionChange?.versionId) {
      const focusVersion = snapshot.versions.find((version) => version.id === options.focusVersionChange?.versionId);
      pendingVersionJumpRef.current = {
        versionId: options.focusVersionChange.versionId,
        query: options.focusVersionChange.query || '',
        line: focusVersion?.focusTarget?.sourceLine,
        column: focusVersion?.focusTarget?.sourceColumn,
        selectedText: focusVersion?.focusTarget?.selectedText,
        pageHint: focusVersion?.focusTarget?.pageHint,
      };
    } else if (!options.keepManualComparison) {
      pendingVersionJumpRef.current = null;
    }
    void refreshDiffPdf(snapshot, nextComparison.left, nextComparison.right);
  }

  async function ensureSelectedTemplateForUse(): Promise<void> {
    if (!selectedTemplate) {
      return;
    }
    if (selectedTemplate.cached || templateStatus?.status === 'cached' || templateStatus?.status === 'downloaded') {
      return;
    }
    if (templateDownloadingId === selectedTemplate.id) {
      return;
    }

    setTemplateDownloadingId(selectedTemplate.id);
    setStatus('首次使用，下载模板');
    setTemplateStatus({
      ok: false,
      id: selectedTemplate.id,
      status: 'failed',
      message: '首次使用，正在下载模板...',
      sourceUrl: selectedTemplate.sourceUrl,
      officialPage: selectedTemplate.officialPage,
    });
    try {
      const result = await ensureTemplate(selectedTemplate.id);
      setTemplateStatus(result);
      if (result.ok) {
        setTemplateSuggestions((items) =>
          items.map((item) => (item.id === selectedTemplate.id ? { ...item, cached: true, localPath: result.localPath || item.localPath } : item)),
        );
        setSelectedTemplate((item) => (item && item.id === selectedTemplate.id ? { ...item, cached: true, localPath: result.localPath || item.localPath } : item));
        setStatus(result.status === 'downloaded' ? '模板已下载' : '模板已缓存');
        return;
      }

      setStatus(result.status === 'manual-required' ? '模板需手动获取' : '模板下载失败');
    } finally {
      setTemplateDownloadingId(null);
    }
  }

  async function refreshWorkspaceList(openLatest: boolean) {
    const listRequestId = beginWorkspaceListRequest();
    try {
      const summaries = await listWorkspaces();
      if (!isWorkspaceListRequestCurrent(listRequestId)) {
        return;
      }
      setWorkspaceList(summaries);
      const requestedPaperId = requestedPaperIdRef.current;
      if (requestedPaperId && !workspace) {
        const requestedSummary = summaries.find((item) => item.paperId === requestedPaperId);
        if (requestedSummary) {
          const requestId = beginWorkspaceRequest(requestedSummary.paperId, { focus: true });
          const snapshot = await getWorkspace(requestedSummary.paperId);
          if (!isWorkspaceListRequestCurrent(listRequestId) || !isWorkspaceRequestCurrent(requestedSummary.paperId, requestId)) {
            return;
          }
          requestedPaperIdRef.current = '';
          applyWorkspace(snapshot);
          setScreenMode('workspace');
          return;
        }
      }
      if (!workspace && !requestedPaperIdRef.current && !startupWorkspaceRestoreAttemptedRef.current) {
        startupWorkspaceRestoreAttemptedRef.current = true;
        const lastWorkspace = readLastWorkspacePreference();
        const lastProjectKey = normalizeProjectKey(lastWorkspace.projectRoot);
        const lastSummary = summaries.find((item) => item.paperId === lastWorkspace.paperId)
          || summaries.find((item) => normalizeProjectKey(item.projectRoot) === lastProjectKey);
        if (lastSummary) {
          const requestId = beginWorkspaceRequest(lastSummary.paperId, { focus: true });
          const snapshot = await getWorkspace(lastSummary.paperId);
          if (!isWorkspaceListRequestCurrent(listRequestId) || !isWorkspaceRequestCurrent(lastSummary.paperId, requestId)) {
            return;
          }
          applyWorkspace(snapshot);
          setScreenMode('workspace');
          return;
        }
      }
      const activeProjectKeys = new Set(summaries.map((item) => normalizeProjectKey(item.projectRoot)).filter(Boolean));
      Object.keys(sessionReuseBarrierRef.current).forEach((key) => {
        if (!activeProjectKeys.has(key)) {
          delete sessionReuseBarrierRef.current[key];
        }
      });
      if (!workspace && screenMode === 'workspace') {
        const activeProjectKey = normalizeProjectKey(projectPath);
        const matching = summaries.find((item) => normalizeProjectKey(item.projectRoot) === activeProjectKey);
        if (matching) {
          const requestId = beginWorkspaceRequest(matching.paperId, { focus: true });
          const snapshot = await getWorkspace(matching.paperId);
          if (!isWorkspaceListRequestCurrent(listRequestId) || !isWorkspaceRequestCurrent(matching.paperId, requestId)) {
            return;
          }
          applyWorkspace(snapshot);
          return;
        }
      }
      if (!openLatest || workspace || summaries.length === 0) {
        return;
      }
      const requestId = beginWorkspaceRequest(summaries[0].paperId, { focus: true });
      const snapshot = await getWorkspace(summaries[0].paperId);
      if (!isWorkspaceListRequestCurrent(listRequestId) || !isWorkspaceRequestCurrent(summaries[0].paperId, requestId)) {
        return;
      }
      applyWorkspace(snapshot);
    } catch {
      if (openLatest && isWorkspaceListRequestCurrent(listRequestId)) {
        clearWorkspaceData();
      }
    }
  }

  async function openWorkspace(paperId: string) {
    setBusyState('open-workspace');
    setError(null);
    try {
      const requestId = beginWorkspaceRequest(paperId, { focus: true });
      const snapshot = await getWorkspace(paperId);
      if (!isWorkspaceRequestCurrent(paperId, requestId)) {
        return;
      }
      applyWorkspace(snapshot);
      setScreenMode('workspace');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '打开项目失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function openWorkspaceInNewWindow(paperId?: string) {
    setError(null);
    setPendingWindowPaperId(paperId || '__blank__');
    if (window.texorDesktop) {
      try {
        setBusyState('open-workspace-window');
        await window.texorDesktop.openWindow(paperId);
        setStatus(paperId ? '已在新窗口打开稿库' : '已新建桌面窗口');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '在新窗口打开失败。');
      } finally {
        setBusyState(null);
        setPendingWindowPaperId(null);
      }
      return;
    }
    if (typeof window === 'undefined') {
      setPendingWindowPaperId(null);
      return;
    }
    try {
      const url = new URL(window.location.href);
      if (paperId) {
        url.searchParams.set('paperId', paperId);
      } else {
        url.searchParams.delete('paperId');
      }
      url.searchParams.set('windowSessionKey', crypto.randomUUID());
      const opened = window.open(url.toString(), '_blank', 'noopener,noreferrer');
      if (!opened) {
        throw new Error('浏览器阻止了新窗口，请允许弹窗后重试。');
      }
      setStatus(paperId ? '已在新标签页打开稿库' : '已新建标签页');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '在新窗口打开失败。');
    } finally {
      setPendingWindowPaperId(null);
    }
  }

  function handleHubCardPointerDown(
    paperId: string,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 1) {
      return;
    }
    event.preventDefault();
    void openWorkspaceInNewWindow(paperId);
  }

  function handleHubCardOpen(
    paperId: string,
    event?: Pick<MouseEvent | ReactKeyboardEvent<HTMLElement>, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  ) {
    const shouldOpenNewWindow = Boolean(desktopReady && event && (event.metaKey || event.ctrlKey || event.shiftKey));
    if (shouldOpenNewWindow) {
      void openWorkspaceInNewWindow(paperId);
      return;
    }
    void openWorkspace(paperId);
  }

  async function importDesktopVSCodeSettings() {
    setBusyState('import-vscode-config');
    setError(null);
    try {
      const bootstrap = await importVSCodeConfig();
      const refreshedBootstrap = window.texorDesktop ? await window.texorDesktop.bootstrap().catch(() => bootstrap) : bootstrap;
      setHealth((current) => current ? { ...current, desktop: refreshedBootstrap } : { ok: true, sampleProjectPath: null, desktop: refreshedBootstrap });
      setVscodeImported(Boolean(bootstrap.importedConfig));
      if (refreshedBootstrap.windowSessionKey?.trim()) {
        windowSessionKeyRef.current = refreshedBootstrap.windowSessionKey.trim();
        window.sessionStorage.setItem('texor.windowSessionKey', refreshedBootstrap.windowSessionKey.trim());
      }
      setStatus(bootstrap.importedConfig ? '已导入 VS Code 配置' : '未找到可导入的 VS Code 配置');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入 VS Code 配置失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function prepareCurrentExecutionTarget(): Promise<DesktopPreparedTarget | null> {
    const localRoot = projectPath.trim();
    const remoteRoot = remoteProjectPath.trim();
    const nextTarget: ProjectExecutionTarget =
      connectionMode === 'ssh'
        ? {
            kind: 'ssh',
            hostAlias: sshHostAlias.trim(),
            remoteRoot,
          }
        : {
            kind: 'local',
            rootPath: localRoot,
          };
    if (nextTarget.kind === 'local' && !nextTarget.rootPath) {
      setError('请输入本地项目路径。');
      return null;
    }
    if (nextTarget.kind === 'ssh' && (!nextTarget.hostAlias || !nextTarget.remoteRoot)) {
      setError('请选择 SSH 主机并输入远端项目路径。');
      return null;
    }

    setBusyState('prepare-project');
    setError(null);
    try {
      const prepared = await prepareDesktopProject({ target: nextTarget });
      setPreparedTarget(prepared);
      setProjectPath(prepared.effectiveRootPath);
      if (prepared.target.kind === 'ssh') {
        setRemoteProjectPath(prepared.target.remoteRoot);
      }
      setStatus(prepared.target.kind === 'ssh' ? `已连接 ${prepared.displayLabel}` : '本地项目已准备');
      return prepared;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '准备项目失败。');
      return null;
    } finally {
      setBusyState(null);
    }
  }

  async function saveActiveWorkspaceFile() {
    const target = workspaceExecutionTarget(workspace, projectPath);
    if (!target || !activeWorkspaceFile) {
      return;
    }
    setBusyState('save-workspace-file');
    setError(null);
    try {
      await writeWorkspaceFile(target, activeWorkspaceFile, workspaceFileContent);
      setWorkspaceFileDirty(false);
      setStatus(`已保存 ${activeWorkspaceFile}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存文件失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function runActiveWorkspaceCommand() {
    const target = workspaceExecutionTarget(workspace, projectPath);
    if (!target || !workspaceCommandInput.trim()) {
      return;
    }
    setBusyState('workspace-command');
    setError(null);
    try {
      const result = await runWorkspaceCommand(target, workspaceCommandInput.trim(), projectPath.trim() || undefined);
      setWorkspaceCommandResult(result);
      setStatus(result.ok ? '命令执行完成' : '命令执行失败');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '运行命令失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function removeWorkspace(item: WorkspaceSummary) {
    const label = item.projectRoot || item.title;
    const confirmed = window.confirm(`删除项目库中的 ${label}？这会移除该项目在 texor 中保存的论文版本、反馈和 Agent 任务记录，不会删除你的源码目录或 .tex 文件。`);
    if (!confirmed) {
      return;
    }

    setBusyState('delete-workspace');
    setError(null);
    try {
      const result = await deleteWorkspace(item.paperId);
      if (result.deletedPaperIds.includes(readLastWorkspacePreference().paperId || '')) {
        clearLastWorkspacePreference(readLastWorkspacePreference().paperId);
      }
      setWorkspaceList(result.workspaces);
      if (workspace?.paper.id === item.paperId || result.deletedPaperIds.includes(workspace?.paper.id || '')) {
        clearWorkspaceData();
        setProjectPath('');
        setTexPath('');
        setStatus('Ready');
        setScreenMode('hub');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除项目失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function refreshDiffPdf(snapshot = workspace, leftId = leftVersionId, rightId = rightVersionId) {
    if (!snapshot) {
      return;
    }
    const fallback = defaultComparison(snapshot);
    const currentId = rightId || fallback.right;
    const previousId = leftId || fallback.left || undefined;
    const requestId = diffRequestSeqRef.current + 1;
    diffRequestSeqRef.current = requestId;
    try {
      const compiled = await compileDiff(snapshot.paper.id, currentId, previousId);
      if (diffRequestSeqRef.current !== requestId) {
        return;
      }
      setDiffPdf(compiled);
      if (!compiled.ok) {
        setError(diffCompileFailureMessage(compiled));
      } else if (error?.startsWith('PDF 编译失败')) {
        setError(null);
      }
    } catch (reason) {
      if (diffRequestSeqRef.current !== requestId) {
        return;
      }
      const message = reason instanceof Error ? reason.message : 'Diff 编译请求失败。';
      setDiffPdf(null);
      setError(message);
    }
  }

  function selectComparison(side: 'left' | 'right', versionId: string) {
    setManualVersionSelection(true);
    const nextLeft = side === 'left' ? versionId : leftVersionId;
    const nextRight = side === 'right' ? versionId : rightVersionId;
    setCompareEntryContext(null);
    if (side === 'left') {
      setLeftVersionId(versionId);
    } else {
      setRightVersionId(versionId);
    }
    if (workspace) {
      void refreshDiffPdf(workspace, nextLeft, nextRight);
    }
  }

  function resetComparison() {
    if (!workspace) {
      return;
    }
    const next = defaultComparison(workspace);
    setCompareEntryContext(null);
    setManualVersionSelection(false);
    setLeftVersionId(next.left);
    setRightVersionId(next.right);
    void refreshDiffPdf(workspace, next.left, next.right);
  }

  function openVersionInHistory(versionId: string, focusQuery = '', entrySource: HistoryPreviewEntrySource | null = null) {
    if (!workspace || !workspace.versions.some((version) => version.id === versionId)) {
      return;
    }
    const targetVersion = workspace.versions.find((version) => version.id === versionId);
    const highlightedVersionIds = versionLineageTrail(targetVersion, workspace.versions).map((version) => version.id);
    setHistoryFilterMode('all');
    setCollapsedHistoryGroups(defaultHistoryGroupCollapsed('all'));
    setHistoryNavigationState({
      targetVersionId: versionId,
      highlightedVersionIds,
    });
    setDraftVersionId(versionId);
    setDraftFocusQuery(focusQuery.trim());
    setHistoryPreviewEntryContext(entrySource
      ? {
          ...entrySource,
          paperId: workspace.paper.id,
          versionId,
        }
      : null);
    setDraftOpen(true);
  }

  function openVersionCompare(previousVersionId: string, currentVersionId: string, focusQuery = '', entrySource: CompareEntrySource | null = null) {
    if (!workspace) {
      return;
    }
    if (!workspace.versions.some((version) => version.id === previousVersionId) || !workspace.versions.some((version) => version.id === currentVersionId)) {
      return;
    }
    setCompareEntryContext(entrySource
      ? {
          ...entrySource,
          paperId: workspace.paper.id,
          referenceVersionId: previousVersionId,
          focusVersionId: currentVersionId,
        }
      : null);
    if (focusQuery.trim()) {
      openCompareWithFocusQuery(workspace, previousVersionId, currentVersionId, focusQuery.trim(), {
        setDraftOpen,
        setDraftFocusQuery,
        setHistoryNavigationState,
        setLeftPaneMode,
        setLeftPaneOpen,
        setManualVersionSelection,
        setLeftVersionId,
        setRightVersionId,
        refreshDiffPdf,
        pendingVersionJumpRef,
      });
      return;
    }
    setDraftOpen(false);
    setDraftFocusQuery('');
    setHistoryNavigationState(null);
    setLeftPaneMode('previous');
    setLeftPaneOpen(true);
    setManualVersionSelection(true);
    setLeftVersionId(previousVersionId);
    setRightVersionId(currentVersionId);
    void refreshDiffPdf(workspace, previousVersionId, currentVersionId);
  }

  function compareHistoryPathVersion(versionId: string) {
    if (!workspace || !historyNavigationState?.targetVersionId) {
      return;
    }
    setDraftVersionId(versionId);
    setHistoryPreviewEntryContext(null);
    openVersionCompare(versionId, historyNavigationState.targetVersionId);
  }

  function previewVersionFromHistory(version: PaperVersion) {
    if (!workspace) {
      return;
    }
    setHistoryNavigationState(null);
    setDraftVersionId(version.id);
    setDraftFocusQuery('');
    setCompareEntryContext(null);
    setHistoryPreviewEntryContext(null);
    if (version.id === workspace.currentVersion.id) {
      setManualVersionSelection(false);
      setLeftVersionId(defaultComparison(workspace).left);
      setRightVersionId(workspace.currentVersion.id);
      return;
    }
    const compareTarget = historyCompareTargetVersion(workspace, rightVersion, version);
    if (!compareTarget) {
      return;
    }
    setLeftPaneMode('previous');
    setLeftPaneOpen(true);
    setManualVersionSelection(true);
    setLeftVersionId(version.id);
    setRightVersionId(compareTarget.id);
    void refreshDiffPdf(workspace, version.id, compareTarget.id);
  }

  async function followPendingWorkspaceUpdate() {
    if (!workspace || !pendingWorkspaceUpdate) {
      return;
    }
    setBusyState('sync-external-version');
    setError(null);
    try {
      const snapshot = await getWorkspace(workspace.paper.id);
      const targetVersion = snapshot.versions.find((version) => version.id === pendingWorkspaceUpdate.versionId) || snapshot.currentVersion;
      const hasNewVersion = snapshot.currentVersion.id !== workspace.currentVersion.id || snapshot.versions.length !== workspace.versions.length;
      deferredWorkspaceUpdateVersionIdRef.current = '';
      applyWorkspace(snapshot, {
        keepManualComparison: !hasNewVersion,
        focusVersionChange: {
          versionId: targetVersion.id,
          query: inferJumpQueryFromVersion(targetVersion),
        },
      });
      setStatus(`已跟进 ${targetVersion.label}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '同步外部版本失败。');
    } finally {
      setBusyState(null);
    }
  }

  function deferPendingWorkspaceUpdate() {
    if (!pendingWorkspaceUpdate) {
      return;
    }
    deferredWorkspaceUpdateVersionIdRef.current = pendingWorkspaceUpdate.versionId;
    setPendingWorkspaceUpdate(null);
    setStatus(`已暂存 ${pendingWorkspaceUpdate.label}，稍后可从历史中查看`);
  }

  async function restoreVersionAsCurrent(versionId: string, summary?: string) {
    if (!workspace) {
      return;
    }
    setBusyState('restore-version');
    setError(null);
    try {
      const snapshot = await restoreWorkspaceVersion(workspace.paper.id, versionId, summary);
      applyWorkspace(snapshot);
      const projectKey = normalizeProjectKey(snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath);
      if (projectKey) {
        sessionReuseBarrierRef.current[projectKey] = new Date().toISOString();
      }
      void refreshWorkspaceList(false);
      setDraftOpen(false);
      setObserverOpen(true);
      setStatus(`已恢复到 ${snapshot.currentVersion.label}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '恢复版本失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function submitWorkspaceTask(
    payload: { issue?: string; changeRequest: string; taskSpeedMode: TaskSpeedMode },
    options: { annotation?: AnnotationTarget | null; source?: 'annotation' | 'browser' } = {},
  ) {
    const activeAnnotation = options.annotation || null;
    const activeVersionId = rightVersion?.id || workspace?.currentVersion.id;
    const rootPath = workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath || projectPath.trim();
    if (!rootPath) {
      setError('请先填写源库路径。这里应当是代码、实验脚本与结果文件所在目录，不是 TEXOR 开发目录，也不是单个 .tex 文件路径。');
      return;
    }
    setBusyState('feedback');
    setError(null);
    try {
      const workspaceRuntimeConfig = activeRuntimeConfig;
      const effectiveRuntimeConfig: WorkspaceRuntimeConfig = {
        ...workspaceRuntimeConfig,
        taskSpeedMode: payload.taskSpeedMode,
      };
      const validationError = runtimeConfigValidationError(effectiveRuntimeConfig);
      if (validationError) {
        setError(validationError);
        return;
      }
      const effectiveBackend = effectiveRuntimeConfig.agentBackend;
      const effectiveModelConfig = modelConfigForRuntimeConfig(effectiveRuntimeConfig);
      const effectiveSessionId = sessionIdForProject(rootPath, effectiveBackend);
      const continuedFromCommandId = continuedCommandIdForProject(rootPath, effectiveBackend, effectiveSessionId);
      const nativeIntent = effectiveBackend === 'codex-native'
        ? (activeAnnotation ? 'edit' : nativeTaskIntent === 'auto' ? defaultNativeTaskIntent(activeAnnotation, payload.changeRequest) : nativeTaskIntent)
        : undefined;
      await finalizeBlockingCommandIfNeeded();
      if (workspace && activeVersionId && effectiveBackend !== 'codex-native' && looksLikeScopedQuickRevision(payload, activeAnnotation)) {
        const annotationColumn = activeAnnotation?.column;
        const targetBlock = textBlockForQuickRevision(workspace, activeAnnotation);
        const result = await applyRevision(workspace.paper.id, {
          paperId: workspace.paper.id,
          versionId: activeVersionId,
          targetBlockId: targetBlock?.id || activeAnnotation?.blockId || 'pdf-selection',
          selectedText: activeAnnotation?.selectedText,
          sourceFile: activeAnnotation?.sourceFile,
          sourceLine: activeAnnotation?.sourceLine,
          sourceColumn: annotationColumn,
          sourceSnippet: activeAnnotation?.sourceSnippet,
          issue: payload.issue || 'PDF selection revision',
          changeRequest: payload.changeRequest,
          modelConfig: effectiveModelConfig,
        });
        const timestamp = new Date().toISOString();
        const localCommand: BridgeCommand = {
          id: crypto.randomUUID(),
          type: 'codex-task',
          payload: {
            projectPath: rootPath,
            targetJournal: resolveTargetJournal(targetJournal, workspace.paper.targetJournal),
            taskSpeedMode: payload.taskSpeedMode,
            agentBackend: effectiveBackend,
            modelConfig: effectiveModelConfig,
            instruction: activeAnnotation
              ? `${payload.issue || 'PDF selection revision'}\n\n${payload.changeRequest}`
              : payload.changeRequest,
            paperId: workspace.paper.id,
            versionId: activeVersionId,
            baseVersionId: activeVersionId,
            focusVersionId: rightVersion?.id || activeVersionId,
            selectedText: activeAnnotation?.selectedText,
            sourceFile: activeAnnotation?.sourceFile,
            sourceLine: activeAnnotation?.sourceLine,
            sourceColumn: annotationColumn,
            sourceSnippet: activeAnnotation?.sourceSnippet,
            source: options.source || (activeAnnotation ? 'annotation' : 'browser'),
            taskIntent: nativeIntent,
          },
          status: 'done',
          phase: 'complete',
          message: `已快速保存 ${result.snapshot.currentVersion.label}`,
          logs: [
            localBridgeLog('system', '浏览器快速通道已命中，跳过外部 Agent 会话。'),
            localBridgeLog('system', `结构化修订路径：${result.route || 'quick-local'}`),
            localBridgeLog('system', result.diffSummary),
          ],
          result: {
            mode: result.mode,
            route: result.route,
            paperId: result.snapshot.paper.id,
            versionId: result.snapshot.currentVersion.id,
            label: result.snapshot.currentVersion.label,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        setBridgeCommands((current) => [...current, localCommand].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
        applyWorkspace(result.snapshot, {
          focusVersionChange: {
            versionId: result.snapshot.currentVersion.id,
            query: inferJumpQueryFromVersion(result.snapshot.currentVersion),
          },
        });
        void refreshWorkspaceList(false);
        setObserverOpen(true);
        setObserverViewMode('process');
        setDraftOpen(false);
        setDraftFocusQuery('');
        setStatus(`已快速保存 ${result.snapshot.currentVersion.label}`);
        if (activeAnnotation) {
          setAnnotationTarget(null);
          setPdfSelectionClearSignal((signal) => signal + 1);
          window.getSelection()?.removeAllRanges();
        }
        return;
      }
      if (workspace && activeVersionId && activeAnnotation) {
        const annotationColumn = activeAnnotation.column;
        await submitCodexFeedback({
          paperId: workspace.paper.id,
          versionId: activeVersionId,
          targetBlockId: activeAnnotation.blockId,
          selectedText: activeAnnotation.selectedText,
          sourceFile: activeAnnotation.sourceFile,
          sourceLine: activeAnnotation.sourceLine,
          sourceColumn: annotationColumn,
          sourceSnippet: activeAnnotation.sourceSnippet,
          issue: payload.issue || 'PDF selection revision',
          changeRequest: payload.changeRequest,
          taskSpeedMode: payload.taskSpeedMode,
          source: 'texor-web',
        });
      }
      const command = await createBridgeCommand('codex-task', {
        projectPath: rootPath,
        targetJournal: resolveTargetJournal(targetJournal, workspace?.paper.targetJournal),
        taskSpeedMode: payload.taskSpeedMode,
        agentBackend: effectiveBackend,
        modelConfig: effectiveModelConfig,
        instruction: activeAnnotation
          ? `${payload.issue || 'PDF selection revision'}\n\n${payload.changeRequest}`
          : payload.changeRequest,
        paperId: workspace?.paper.id,
        versionId: activeVersionId,
        baseVersionId: activeVersionId,
        focusVersionId: rightVersion?.id || activeVersionId,
        selectedText: activeAnnotation?.selectedText,
        sourceFile: activeAnnotation?.sourceFile,
        sourceLine: activeAnnotation?.sourceLine,
        sourceColumn: activeAnnotation?.column,
        sourceSnippet: activeAnnotation?.sourceSnippet,
        source: options.source || (activeAnnotation ? 'annotation' : 'browser'),
        taskIntent: nativeIntent,
        windowSessionKey: effectiveBackend === 'codex-native' ? windowSessionKeyRef.current : undefined,
        resumeSessionId: effectiveSessionId,
        continuedFromCommandId,
      });
      setBridgeCommands((current) => {
        const filtered = current.filter((entry) => entry.id !== command.id);
        return [...filtered, command].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      });
      setObserverOpen(true);
      setObserverViewMode('process');
      setDraftOpen(false);
      setDraftFocusQuery('');
      setStatus('已发送给 TEXOR');
      if (activeAnnotation) {
        setAnnotationTarget(null);
        setPdfSelectionClearSignal((signal) => signal + 1);
        window.getSelection()?.removeAllRanges();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务发送失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function handleRevision(payload: { issue: string; changeRequest: string; taskSpeedMode: TaskSpeedMode }) {
    if (!annotationTarget) {
      return;
    }
    await submitWorkspaceTask(payload, {
      annotation: annotationTarget,
      source: 'annotation',
    });
  }

  async function handleSidebarPromptSubmit() {
    const request = sidebarPrompt.trim();
    if (!request) {
      return;
    }
    chatStickToBottomRef.current = true;
    await submitWorkspaceTask({
      changeRequest: request,
      taskSpeedMode: projectTaskSpeedMode,
    }, {
      annotation: annotationTarget,
      source: annotationTarget ? 'annotation' : 'browser',
    });
    setSidebarPrompt('');
  }

  function handleSidebarPromptKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSidebarPromptSubmit();
    }
  }

  function sidebarComposerModelPill(): string {
    if (isCodexBackend(agentBackend)) {
      return displayCodexModelToken(codexModel);
    }
    if (agentBackend === 'claude-code') {
      return compactModelLabel(claudeModel || 'Claude');
    }
    return compactModelLabel(agentModel || DEFAULT_TEXOR_AGENT_MODEL);
  }

  function sidebarComposerMetaLabel(): string {
    return `${taskSpeedModeLabel(projectTaskSpeedMode)} · ${sidebarComposerModelPill()}`;
  }

  async function startProjectWithCodex(mode = projectMode) {
    const rootPath = projectPath.trim();
    if (!rootPath) {
      setError('请输入源库路径。');
      return;
    }

    const journal = resolveTargetJournal(targetJournal);
    const importSourcePath = texPath.trim();
    const manuscriptPath = canonicalManuscriptPath(rootPath);
    const normalizedRootPath = normalizeProjectKey(rootPath);

    setBusyState(mode === 'new' ? 'new-project' : 'load-project');
    setError(null);
    try {
      await finalizeBlockingCommandIfNeeded();
      if (activeRuntimeConfig.agentBackend !== 'codex-native') {
        await ensureSelectedTemplateForUse();
      }
      let workingSnapshot =
        workspace && normalizeProjectKey(workspace.paper.projectRoot || workspace.paper.analysis?.rootPath) === normalizedRootPath
          ? workspace
          : null;

      if (!workingSnapshot) {
        const matchedSummary = workspaceList.find((item) => normalizeProjectKey(item.projectRoot) === normalizedRootPath);
        if (matchedSummary) {
          const requestId = beginWorkspaceRequest(matchedSummary.paperId, { focus: true });
          workingSnapshot = await getWorkspace(matchedSummary.paperId).catch(() => null);
          if (workingSnapshot) {
            if (!isWorkspaceRequestCurrent(matchedSummary.paperId, requestId)) {
              return;
            }
            applyWorkspace(workingSnapshot);
          }
        }
        if (!workingSnapshot) {
          workingSnapshot = await openWorkspaceFromProjectRoot(rootPath).catch(() => null);
          if (workingSnapshot) {
            applyWorkspace(workingSnapshot);
            void refreshWorkspaceList(false);
          }
        }
      }

      const effectiveRuntimeConfig = activeRuntimeConfig;
      const validationError = runtimeConfigValidationError(effectiveRuntimeConfig);
      if (validationError) {
        setError(validationError);
        return;
      }
      const effectiveBackend = effectiveRuntimeConfig.agentBackend;
      const effectiveModelConfig = modelConfigForRuntimeConfig(effectiveRuntimeConfig);
      const nativeMode = effectiveBackend === 'codex-native';

      if (mode === 'load' && !workingSnapshot && !importSourcePath) {
        setError('载入稿库需要已有稿件。请先提供现有论文入口 .tex，或直接从首页打开已经存在的稿库卡片。');
        return;
      }

      const hasImportedManuscript = Boolean(importSourcePath && importSourcePath !== manuscriptPath);
      if (importSourcePath && importSourcePath !== manuscriptPath) {
        workingSnapshot = await importTexPaper({
          texPath: importSourcePath,
          projectRoot: rootPath,
          targetJournal: journal,
          runtimeConfig: effectiveRuntimeConfig,
        });
        applyWorkspace(workingSnapshot);
        setTexPath(sourcePathForVersion(workingSnapshot, workingSnapshot.currentVersion) || manuscriptPath);
      }

      if (nativeMode) {
        if (!workingSnapshot && !importSourcePath) {
          const projectTitle = rootPath.split(/[\\/]/).filter(Boolean).pop() || 'Codex Manuscript';
          const starterSnapshot = await createCodexPaper({
            title: projectTitle,
            targetJournal: journal,
            latex: nativeCodexStarterLatex(rootPath, journal),
            summary: 'Codex native workspace bootstrap',
            projectRoot: rootPath,
            sourcePath: manuscriptPath,
            runtimeConfig: effectiveRuntimeConfig,
          });
          workingSnapshot = starterSnapshot;
          applyWorkspace(starterSnapshot);
          setTexPath(sourcePathForVersion(starterSnapshot, starterSnapshot.currentVersion) || manuscriptPath);
        }
        if (!workingSnapshot) {
          throw new Error('原生 Codex 模式需要已有主稿或先创建空白工作区。');
        }
        const bootstrap = nativeCodexBootstrapText(mode, Boolean(hasImportedManuscript || importSourcePath));
        setStatus(bootstrap.headline);
        setObserverOpen(true);
        setProjectLoaderOpen(false);
        setScreenMode('workspace');
        void refreshWorkspaceList(false);
        return;
      }

      const hasExistingManuscript = Boolean(workingSnapshot || hasImportedManuscript);
      const shouldAutoDraftAfterUnderstanding = mode === 'new' && !hasExistingManuscript;
      const activeVersionId = workingSnapshot?.currentVersion.id;
      const effectiveTargetJournal = resolveTargetJournal(journal, workingSnapshot?.paper.targetJournal);
      const effectiveSessionId = sessionIdForProject(rootPath, effectiveBackend);
      const continuedFromCommandId = continuedCommandIdForProject(rootPath, effectiveBackend, effectiveSessionId);
      const initialDraftInstruction = [
        '源库上下文已经准备好，开始生成论文初稿。',
        importSourcePath
          ? `用户提供的 .tex 已导入为项目主稿 ${manuscriptPath}。请只在这个 main.tex 上继续补全、统一并打磨全文。`
          : `请从零开始在 ${manuscriptPath} 写入完整可编译 LaTeX，并确保第一次保存出来的论文版本就是 v1。`,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n\n');
      const commandInstruction = shouldAutoDraftAfterUnderstanding
        ? [
            '当前阶段只做源库理解，不要生成论文版本，也不要开始撰写正文。',
            '请检查项目代码、实验脚本、结果文件、图表素材和可运行命令，梳理研究问题、方法、数据集、指标、关键结果与证据锚点，并把结论写入保存的源库上下文文件，供下一阶段起稿使用。',
          ].join('\n\n')
        : [
            '当前阶段只做理解，不要修改论文正文、不要新增论文版本，也不要自行选择某一段落进行润色或重写。',
            importSourcePath
              ? `用户提供的 .tex 已导入为项目主稿 ${manuscriptPath}。请把它和源库一起理解，但暂时不要改动这个 main.tex。`
              : `请把项目主稿 ${manuscriptPath} 与源库一起理解，梳理论文当前结构、证据锚点和可能缺口，但不要改动主稿内容。`,
            '完成后停止，等待用户后续明确的写作或修改指令。',
          ]
            .filter((line): line is string => Boolean(line))
            .join('\n\n');
      const commandDraftingMode: DraftingMode = 'understand-project';
      await createBridgeCommand('codex-task', {
        projectPath: rootPath,
        targetJournal: effectiveTargetJournal,
        taskSpeedMode: projectTaskSpeedMode,
        agentBackend: effectiveBackend,
        modelConfig: effectiveModelConfig,
        instruction: commandInstruction,
        followupInstruction: shouldAutoDraftAfterUnderstanding ? initialDraftInstruction : undefined,
        paperId: workingSnapshot?.paper.id,
        versionId: activeVersionId,
        baseVersionId: activeVersionId,
        focusVersionId: activeVersionId,
        source: 'browser',
        draftingMode: commandDraftingMode,
        resumeSessionId: effectiveSessionId,
        continuedFromCommandId,
      });
      setStatus(shouldAutoDraftAfterUnderstanding ? '正在理解源库，暂不可操作' : '正在理解源库与主稿，暂不可操作');
      setObserverOpen(true);
      setProjectLoaderOpen(false);
      setScreenMode('workspace');
      void refreshWorkspaceList(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : mode === 'new' ? '新建稿库失败。' : '载入稿库失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function importExistingTexDraft() {
    const sourcePath = texPath.trim();
    const rootPath = projectPath.trim();
    const journal = resolveTargetJournal(targetJournal);
    if (!rootPath) {
      setError('请先输入源库路径。这里应当是代码与实验结果所在目录，不能用单个 .tex 路径代替。');
      return;
    }
    if (!sourcePath) {
      setError('请输入已有论文 .tex 文件路径。');
      return;
    }

    setBusyState('import-tex');
    setError(null);
    try {
      const effectiveRuntimeConfig = activeRuntimeConfig;
      const validationError = runtimeConfigValidationError(effectiveRuntimeConfig);
      if (validationError) {
        setError(validationError);
        return;
      }
      await ensureSelectedTemplateForUse();
      const snapshot = await importTexPaper({
        texPath: sourcePath,
        projectRoot: rootPath,
        targetJournal: journal,
        runtimeConfig: effectiveRuntimeConfig,
      });
      applyWorkspace(snapshot);
      setTexPath(sourcePathForVersion(snapshot, snapshot.currentVersion) || canonicalManuscriptPath(rootPath));
      setProjectLoaderOpen(false);
      void refreshWorkspaceList(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入 LaTeX 失败。');
    } finally {
      setBusyState(null);
    }
  }

  function openProjectSetup(mode: 'new' | 'load' = 'new') {
    setProjectMode(mode);
    setProjectLoaderOpen(true);
  }

  function closeProjectSetup() {
    setProjectLoaderOpen(false);
    setSuggestionsOpen(false);
  }

  function beginResize(target: ResizeTarget, event: ReactPointerEvent<HTMLDivElement>) {
    if (!isDesktopResizableLayout()) {
      return;
    }
    event.preventDefault();
    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: target === 'previous-pane' ? previousPaneWidth : observerPaneWidth,
    };
    setActiveResizeTarget(target);
    document.body.classList.add('is-resizing-columns');
  }

  function nudgePreviousPaneWidth(delta: number) {
    const compareWidth = pdfCompareRef.current?.clientWidth || 0;
    if (compareWidth <= 0) {
      return;
    }
    setPreviousPaneWidth((current) => clampPreviousPaneWidth(current + delta, compareWidth));
  }

  function handleResizerKeyDown(target: ResizeTarget, event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!isDesktopResizableLayout()) {
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    if (target === 'previous-pane') {
      const delta = event.key === 'ArrowLeft' ? -24 : 24;
      nudgePreviousPaneWidth(delta);
      return;
    }
    const canvasWidth = workspaceCanvasRef.current?.clientWidth || 0;
    if (canvasWidth <= 0) {
      return;
    }
    const delta = event.key === 'ArrowLeft' ? 24 : -24;
    setObserverPaneWidth((current) => clampObserverPaneWidth(current + delta, canvasWidth));
  }

  async function pauseObservedCommand() {
    if (!observedCommand || observedCommand.status !== 'running') {
      return;
    }
    setBusyState('pause-command');
    setError(null);
    try {
      await updateBridgeCommand(observedCommand.id, { control: 'pause' });
      setStatus('正在暂停');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂停失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function terminateObservedCommand() {
    if (!observedCommand || (observedCommand.status !== 'running' && observedCommand.status !== 'queued' && observedCommand.status !== 'failed')) {
      return;
    }
    setBusyState('terminate-command');
    setError(null);
    try {
      if (observedCommand.status === 'running') {
        await updateBridgeCommand(observedCommand.id, { control: 'terminate' });
        setStatus('正在终止');
      } else {
        await updateBridgeCommand(observedCommand.id, {
          status: 'done',
          phase: 'complete',
          message: '已手动结束这次任务',
        });
        setStatus('已结束上次任务');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '终止失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function resumeCodexCommand(command: BridgeCommand) {
    if (command.type !== 'codex-task' || !command.sessionId) {
      setError('这次任务没有可恢复的 Agent 会话。');
      return;
    }

    const payload = command.payload;
    const resumedVersionId = rightVersion?.id || ('versionId' in payload ? payload.versionId : undefined) || workspace?.currentVersion.id;
    const rootPath =
      ('projectPath' in payload && payload.projectPath) ||
      workspace?.paper.projectRoot ||
      workspace?.paper.analysis?.rootPath ||
      projectPath.trim();
    const resumedFocusVersionId = rightVersion?.id || ('focusVersionId' in payload ? payload.focusVersionId : undefined) || resumedVersionId;
    if (!rootPath) {
      setError('请先输入源库路径。恢复 Agent 对话也必须绑定到代码与实验结果所在目录。');
      return;
    }
    setBusyState('codex-task');
    setError(null);
    try {
      await finalizeBlockingCommandIfNeeded();
      await createBridgeCommand('codex-task', {
        projectPath: rootPath,
        targetJournal: 'targetJournal' in payload ? resolveTargetJournal(payload.targetJournal) : resolveTargetJournal(targetJournal),
        taskSpeedMode: 'taskSpeedMode' in payload ? payload.taskSpeedMode : projectTaskSpeedMode,
        agentBackend: 'agentBackend' in payload ? payload.agentBackend : commandBackend(command) || agentBackend,
        modelConfig: 'modelConfig' in payload ? payload.modelConfig : undefined,
        instruction: resumePrompt(command),
        paperId: 'paperId' in payload ? payload.paperId : workspace?.paper.id,
        versionId: resumedVersionId,
        baseVersionId: resumedVersionId,
        focusVersionId: resumedFocusVersionId,
        selectedText: 'selectedText' in payload ? payload.selectedText : undefined,
        sourceFile: 'sourceFile' in payload ? payload.sourceFile : undefined,
        sourceLine: 'sourceLine' in payload ? payload.sourceLine : undefined,
        sourceSnippet: 'sourceSnippet' in payload ? payload.sourceSnippet : undefined,
        source: 'browser',
        resumeSessionId: command.sessionId,
        continuedFromCommandId: command.id,
      });
      setStatus('正在恢复 Agent');
      setObserverOpen(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '恢复失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function finalizeBlockingCommandIfNeeded() {
    if (!observedCommand) {
      return;
    }
    if (observedCommand.status === 'queued') {
      await updateBridgeCommand(observedCommand.id, {
        status: 'done',
        phase: 'complete',
        message: '已跳过未被接收的旧任务',
      });
      return;
    }
    if (observedCommand.status === 'failed') {
      await updateBridgeCommand(observedCommand.id, {
        status: 'done',
        phase: 'complete',
        message: '已归档失败任务，准备开始新一轮',
      });
    }
  }

  async function handlePdfRegionSelection(selection: PdfRegionSelection) {
    if (!workspace || !currentPdf) {
      return;
    }

    setError(null);
    const located = await locatePdfSelection({
      pdfUrl: currentPdf,
      sourcePath: sourcePathForVersion(workspace, rightVersion),
      projectRoot: projectPath.trim() || workspace.paper.projectRoot || workspace.paper.analysis?.rootPath,
      page: selection.page,
      x: selection.x,
      y: selection.y,
      width: selection.width,
      height: selection.height,
    }).catch((reason: Error) => {
      setError(reason.message);
      return null;
    });

    setAnnotationTarget({
      blockId: 'pdf-selection',
      selectedText: located?.ok
        ? [
            `已选文字: ${selection.selectedText || 'PDF text selection'}`,
            `${located.sourceFile}:${located.line}`,
            located.snippet || '',
          ].join('\n').trim()
        : selection.selectedText || `PDF page ${selection.page}`,
      sourceFile: located?.sourceFile,
      sourceLine: located?.line,
      column: located?.column,
      sourceSnippet: located?.snippet,
      anchor: selection.anchor,
    });
  }

  async function handlePdfCtrlClick(selection: PdfRegionSelection) {
    if (!workspace || !currentPdf) {
      return;
    }
    setError(null);
    const located = await locatePdfSelection({
      pdfUrl: currentPdf,
      sourcePath: sourcePathForVersion(workspace, rightVersion),
      projectRoot: projectPath.trim() || workspace.paper.projectRoot || workspace.paper.analysis?.rootPath,
      page: selection.page,
      x: selection.x,
      y: selection.y,
      width: selection.width || 2,
      height: selection.height || 2,
    }).catch((reason: Error) => {
      setError(reason.message);
      return null;
    });
    if (!located?.ok || !located.line) {
      return;
    }
    setLeftPaneMode('latex');
    window.setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`.latex-editor__row[data-line="${located.line}"]`);
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row?.classList.add('is-jump-target');
      window.setTimeout(() => row?.classList.remove('is-jump-target'), 1600);
    }, 40);
  }

  async function handleLatexCtrlClick(target: LatexCtrlClickTarget) {
    await jumpPdfToSourceLine(target.line, target.selectedText, target.column);
  }

  async function jumpPdfToSourceLine(line: number, selectedText?: string, column = 1, pageHint?: number) {
    if (!workspace || !currentPdf || !rightVersion) {
      return;
    }
    setError(null);
    const located = await locateSourceLine({
      pdfUrl: currentPdf,
      sourcePath: sourcePathForVersion(workspace, rightVersion),
      projectRoot: projectPath.trim() || workspace.paper.projectRoot || workspace.paper.analysis?.rootPath,
      line,
      column,
      pageHint: pageHint || pdfJumpTarget?.page,
    }).catch((reason: Error) => {
      setError(reason.message);
      return null;
    });
    if (!located?.ok || !located.page || located.x === undefined || located.y === undefined) {
      return;
    }
    setPdfJumpTarget({
      page: located.page,
      x: located.x,
      y: located.y,
      width: located.width || 24,
      height: located.height || 14,
      selectedText,
    });
  }

  async function handleDownloadCurrentPdf() {
    if (!workspace || !rightVersion) {
      return;
    }
    setBusyState('download-pdf');
    setError(null);
    setStatus('准备下载 PDF');
    try {
      let nextPdfUrl = currentPdf;
      let nextPdfName = basenameFromPath(activeDiffPdf?.current.pdfPath);
      if (!nextPdfUrl) {
        const compiled = await compilePaper(workspace.paper.id, rightVersion.id);
        if (!compiled.ok || !compiled.pdfUrl) {
          throw new Error(compiled.log || 'PDF 编译失败。');
        }
        nextPdfUrl = compiled.pdfUrl;
        nextPdfName = basenameFromPath(compiled.pdfPath);
      }
      const pdfName =
        sanitizeDownloadName(
          nextPdfName || `${workspace.paper.title || 'texor-manuscript'}-${rightVersion.label || 'current'}.pdf`,
          'texor-manuscript.pdf',
        );
      const { blob } = await downloadBinary(nextPdfUrl);
      triggerBrowserDownload(blob, pdfName.endsWith('.pdf') ? pdfName : `${pdfName}.pdf`);
      setStatus('PDF 已下载');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '下载 PDF 失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function handleExportWorkspaceBundle() {
    if (!workspace) {
      return;
    }
    setBusyState('export-workspace');
    setError(null);
    setStatus('正在导出稿库');
    try {
      const { blob, filename } = await exportWorkspaceArchive(workspace.paper.id);
      const archiveName = sanitizeDownloadName(filename || `${workspace.paper.title || 'texor-workspace'}-workspace.zip`, 'texor-workspace.zip');
      triggerBrowserDownload(blob, archiveName.endsWith('.zip') ? archiveName : `${archiveName}.zip`);
      setStatus('稿库已导出');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导出稿库失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function handleExportDesktopDiagnostics() {
    setBusyState('export-desktop-diagnostics');
    setError(null);
    setStatus('正在导出桌面诊断包');
    try {
      const { blob, filename } = await exportDesktopDiagnosticsBundle();
      const archiveName = sanitizeDownloadName(filename || 'texor-desktop-diagnostics.zip', 'texor-desktop-diagnostics.zip');
      triggerBrowserDownload(blob, archiveName.endsWith('.zip') ? archiveName : `${archiveName}.zip`);
      setStatus('桌面诊断包已导出');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导出桌面诊断包失败。');
    } finally {
      setBusyState(null);
    }
  }

  const isBusy = Boolean(busyState);
  const expectedRightVersionId = rightVersionId || workspace?.currentVersion.id || '';
  const expectedLeftVersionId = leftVersionId || '';
  const activeDiffPdf =
    diffPdf &&
    diffPdf.currentVersionId === expectedRightVersionId &&
    (diffPdf.previousVersionId || '') === expectedLeftVersionId
      ? diffPdf
      : null;
  const currentPdf = activeDiffPdf?.current.pdfUrl;
  const previousPdf = activeDiffPdf?.previous?.pdfUrl;
  const leftVersion = workspace?.versions.find((version) => version.id === expectedLeftVersionId);
  const rightVersion = workspace?.versions.find((version) => version.id === expectedRightVersionId) || workspace?.currentVersion;
  const draftVersion = workspace?.versions.find((version) => version.id === draftVersionId) || workspace?.currentVersion;
  const draftVersionIsCurrent = Boolean(workspace && draftVersion && draftVersion.id === workspace.currentVersion.id);
  const viewedVersionIsCurrent = Boolean(workspace && rightVersion && rightVersion.id === workspace.currentVersion.id);
  const pendingWorkspaceUpdateVersionId = pendingWorkspaceUpdate?.versionId || '';
  const historyFilterOptions: HistoryFilterMode[] = ['all', 'checkpoints', 'edits', 'drafts'];
  const historyFilterCounts = useMemo(() => {
    if (!workspace) {
      return {
        all: 0,
        checkpoints: 0,
        edits: 0,
        drafts: 0,
      } satisfies Record<HistoryFilterMode, number>;
    }
    return {
      all: workspace.versions.length,
      checkpoints: workspace.versions.filter((version) => versionMatchesHistoryFilter(version, 'checkpoints')).length,
      edits: workspace.versions.filter((version) => versionMatchesHistoryFilter(version, 'edits')).length,
      drafts: workspace.versions.filter((version) => versionMatchesHistoryFilter(version, 'drafts')).length,
    } satisfies Record<HistoryFilterMode, number>;
  }, [workspace]);
  const historyTimelineGroups = useMemo(() => {
    if (!workspace) {
      return [] as HistoryTimelineGroup[];
    }
    const filteredVersions = [...workspace.versions]
      .reverse()
      .filter((version) => versionMatchesHistoryFilter(version, historyFilterMode));
    return HISTORY_GROUP_ORDER
      .map((label) => {
        const versions = filteredVersions.filter((version) => versionGroupLabel(versionTypeLabel(version)) === label);
        return {
          label,
          versions,
          containsDraftPreview: versions.some((version) => version.id === draftVersion?.id),
          containsViewedVersion: versions.some((version) => version.id === rightVersion?.id),
          containsLatestCurrent: versions.some((version) => version.id === workspace.currentVersion.id),
          containsPendingExternal: versions.some((version) => version.id === pendingWorkspaceUpdateVersionId),
          containsNavigationPath: versions.some((version) => historyNavigationState?.highlightedVersionIds.includes(version.id)),
        } satisfies HistoryTimelineGroup;
      })
      .filter((group) => group.versions.length > 0);
  }, [draftVersion?.id, historyFilterMode, historyNavigationState, pendingWorkspaceUpdateVersionId, rightVersion?.id, workspace]);
  const draftVersionVisibleInHistoryFilter = Boolean(draftVersion && versionMatchesHistoryFilter(draftVersion, historyFilterMode));
  const rightVersionBranchLabel = workspace && rightVersion ? versionBranchLabel(rightVersion, workspace.versions) : '';
  const leftVersionBranchLabel = workspace && leftVersion ? versionBranchLabel(leftVersion, workspace.versions) : '';
  const rightVersionStatusLabel = versionLatestStatusLabel(rightVersion, workspace?.currentVersion, pendingWorkspaceUpdateVersionId);
  const leftVersionStatusLabel = versionLatestStatusLabel(leftVersion, workspace?.currentVersion, pendingWorkspaceUpdateVersionId);
  const rightVersionLineageLabel = workspace && rightVersion ? versionLineageSummaryLabel(rightVersion, workspace.versions) : '';
  const leftVersionLineageLabel = workspace && leftVersion ? versionLineageSummaryLabel(leftVersion, workspace.versions) : '';
  const draftVersionLineageLabel = workspace && draftVersion ? versionLineageSummaryLabel(draftVersion, workspace.versions) : '';
  const rightVersionLineageBreadcrumb = workspace && rightVersion ? versionLineageBreadcrumb(rightVersion, workspace.versions) : [];
  const leftVersionLineageBreadcrumb = workspace && leftVersion ? versionLineageBreadcrumb(leftVersion, workspace.versions) : [];
  const draftVersionLineageBreadcrumb = workspace && draftVersion ? versionLineageBreadcrumb(draftVersion, workspace.versions) : [];
  const draftVersionRelationLabel = workspace && draftVersion && rightVersion && draftVersion.id !== rightVersion.id
    ? versionCompareRelationshipLabel(rightVersion, draftVersion, workspace.versions)
    : '';
  const currentCompareContext = workspace ? activeCompareContext(leftVersion, rightVersion, workspace.versions) : null;
  const compareRelationshipSummary = currentCompareContext?.pathLabel || '';
  const compareRelationshipSegments = currentCompareContext?.pathSegments || [];
  const compareSharedAncestor = currentCompareContext?.sharedAncestor || null;
  const activeCompareEntryContext = workspace && compareEntryContextMatches(compareEntryContext, workspace.paper.id, expectedLeftVersionId, expectedRightVersionId)
    ? compareEntryContext
    : null;
  const activeCompareEntryPresentation = compareEntryPresentation(activeCompareEntryContext, rightVersion);
  const compareEntryHintTitle = activeCompareEntryPresentation?.revisionTitle || '';
  const activeCompareVersionInsightEntry: VersionInsightEntry | null = activeCompareEntryContext && activeCompareEntryPresentation
    ? {
        label: activeCompareEntryPresentation.label,
        detail: activeCompareEntryPresentation.detail,
        title: activeCompareEntryPresentation.revisionTitle,
        chipLabel: activeCompareEntryContext.regionLabel,
        chipTitle: activeCompareEntryPresentation.focusTitle,
        versionId: activeCompareEntryContext.focusVersionId,
        query: activeCompareEntryContext.regionQuery,
      }
    : null;
  const activeHistoryPreviewEntryContext = workspace && draftVersion && historyPreviewEntryContextMatches(historyPreviewEntryContext, workspace.paper.id, draftVersion.id)
    ? historyPreviewEntryContext
    : null;
  const activeHistoryPreviewEntryPresentation = historyPreviewEntryPresentation(activeHistoryPreviewEntryContext, draftVersion);
  const activeHistoryPreviewVersionInsightEntry: VersionInsightEntry | null = activeHistoryPreviewEntryContext && activeHistoryPreviewEntryPresentation
    ? {
        label: activeHistoryPreviewEntryPresentation.label,
        detail: activeHistoryPreviewEntryPresentation.detail,
        title: activeHistoryPreviewEntryPresentation.revisionTitle,
        chipLabel: activeHistoryPreviewEntryContext.regionLabel,
        chipTitle: activeHistoryPreviewEntryPresentation.focusTitle,
        versionId: activeHistoryPreviewEntryContext.versionId,
        query: activeHistoryPreviewEntryContext.regionQuery,
      }
    : null;
  const activeHistoryPreviewCompareReferenceVersion = workspace && activeHistoryPreviewEntryContext?.compareReferenceVersionId
    ? workspace.versions.find((version) => version.id === activeHistoryPreviewEntryContext.compareReferenceVersionId) || null
    : null;
  const activeHistoryPreviewCompareActionLabel =
    workspace &&
    activeHistoryPreviewCompareReferenceVersion &&
    draftVersion &&
    activeHistoryPreviewCompareReferenceVersion.id !== draftVersion.id
      ? versionCompareShortcutLabel('default', activeHistoryPreviewCompareReferenceVersion, draftVersion, workspace.versions)
      : '';
  const activeHistoryPreviewCompareActionTitle = activeHistoryPreviewCompareReferenceVersion && draftVersion
    ? versionCompareActionTitle(activeHistoryPreviewCompareReferenceVersion, draftVersion)
    : '';
  if (activeHistoryPreviewVersionInsightEntry && activeHistoryPreviewCompareReferenceVersion && draftVersion && activeHistoryPreviewCompareActionLabel) {
    activeHistoryPreviewVersionInsightEntry.actionLabel = activeHistoryPreviewCompareActionLabel;
    activeHistoryPreviewVersionInsightEntry.actionTitle = activeHistoryPreviewCompareActionTitle;
    activeHistoryPreviewVersionInsightEntry.actionReferenceVersionId = activeHistoryPreviewCompareReferenceVersion.id;
    activeHistoryPreviewVersionInsightEntry.actionFocusVersionId = draftVersion.id;
  }
  const rightVersionRelationLabel = currentCompareContext?.relationLabel || '';
  const leftVersionRelationLabel = currentCompareContext?.reverseRelationLabel || '';
  const currentCompareActionLabel = currentCompareContext?.compareActionLabel || '';
  const diffFailureNotice = activeDiffPdf && !activeDiffPdf.ok ? diffCompileFailureMessage(activeDiffPdf) : '';
  const showSourceDiffFallback = Boolean(diffFailureNotice && leftVersion && rightVersion);
  const versionOptions = workspace?.versions || [];
  const observedCommand = useMemo(() => {
    const ordered = [...visibleBridgeCommands].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const active = [...ordered].reverse().find((command) => command.status === 'queued' || command.status === 'running');
    if (active) {
      return active;
    }
    const latest = ordered[ordered.length - 1] || null;
    if (workspace) {
      return latest;
    }
    return latest && isRecentCommand(latest) ? latest : null;
  }, [visibleBridgeCommands, workspace]);
  const observedSessionId = observedCommand?.sessionId || (observedCommand?.result?.sessionId as string | undefined);
  const observedDraftingMode = commandDraftingMode(observedCommand);
  const reusableCommand = reusableSessionCommand(bridgeCommands, agentBackend, {
    projectKey: workspaceProjectKey,
    workspace,
    windowSessionKey,
  });
  useEffect(() => {
    const pending = pendingVersionJumpRef.current;
    if (!pending || !workspace || !rightVersion || rightVersion.id !== pending.versionId || rightVersion.id !== workspace.currentVersion.id) {
      return;
    }
    if (pending.line) {
      pendingVersionJumpRef.current = null;
      void jumpPdfToSourceLine(pending.line, pending.selectedText || pending.query, pending.column || 1, pending.pageHint);
      return;
    }
    const query = pending.query.trim();
    if (!query) {
      pendingVersionJumpRef.current = null;
      return;
    }
    const regions = rightVersion.manuscriptState?.sectionMap || [];
    const matchedRegion = regions.find((region) => region.title.toLowerCase().includes(query.toLowerCase()) || query.toLowerCase().includes(region.title.toLowerCase()));
    if (matchedRegion?.lineStart) {
      pendingVersionJumpRef.current = null;
      void jumpPdfToSourceLine(matchedRegion.lineStart, matchedRegion.title, 1, pending.pageHint);
      return;
    }
    const focusLine = rightVersion.focusTarget?.sourceLine;
    if (focusLine) {
      pendingVersionJumpRef.current = null;
      void jumpPdfToSourceLine(
        focusLine,
        rightVersion.focusTarget?.selectedText || query,
        rightVersion.focusTarget?.sourceColumn || 1,
        pending.pageHint || rightVersion.focusTarget?.pageHint,
      );
      return;
    }
    pendingVersionJumpRef.current = null;
  }, [currentPdf, projectPath, rightVersion, workspace]);
  function sessionIdForProject(rootPath?: string, backendOverride: AgentBackend = agentBackend): string | undefined {
    const key = normalizeProjectKey(rootPath || projectPath || workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath);
    const activeKey = normalizeProjectKey(workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath);
    const barrier = key ? sessionReuseBarrierRef.current[key] : undefined;
    const windowSessionKey = windowSessionKeyRef.current;
    const workspaceBackend =
      workspace?.paper.runtimeConfig?.agentBackend ||
      workspace?.paper.codexSessionBackend ||
      inferSessionBackend(workspace?.paper.codexSessionId);
    if (!key) {
      return workspaceBackend === backendOverride ? workspace?.paper.codexSessionId : undefined;
    }
    if (
      workspace?.paper.codexSessionId &&
      activeKey === key &&
      (!workspaceBackend || workspaceBackend === backendOverride) &&
      (backendOverride !== 'codex-native' || conversationCommands.some((command) => sessionIdFromCommand(command) === workspace.paper.codexSessionId))
    ) {
      return workspace.paper.codexSessionId;
    }
    if (barrier) {
      return undefined;
    }
    const summary = workspaceList.find((item) => normalizeProjectKey(item.projectRoot) === key);
    const summaryBackend = summary?.codexSessionBackend || inferSessionBackend(summary?.codexSessionId);
    if (summary?.codexSessionId && summaryBackend === backendOverride && backendOverride !== 'codex-native') {
      return summary.codexSessionId;
    }
    const backendCommand = [...bridgeCommands]
      .filter((command) => !backendOverride || commandBackend(command) === backendOverride)
      .filter((command) => commandMatchesProject(command, key, workspace))
      .filter((command) => {
        if (backendOverride !== 'codex-native') {
          return true;
        }
        return commandMatchesWindowSession(command, windowSessionKey);
      })
      .filter((command) => sessionIdFromCommand(command))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(-1)[0] || null;
    const backendCommandSessionId = sessionIdFromCommand(backendCommand);
    return commandMatchesProject(backendCommand, key, workspace) ? backendCommandSessionId : undefined;
  }
  function continuedCommandIdForProject(
    rootPath?: string,
    backendOverride: AgentBackend = agentBackend,
    sessionId?: string,
  ): string | undefined {
    if (!sessionId) {
      return undefined;
    }
    const key = normalizeProjectKey(rootPath || projectPath || workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath);
    const backendCommand = reusableSessionCommand(bridgeCommands, backendOverride, {
      projectKey: key,
      workspace,
      windowSessionKey: backendOverride === 'codex-native' ? windowSessionKeyRef.current : undefined,
    });
    const backendCommandSessionId = sessionIdFromCommand(backendCommand);
    if (!backendCommand || backendCommandSessionId !== sessionId) {
      return undefined;
    }
    return commandMatchesProject(backendCommand, key, workspace) ? backendCommand.id : undefined;
  }
  const canResumeObservedCommand = Boolean(
    observedCommand &&
      observedCommand.type === 'codex-task' &&
      observedSessionId &&
      (observedCommand.status === 'failed' || observedCommand.phase === 'interrupted'),
  );
  const canPauseObservedCommand = Boolean(observedCommand && observedCommand.type === 'codex-task' && observedCommand.status === 'running');
  const showWorkspaceBootstrapState = !workspace && screenMode === 'workspace';
  const topbarState =
    observedCommand?.status === 'running' || observedCommand?.status === 'queued'
      ? commandMessage(observedCommand)
      : screenMode === 'hub'
        ? (workspaceList.length ? `${workspaceList.length} 个稿库` : '稿库首页')
        : workspace
          ? 'Ready'
          : '准备中';
  const activeWorkspaceBackend = activeRuntimeConfig.agentBackend;
  const conversationCommands = useMemo(() => {
    const ordered = [...visibleBridgeCommands]
      .filter((command) => command.type === 'codex-task')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (!workspaceProjectKey) {
      return ordered;
    }
    return ordered;
  }, [visibleBridgeCommands, workspaceProjectKey]);
  const conversationTailMarker = conversationCommands.length
    ? `${conversationCommands[conversationCommands.length - 1].id}:${conversationCommands[conversationCommands.length - 1].updatedAt}`
    : 'empty';
  const observerSidebarStyle =
    observerOpen && isDesktopResizableLayout()
      ? ({
          width: `${Math.round(observerPaneWidth)}px`,
          maxWidth: `${Math.round(observerPaneWidth)}px`,
          flexBasis: `${Math.round(observerPaneWidth)}px`,
        } as CSSProperties)
      : undefined;
  const workspaceCanvasStyle =
    observerOpen && isDesktopResizableLayout()
      ? ({
          gridTemplateColumns: `minmax(0, 1fr) ${LAYOUT_RESIZER_SIZE}px auto`,
        } as CSSProperties)
      : undefined;
  const leftPaneVisible = leftPaneOpen || !isDesktopResizableLayout();

  function isTimelineNearBottom(element: HTMLDivElement): boolean {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  }

  function scrollTimelineToBottom(behavior: ScrollBehavior = 'smooth') {
    const element = chatTimelineRef.current;
    if (!element) {
      return;
    }
    element.scrollTo({
      top: element.scrollHeight,
      behavior,
    });
  }

  function handleTimelineScroll() {
    const element = chatTimelineRef.current;
    if (!element) {
      return;
    }
    chatStickToBottomRef.current = isTimelineNearBottom(element);
  }

  useEffect(() => {
    if (!observerOpen) {
      return;
    }
    if (!chatStickToBottomRef.current) {
      return;
    }
    scrollTimelineToBottom(conversationCommands.length <= 1 ? 'auto' : 'smooth');
  }, [conversationTailMarker, observerOpen, conversationCommands.length]);

  const pdfCompareStyle = {
    '--previous-pane-width': `${Math.round(previousPaneWidth)}px`,
  } as CSSProperties;

  function renderWorkspaceSidebar() {
    const nativeChatReady = activeRuntimeConfig.agentBackend === 'codex-native' && Boolean(projectPath.trim() || workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath);
    const composerDisabled = (!workspace && !nativeChatReady) || busyState === 'feedback' || busyState === 'restore-version';
    const activeSubmissionVersion = rightVersion || workspace?.currentVersion;
    const activeSubmissionBranchLabel = workspace && activeSubmissionVersion ? versionBranchLabel(activeSubmissionVersion, workspace.versions) : '';
    const composerPlaceholder = !workspace && !nativeChatReady
      ? '请先打开或创建一个稿库'
      : annotationTarget
        ? '针对当前 PDF 选区补充修改要求，Enter 发送'
        : activeRuntimeConfig.agentBackend === 'codex-native'
          ? '可以直接提问、讨论方案，或让 Codex 修改稿件，Enter 发送'
          : '直接告诉 TEXOR 你想怎么改，Enter 发送';

    return (
      <aside className={`workspace-chat-sidebar ${observerOpen ? 'is-open' : 'is-collapsed'}`} style={observerSidebarStyle}>
        {observerOpen ? (
          <div className="workspace-chat-sidebar__panel">
            <header className="workspace-chat-sidebar__header">
              <div className="workspace-chat-sidebar__identity">
                <span>TEXOR</span>
                <strong>{commandMessage(observedCommand)}</strong>
                {shortWindowSessionKey ? <em>window {shortWindowSessionKey}</em> : null}
              </div>
              <div className="workspace-chat-sidebar__header-actions">
                <button
                  type="button"
                  className="workspace-chat-sidebar__collapse"
                  onClick={() => setObserverOpen(false)}
                  aria-label="隐藏右侧会话栏"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </header>

            <div className="workspace-chat-sidebar__view-switch" role="tablist" aria-label="TEXOR 会话视图">
              <button
                type="button"
                className={observerViewMode === 'process' ? 'is-active' : ''}
                onClick={() => setObserverViewMode('process')}
                aria-pressed={observerViewMode === 'process'}
              >
                交流过程
              </button>
              <button
                type="button"
                className={observerViewMode === 'details' ? 'is-active' : ''}
                onClick={() => setObserverViewMode('details')}
                aria-pressed={observerViewMode === 'details'}
              >
                技术详情
              </button>
            </div>

            <div ref={chatTimelineRef} className="workspace-chat-sidebar__timeline" aria-live="polite" onScroll={handleTimelineScroll}>
              {conversationCommands.length ? (
                conversationCommands.map((command) => {
                  const processEntries = observerProcessEntries(command);
                  const detailEntries = (command.logs || [])
                    .filter((entry) => (command.status === 'failed' ? true : shouldShowCodexLog(entry.message)))
                    .slice(command.status === 'failed' ? -18 : -10);
                  const assistantAnswer = bridgeCommandAssistantAnswer(command);
                  const failureHint = commandFailureHint(command);
                  const draftHint = commandDraftHint(command);
                  const savedVersionHint = commandSavedVersionHint(command, workspace);
                  const failureDetail = commandFailureDetail(command);
                  const contextLabel = bridgeCommandContextLabel(command);
                  const commandCompareContext = bridgeCommandCompareContext(command, workspace, rightVersion);
                  const commandBaseVersion = commandCompareContext?.baseVersion || null;
                  const commandFocusVersion = commandCompareContext?.focusVersion || null;
                  const commandFocusVersionLabel = commandCompareContext?.focusVersionSource === 'fallback' ? 'Current focus' : 'Submit focus';
                  const commandCanCompareAtSubmitSplit = Boolean(
                    commandCompareContext?.sharedAncestor &&
                    commandBaseVersion &&
                    commandFocusVersion &&
                    commandCompareContext.sharedAncestor.id !== commandBaseVersion.id &&
                    commandCompareContext.sharedAncestor.id !== commandFocusVersion.id,
                  );
                  const submissionRevisionStage =
                    commandBaseVersion && (((commandCompareContext?.pathSegments.length || 0) > 0) || commandCompareContext?.relationLabel)
                      ? observerRevisionStage({
                          tone: 'submission',
                          heading: commandCompareContext?.focusVersionSource === 'fallback' ? 'Current branch at submit' : 'Submission branch',
                          summary: commandCompareContext?.focusVersionSource === 'fallback'
                            ? `这次提交参考 ${commandBaseVersion.label}，并沿当前 focus 分支发起。`
                            : `这次提交基于 ${commandBaseVersion.label} 发起。`,
                          relationLabel: commandCompareContext?.relationLabel,
                          relationReferenceVersion: commandBaseVersion,
                          relationFocusVersion: commandFocusVersion,
                          relationScope: commandCompareContext?.focusVersionSource === 'fallback' ? 'current' : 'submit',
                          pathHeadingKind: commandCompareContext?.focusVersionSource === 'fallback' ? 'current' : 'submission',
                          pathLabel: commandCompareContext?.pathLabel,
                          pathSegments: commandCompareContext?.pathSegments,
                          compareActionLabel: commandCompareContext?.compareActionLabel,
                          compareReferenceVersion: commandBaseVersion,
                          compareFocusVersion: commandFocusVersion,
                          splitVersion: commandCanCompareAtSubmitSplit ? commandCompareContext?.sharedAncestor : null,
                          splitFocusVersion: commandCanCompareAtSubmitSplit ? commandFocusVersion : null,
                          splitVersions: workspace?.versions || [],
                          primaryLinks: [
                            { label: `Submit base ${commandBaseVersion.label}`, versionId: commandBaseVersion.id },
                            ...(commandFocusVersion && commandFocusVersion.id !== commandBaseVersion.id
                              ? [{ label: `${commandFocusVersionLabel} ${commandFocusVersion.label}`, versionId: commandFocusVersion.id }]
                              : []),
                          ],
                        })
                      : null;
                  const savedRevisionStage = savedVersionHint
                    ? observerRevisionStage({
                        tone: 'saved',
                        heading: 'Saved revision',
                        summary: savedVersionHint.message,
                        relationLabel: savedVersionHint.relationLabel,
                        relationReferenceVersion: savedVersionHint.baseVersion,
                        relationFocusVersion: savedVersionHint.savedVersion,
                        relationScope: 'generic',
                        pathHeadingKind: 'revision',
                        pathLabel: savedVersionHint.pathLabel,
                        pathSegments: savedVersionHint.pathSegments,
                        compareActionLabel: savedVersionHint.compareActionLabel,
                        compareReferenceVersion: savedVersionHint.baseVersion,
                        compareFocusVersion: savedVersionHint.savedVersion,
                        splitVersion:
                          savedVersionHint.sharedAncestor &&
                          savedVersionHint.baseVersion &&
                          savedVersionHint.savedVersion &&
                          savedVersionHint.sharedAncestor.id !== savedVersionHint.baseVersion.id &&
                          savedVersionHint.sharedAncestor.id !== savedVersionHint.savedVersion.id
                            ? savedVersionHint.sharedAncestor
                            : null,
                        splitFocusVersion: savedVersionHint.savedVersion,
                        splitVersions: workspace?.versions || [],
                        primaryLinks: [
                          ...(savedVersionHint.savedVersionId ? [{ label: '查看版本', versionId: savedVersionHint.savedVersionId }] : []),
                          ...(savedVersionHint.baseVersionId ? [{ label: '查看基线', versionId: savedVersionHint.baseVersionId }] : []),
                        ],
                      })
                    : null;
                  const selectionPreview = bridgeCommandSelectionPreview(command);
                  const undoBaseVersion = undoBaseVersionForCommand(command, workspace);
                  const eventStatusLabel = commandStatusLabel(command);
                  const eventStatusHint = assistantAnswer ? commandMessage(command) : '';
                  const submissionPaneMeta = observerSubmissionPaneMeta(command);
                  const resultPaneMeta = observerResultPaneMeta(command, savedVersionHint, failureHint);
                  const eventRevisionStages = [submissionRevisionStage, savedRevisionStage].filter(
                    (stage): stage is ObserverRevisionStage => Boolean(stage && (stage.pathLabel || stage.summary)),
                  );
                  const eventSummaryItems = observerEventSummaryItems(eventRevisionStages, resultPaneMeta, savedVersionHint);

                  return (
                    <article className="workspace-chat-turn" key={command.id}>
                      <div className="workspace-chat-turn__shell">
                        <div className="workspace-chat-turn__header">
                          <div className="workspace-chat-turn__header-copy">
                            <strong>{bridgeCommandSourceLabel(command)}</strong>
                            <span>{eventStatusHint ? `${eventStatusLabel} · ${eventStatusHint}` : eventStatusLabel}</span>
                          </div>
                          <div className="workspace-chat-turn__header-times">
                            <time>{commandTimeLabel(command.createdAt)}</time>
                            {command.updatedAt !== command.createdAt ? <time>{commandTimeLabel(command.updatedAt)}</time> : null}
                          </div>
                        </div>
                        {eventSummaryItems.length
                          ? renderObserverRevisionSummary(eventSummaryItems, {
                              onOpenVersion: openVersionInHistory,
                              onOpenVersionRegion: (versionId, query, entrySource) => openVersionInHistory(versionId, query, entrySource || {
                                kind: 'observer-saved-region',
                                regionLabel: query,
                                regionQuery: query,
                              }),
                              onOpenCompare: openVersionCompare,
                            })
                          : null}
                        <div className="workspace-chat-turn__body">
                          <section className="workspace-chat-turn__pane workspace-chat-turn__pane--submission">
                            <div className="workspace-chat-bubble__section workspace-chat-bubble__section--submission">
                              <div className="workspace-chat-bubble__section-title">
                                <strong>{submissionPaneMeta.chipLabel}</strong>
                                <span>{submissionPaneMeta.description}</span>
                              </div>
                              <div className="workspace-chat-bubble__prompt">
                                <p>{bridgeCommandUserMessage(command)}</p>
                              </div>
                              <div className="workspace-chat-bubble__chips">
                                {contextLabel ? <span className="workspace-chat-bubble__chip">{contextLabel}</span> : null}
                              </div>
                              {submissionRevisionStage
                                ? renderObserverRevisionStage(submissionRevisionStage, {
                                    onOpenVersion: openVersionInHistory,
                                    onOpenVersionRegion: (versionId, query) => openVersionInHistory(versionId, query, {
                                      kind: 'observer-saved-region',
                                      regionLabel: query,
                                      regionQuery: query,
                                    }),
                                    onOpenCompare: openVersionCompare,
                                  })
                                : null}
                            </div>
                            {selectionPreview ? (
                              <div className="workspace-chat-bubble__section workspace-chat-bubble__section--evidence">
                                <div className="workspace-chat-bubble__section-title">
                                  <strong>Evidence</strong>
                                  <span>Quoted PDF selection captured at submit time</span>
                                </div>
                                <blockquote>{selectionPreview}</blockquote>
                              </div>
                            ) : null}
                          </section>

                          <section className={`workspace-chat-turn__pane workspace-chat-turn__pane--result is-${command.status}`}>
                            <div className="workspace-chat-bubble__section workspace-chat-bubble__section--result">
                              <div className="workspace-chat-bubble__section-title">
                                <strong>{resultPaneMeta.chipLabel}</strong>
                                <span>{resultPaneMeta.description}</span>
                              </div>
                              {assistantAnswer ? (
                                <div className="workspace-chat-bubble__answer">
                                  <p>{assistantAnswer}</p>
                                </div>
                              ) : (
                                <p>{commandMessage(command)}</p>
                              )}
                              {assistantAnswer && commandMessage(command) !== assistantAnswer ? (
                                <div className="workspace-chat-bubble__status">{commandMessage(command)}</div>
                              ) : null}
                            </div>
                            <div className="workspace-chat-bubble__section workspace-chat-bubble__section--detail">
                              <div className="workspace-chat-bubble__section-title">
                                <strong>{observerViewMode === 'process' ? 'Process' : 'Technical log'}</strong>
                                <span>{observerViewMode === 'process' ? 'Runtime progress captured during the command' : 'Low-level bridge and runtime output'}</span>
                              </div>
                              {observerViewMode === 'process' ? (
                                processEntries.length ? (
                                  <div className="workspace-chat-process-list">
                                    {processEntries.map((entry) => (
                                      <div className={`workspace-chat-process-step is-${entry.tone}`} key={entry.id}>
                                        <time>{commandTimeLabel(entry.time)}</time>
                                        <span>{entry.message}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="workspace-chat-empty">等待过程更新</div>
                                )
                              ) : detailEntries.length ? (
                                <div className="workspace-chat-log-list">
                                  {detailEntries.map((entry: BridgeCommandLogEntry) => (
                                    <div className={`workspace-chat-log-entry is-${entry.stream}`} key={entry.id}>
                                      <time>{commandTimeLabel(entry.time)}</time>
                                      <span>{compactLogMessage(entry.message)}</span>
                                    </div>
                                  ))}
                                </div>
                                ) : (
                                  <div className="workspace-chat-empty">等待技术日志</div>
                                )}
                              {failureHint ? <div className="workspace-chat-bubble__notice is-warning">{failureHint}</div> : null}
                              {draftHint ? <div className="workspace-chat-bubble__notice">{draftHint}</div> : null}
                              {failureDetail ? <pre className="workspace-chat-bubble__detail">{failureDetail}</pre> : null}
                            </div>
                            {savedRevisionStage || undoBaseVersion ? (
                              <div className="workspace-chat-bubble__section workspace-chat-bubble__section--actions">
                                <div className="workspace-chat-bubble__section-title">
                                  <strong>Revision actions</strong>
                                  <span>Inspect the saved branch or roll back non-destructively</span>
                                </div>
                                  {savedRevisionStage
                                    ? renderObserverRevisionStage(savedRevisionStage, {
                                        onOpenVersion: openVersionInHistory,
                                        onOpenVersionRegion: (versionId, query) => openVersionInHistory(versionId, query, {
                                          kind: 'observer-saved-region',
                                          regionLabel: query,
                                          regionQuery: query,
                                          compareReferenceVersionId: savedVersionHint?.baseVersion?.id,
                                        }),
                                        onOpenCompare: openVersionCompare,
                                      })
                                    : null}
                                {undoBaseVersion ? (
                                  <div className="workspace-chat-bubble__actions">
                                    <div className="workspace-chat-bubble__undo-group">
                                      <button
                                        type="button"
                                        className="workspace-chat-bubble__undo"
                                        onClick={() => void restoreVersionAsCurrent(undoBaseVersion.id, restoreCheckpointSummary(undoBaseVersion, workspace))}
                                        disabled={isBusy}
                                      >
                                        <RotateCcw size={13} />
                                        <span>撤回这次修改</span>
                                      </button>
                                      <div className="workspace-chat-bubble__undo-note">{restoreOutcomeHint(undoBaseVersion, workspace)}</div>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </section>
                        </div>
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="workspace-chat-empty-state">
                  <Sparkles size={15} />
                  <div>
                    <strong>右侧会话会显示这里</strong>
                    <p>可以直接输入需求，也可以先在 PDF 中选区，再通过浮动小窗发起修改。</p>
                  </div>
                </div>
              )}
            </div>

            <footer className="workspace-chat-sidebar__composer">
              {annotationTarget ? (
                <div className="workspace-chat-sidebar__selection">
                  <div>
                    <strong>当前选区</strong>
                    <span>
                      {annotationTarget.sourceFile
                        ? `${latexSourceFileName(annotationTarget.sourceFile)}${annotationTarget.sourceLine ? `:${annotationTarget.sourceLine}` : ''}`
                        : '来自 PDF 选区'}
                    </span>
                  </div>
                  <p>{annotationTarget.selectedText}</p>
                  <button
                    type="button"
                    className="workspace-chat-sidebar__chip-close"
                    onClick={() => {
                      setAnnotationTarget(null);
                      setPdfSelectionClearSignal((signal) => signal + 1);
                      window.getSelection()?.removeAllRanges();
                    }}
                    aria-label="清除当前选区"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : null}

              {activeSubmissionVersion ? (
                <div className="workspace-chat-sidebar__selection workspace-chat-sidebar__selection--version">
                  <div>
                    <strong>当前行动基线</strong>
                    <span>{activeSubmissionVersion.label}{activeSubmissionVersion.id === workspace?.currentVersion.id ? ' · latest' : ' · viewed branch'}</span>
                  </div>
                  <p>{activeSubmissionBranchLabel || '新任务和恢复任务都会基于右侧当前正在查看的版本继续推进。'}</p>
                </div>
              ) : null}

              <div className="workspace-chat-sidebar__composer-shell">
                <textarea
                  ref={chatComposerRef}
                  value={sidebarPrompt}
                  onChange={(event) => setSidebarPrompt(event.target.value)}
                  onKeyDown={handleSidebarPromptKeyDown}
                  placeholder={composerPlaceholder}
                  disabled={composerDisabled}
                  rows={3}
                />

                <div className="workspace-chat-sidebar__footer-tools">
                  <div className="workspace-chat-sidebar__composer-toolbar">
                    <div className={`workspace-chat-sidebar__composer-model ${composerModelMenuOpen ? 'is-open' : ''}`}>
                      <button
                        type="button"
                        className="workspace-chat-sidebar__model-pill"
                        onClick={() => setComposerModelMenuOpen((open) => !open)}
                        aria-label="查看或调整当前模型设置"
                        aria-expanded={composerModelMenuOpen}
                      >
                        <div className="workspace-chat-sidebar__model-pill-copy">
                          <strong>{sidebarComposerMetaLabel()}</strong>
                          <span>{taskSpeedModeHint(projectTaskSpeedMode)}</span>
                        </div>
                        <ChevronDown size={15} />
                      </button>

                      {composerModelMenuOpen ? (
                        <div className="workspace-chat-sidebar__settings-panel workspace-chat-sidebar__settings-panel--compact">
                          <div className="workspace-chat-sidebar__settings-hero">
                            <strong>{taskSpeedModeLabel(projectTaskSpeedMode)}响应</strong>
                            <span>{taskSpeedModeHint(projectTaskSpeedMode)}</span>
                          </div>

                          <div className="workspace-chat-sidebar__settings-group">
                            <span className="workspace-chat-sidebar__settings-label">响应模式</span>
                            <div className="workspace-chat-sidebar__speed-switch workspace-chat-sidebar__speed-switch--compact" role="tablist" aria-label="任务处理模式">
                              <button
                                type="button"
                                className={projectTaskSpeedMode === 'quick' ? 'is-active' : ''}
                                onClick={() => setProjectTaskSpeedMode('quick')}
                              >
                                快速
                              </button>
                              <button
                                type="button"
                                className={projectTaskSpeedMode === 'deep' ? 'is-active' : ''}
                                onClick={() => setProjectTaskSpeedMode('deep')}
                              >
                                深度
                              </button>
                            </div>
                            <p className="workspace-chat-sidebar__settings-note">
                              {projectTaskSpeedMode === 'quick'
                                ? '适合润色、措辞修改、局部改写。默认只走局部编辑通道，不跑实验脚本。'
                                : '适合补实验、结果图、引用核对和全文一致性任务。允许更长时间的项目级执行。'}
                            </p>
                          </div>

                          {activeRuntimeConfig.agentBackend === 'codex-native' ? (
                            <div className="workspace-chat-sidebar__settings-group">
                              <span className="workspace-chat-sidebar__settings-label">原生模式</span>
                              <div className="workspace-chat-sidebar__intent-switch" role="tablist" aria-label="原生 Codex 任务意图">
                                <button
                                  type="button"
                                  className={nativeTaskIntent === 'chat' ? 'is-active' : ''}
                                  onClick={() => setNativeTaskIntent('chat')}
                                >
                                  回答
                                </button>
                                <button
                                  type="button"
                                  className={nativeTaskIntent === 'auto' ? 'is-active' : ''}
                                  onClick={() => setNativeTaskIntent('auto')}
                                >
                                  自动
                                </button>
                                <button
                                  type="button"
                                  className={nativeTaskIntent === 'edit' ? 'is-active' : ''}
                                  onClick={() => setNativeTaskIntent('edit')}
                                >
                                  修改
                                </button>
                              </div>
                              <p className="workspace-chat-sidebar__settings-note">
                                {nativeTaskIntent === 'chat'
                                  ? '只进行问答与分析，不自动保存新版本。'
                                  : nativeTaskIntent === 'edit'
                                    ? '优先直接修改主稿与相关项目文件。'
                                    : '根据任务内容自动判断是回答还是修改。'}
                              </p>
                            </div>
                          ) : null}

                          <div className="workspace-chat-sidebar__settings-group">
                            <span className="workspace-chat-sidebar__settings-label">模型</span>
                            <div className="workspace-chat-sidebar__model-inline-main">
                              {isCodexBackend(agentBackend) ? (
                                <label className="workspace-chat-sidebar__token-field workspace-chat-sidebar__token-field--wide">
                                  <span className="sr-only">Codex 模型版本</span>
                                  <input
                                    className="workspace-chat-sidebar__token-input"
                                    value={displayCodexModelToken(codexModel)}
                                    onChange={(event) => setCodexModel(normalizeCodexModelInput(event.target.value))}
                                    onKeyDown={(event) => handleFooterInputKeyDown(event, () => void persistRuntimeConfigSelection())}
                                    placeholder="5.4"
                                    aria-label="Codex 模型版本"
                                  />
                                </label>
                              ) : agentBackend === 'claude-code' ? (
                                <label className="workspace-chat-sidebar__token-field workspace-chat-sidebar__token-field--wide">
                                  <span className="sr-only">Claude 模型</span>
                                  <input
                                    className="workspace-chat-sidebar__token-input"
                                    value={claudeModel}
                                    onChange={(event) => setClaudeModel(event.target.value)}
                                    onKeyDown={(event) => handleFooterInputKeyDown(event, () => void persistRuntimeConfigSelection())}
                                    placeholder="sonnet-4"
                                    aria-label="Claude 模型"
                                  />
                                </label>
                              ) : (
                                <label className="workspace-chat-sidebar__token-field workspace-chat-sidebar__token-field--wide">
                                  <span className="sr-only">自定义 API 模型</span>
                                  <input
                                    className="workspace-chat-sidebar__token-input"
                                    value={agentModel}
                                    onChange={(event) => setAgentModel(event.target.value)}
                                    onKeyDown={(event) => handleFooterInputKeyDown(event, () => void persistRuntimeConfigSelection())}
                                    placeholder="4.1-mini"
                                    aria-label="自定义 API 模型"
                                  />
                                </label>
                              )}
                            </div>
                          </div>

                          {isCodexBackend(agentBackend) ? (
                            <div className="workspace-chat-sidebar__settings-group">
                              <span className="workspace-chat-sidebar__settings-label">推理强度</span>
                              <div className="workspace-chat-sidebar__option-list" role="listbox" aria-label="Codex 推理强度">
                                {CODEX_REASONING_OPTIONS.map((option) => (
                                  <button
                                    type="button"
                                    key={option}
                                    className={`workspace-chat-sidebar__option-row ${codexReasoningEffort === option ? 'is-active' : ''}`}
                                    onClick={() => setCodexReasoningEffort(option)}
                                    aria-selected={codexReasoningEffort === option}
                                  >
                                    <span>{reasoningEffortLabel(option)}</span>
                                    {codexReasoningEffort === option ? <Check size={15} /> : null}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          <details className="workspace-chat-sidebar__advanced-settings" open={!isCodexBackend(agentBackend) ? true : undefined}>
                            <summary>高级设置</summary>
                            <div className="workspace-chat-sidebar__settings-group">
                              <span className="workspace-chat-sidebar__settings-label">Agent</span>
                              <div className="workspace-chat-sidebar__backend-inline" role="tablist" aria-label="切换核心 Agent">
                                <button type="button" className={agentBackend === 'codex-cli' ? 'is-active' : ''} onClick={() => setAgentBackend('codex-cli')}>
                                  Codex+
                                </button>
                                <button type="button" className={agentBackend === 'codex-native' ? 'is-active' : ''} onClick={() => setAgentBackend('codex-native')}>
                                  原生
                                </button>
                                <button type="button" className={agentBackend === 'texor-agent' ? 'is-active' : ''} onClick={() => setAgentBackend('texor-agent')}>
                                  API
                                </button>
                                <button type="button" className={agentBackend === 'claude-code' ? 'is-active' : ''} onClick={() => setAgentBackend('claude-code')}>
                                  Claude
                                </button>
                              </div>
                            </div>

                            {workspace && hasRuntimeConfigChanges ? (
                              <div className="workspace-chat-sidebar__control-actions">
                                <button
                                  type="button"
                                  className="workspace-chat-sidebar__control-link"
                                  onClick={() => applyRuntimeConfigToState(persistedRuntimeConfig)}
                                  disabled={isBusy}
                                >
                                  还原
                                </button>
                                <button
                                  type="button"
                                  className="workspace-chat-sidebar__secondary-button"
                                  onClick={() => void persistRuntimeConfigSelection()}
                                  disabled={isBusy}
                                >
                                  {busyState === 'save-runtime-config' ? <LoaderCircle className="spin" size={14} /> : null}
                                  <span>应用</span>
                                </button>
                              </div>
                            ) : null}
                          </details>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="workspace-chat-sidebar__composer-actions">
                    <button
                      type="button"
                      className="workspace-chat-sidebar__send-fab"
                      onClick={() => void handleSidebarPromptSubmit()}
                      disabled={composerDisabled || !sidebarPrompt.trim()}
                      aria-label="发送"
                    >
                      {busyState === 'feedback' ? <LoaderCircle className="spin" size={20} /> : <ArrowUp size={20} />}
                    </button>
                  </div>
                </div>
              </div>
            </footer>
          </div>
        ) : (
          <button
            type="button"
            className="workspace-chat-sidebar__collapsed-toggle"
            onClick={() => setObserverOpen(true)}
            aria-label="展开右侧会话栏"
          >
            <ChevronLeft size={16} />
            <span>TEXOR</span>
          </button>
        )}
      </aside>
    );
  }

  function renderPdfCompare() {
    return (
      <main ref={pdfCompareRef} className={`pdf-compare ${leftPaneVisible ? 'has-left-pane' : 'has-single-pane'}`} style={pdfCompareStyle}>
        {(compareRelationshipSummary || activeCompareEntryContext) && leftPaneVisible ? (
          <div className="compare-lineage-banner">
            {compareRelationshipSummary ? (
              <>
                <strong>{versionPathHeadingLabel('revision')}</strong>
                <div className="compare-lineage-banner__path">
                  {compareRelationshipSegments.map((item, index) =>
                    item.type === 'version' && item.versionId ? (
                      <button type="button" key={`${item.versionId}-${index}`} className="compare-lineage-banner__version" onClick={() => openVersionInHistory(item.versionId || '')}>
                        {item.label}
                      </button>
                    ) : (
                      <span key={`${item.label}-${index}`} className="compare-lineage-banner__separator">
                        {item.label}
                      </span>
                    ),
                  )}
                </div>
              </>
            ) : null}
            {currentCompareActionLabel && leftVersion && rightVersion ? (
              <button
                type="button"
                className="compare-lineage-banner__action compare-lineage-banner__action--primary"
                onClick={() => openVersionCompare(leftVersion.id, rightVersion.id)}
                title={versionCompareActionTitle(leftVersion, rightVersion, currentCompareContext?.pathLabel)}
              >
                {currentCompareActionLabel}
              </button>
            ) : null}
            {compareSharedAncestor && leftVersion && rightVersion && compareSharedAncestor.id !== leftVersion.id && compareSharedAncestor.id !== rightVersion.id ? (
              <button
                type="button"
                className="compare-lineage-banner__action"
                onClick={() => openVersionCompare(compareSharedAncestor.id, rightVersion.id)}
              >
                {versionCompareShortcutLabel('split', compareSharedAncestor, rightVersion, workspace?.versions || [])}
              </button>
            ) : null}
            {activeCompareEntryContext ? (
              <div className="compare-lineage-banner__entry" title={compareEntryHintTitle}>
                <span className="compare-lineage-banner__entry-label">{activeCompareEntryPresentation?.label || 'Opened from observer'}</span>
                <span className="compare-lineage-banner__entry-copy">Changed region</span>
                <button
                  type="button"
                  className="compare-lineage-banner__entry-chip"
                  onClick={() => openVersionInHistory(activeCompareEntryContext.focusVersionId, activeCompareEntryContext.regionQuery, {
                    kind: 'observer-saved-region',
                    regionLabel: activeCompareEntryContext.regionLabel,
                    regionQuery: activeCompareEntryContext.regionQuery,
                    compareReferenceVersionId: activeCompareEntryContext.referenceVersionId,
                  })}
                  title={activeCompareEntryPresentation?.focusTitle || compareEntryHintTitle}
                >
                  {activeCompareEntryContext.regionLabel}
                </button>
                <span className="compare-lineage-banner__entry-copy">in saved revision</span>
                {rightVersion ? (
                  <button
                    type="button"
                    className="compare-lineage-banner__entry-link"
                    onClick={() => openVersionInHistory(rightVersion.id, activeCompareEntryContext.regionQuery, {
                      kind: 'observer-saved-region',
                      regionLabel: activeCompareEntryContext.regionLabel,
                      regionQuery: activeCompareEntryContext.regionQuery,
                      compareReferenceVersionId: activeCompareEntryContext.referenceVersionId,
                    })}
                    title={compareEntryHintTitle}
                  >
                    {rightVersion.label}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {leftPaneVisible ? (
          <>
            <section className="pdf-pane previous-pane">
              <div className="pane-label">
                <div className="pane-label__main">
                  <span>Previous</span>
                  <select value={leftPaneMode} onChange={(event) => setLeftPaneMode(event.target.value as LeftPaneMode)} aria-label="选择左侧视图">
                    <option value="previous">Previous</option>
                    <option value="latex">LaTeX</option>
                    <option value="files">Files</option>
                  </select>
                  <select
                    value={leftVersion?.id || ''}
                    onChange={(event) => selectComparison('left', event.target.value)}
                    aria-label="选择左侧版本"
                    disabled={leftPaneMode !== 'previous' || !workspace || versionOptions.length < 2}
                  >
                    <option value="">None</option>
                    {versionOptions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.label}
                      </option>
                    ))}
                  </select>
                  {leftPaneMode === 'previous' && leftVersion ? (
                    <div className="pane-label__meta">
                      {leftVersionStatusLabel ? <span>{leftVersionStatusLabel}</span> : null}
                      {leftVersionBranchLabel ? <span>{leftVersionBranchLabel}</span> : null}
                      {leftVersionLineageLabel ? <span className="is-lineage">{leftVersionLineageLabel}</span> : null}
                      {leftVersionRelationLabel ? <span className="is-relation">{leftVersionRelationLabel}</span> : null}
                    </div>
                  ) : null}
                </div>
                <div className="pane-label__actions">
                  {leftPaneMode === 'previous' && manualVersionSelection ? (
                    <button type="button" className="pane-reset" onClick={resetComparison}>
                      最新
                    </button>
                  ) : null}
                  <label
                    className="pane-visibility-toggle"
                    title={leftPaneMode === 'previous' ? '切换 Previous context 信息浮层' : '切换 Current context 信息浮层'}
                  >
                    <input type="checkbox" checked={previousContextVisible} onChange={(event) => setPreviousContextVisible(event.target.checked)} />
                    <span>Context</span>
                  </label>
                </div>
              </div>
              {previousContextVisible ? (
                <VersionInsightCard
                  version={leftPaneMode === 'latex' || leftPaneMode === 'files' ? rightVersion : leftVersion}
                  tone={leftPaneMode === 'latex' || leftPaneMode === 'files' ? 'current' : 'previous'}
                  heading={leftPaneMode === 'latex' || leftPaneMode === 'files' ? 'Current context' : 'Previous context'}
                  branchLabel={leftPaneMode === 'latex' || leftPaneMode === 'files' ? rightVersionBranchLabel : leftVersionBranchLabel}
                  statusLabel={leftPaneMode === 'latex' || leftPaneMode === 'files' ? rightVersionStatusLabel : leftVersionStatusLabel}
                  lineageLabel={leftPaneMode === 'latex' || leftPaneMode === 'files' ? rightVersionLineageLabel : leftVersionLineageLabel}
                  relationLabel={leftPaneMode === 'latex' || leftPaneMode === 'files' ? rightVersionRelationLabel : leftVersionRelationLabel}
                  lineageBreadcrumb={leftPaneMode === 'latex' || leftPaneMode === 'files' ? rightVersionLineageBreadcrumb : leftVersionLineageBreadcrumb}
                  compareReferenceVersion={leftVersion}
                  compareFocusVersion={rightVersion}
                  compareVersions={workspace?.versions}
                  onCompareVersions={openVersionCompare}
                  onSelectVersion={openVersionInHistory}
                />
              ) : null}
              {leftPaneMode === 'files' ? (
                renderWorkspaceFilesPanel()
              ) : leftPaneMode === 'latex' ? (
                rightVersion ? (
                <LatexSourceViewer
                    latex={rightVersion.latex}
                    heading={`${rightVersion.label} · Current LaTeX`}
                    versionLabel={rightVersion.label}
                    projectTitle={workspace?.paper.title}
                    manuscriptState={rightVersion.manuscriptState}
                    onCtrlClickLine={(target) => void handleLatexCtrlClick(target)}
                  />
                ) : (
                  <div className="pdf-empty">当前版本源码</div>
                )
              ) : previousPdf ? (
                <SelectablePdf key={`previous:${leftVersion?.id || previousPdf}`} title="Previous version PDF" pdfUrl={previousPdf} />
              ) : showSourceDiffFallback && leftVersion && rightVersion ? (
                <SourceDiffFallback version={leftVersion} reference={rightVersion} side="previous" message={diffFailureNotice} />
              ) : (
                <div className="pdf-empty">上一版本</div>
              )}
            </section>

            <div
              className={`column-resizer ${activeResizeTarget === 'previous-pane' ? 'is-active' : ''}`}
              role="separator"
              aria-label="调整 Previous 面板宽度"
              aria-orientation="vertical"
              aria-valuenow={Math.round(previousPaneWidth)}
              tabIndex={0}
              onPointerDown={(event) => beginResize('previous-pane', event)}
              onKeyDown={(event) => handleResizerKeyDown('previous-pane', event)}
            />
          </>
        ) : null}

        <section className="pdf-pane current-pane">
          <div className="pane-label">
            <div className="pane-label__main">
              <span>Current</span>
              <select
                value={rightVersion?.id || ''}
                onChange={(event) => selectComparison('right', event.target.value)}
                aria-label="选择右侧版本"
                disabled={!workspace}
              >
                {versionOptions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.label}
                  </option>
                ))}
              </select>
              {rightVersion ? (
                <div className="pane-label__meta">
                  {rightVersionStatusLabel ? <span>{rightVersionStatusLabel}</span> : null}
                  {rightVersionBranchLabel ? <span>{rightVersionBranchLabel}</span> : null}
                  {rightVersionLineageLabel ? <span className="is-lineage">{rightVersionLineageLabel}</span> : null}
                  {rightVersionRelationLabel ? <span className="is-relation">{rightVersionRelationLabel}</span> : null}
                  {activeCompareEntryContext ? (
                    <button
                      type="button"
                      className="pane-label__entry"
                      onClick={() => openVersionInHistory(activeCompareEntryContext.focusVersionId, activeCompareEntryContext.regionQuery, {
                        kind: 'observer-saved-region',
                        regionLabel: activeCompareEntryContext.regionLabel,
                        regionQuery: activeCompareEntryContext.regionQuery,
                        compareReferenceVersionId: activeCompareEntryContext.referenceVersionId,
                      })}
                      title={activeCompareEntryPresentation?.focusTitle || compareEntryHintTitle}
                    >
                      <strong>{activeCompareEntryPresentation?.label || 'Opened from observer'}</strong>
                      <span>{activeCompareEntryContext.regionLabel}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="pane-label__actions">
              {!leftPaneVisible ? (
                <button
                  type="button"
                  className="pane-reset"
                  onClick={() => setLeftPaneOpen(true)}
                  aria-label="显示左侧辅助面板"
                >
                  <ChevronRight size={14} />
                  <span>辅助</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="pane-reset"
                  onClick={() => setLeftPaneOpen(false)}
                  aria-label="收起左侧辅助面板"
                >
                  <ChevronLeft size={14} />
                  <span>聚焦论文</span>
                </button>
              )}
              <label className="pane-visibility-toggle" title="切换 Current context 信息浮层">
                <input type="checkbox" checked={currentContextVisible} onChange={(event) => setCurrentContextVisible(event.target.checked)} />
                <span>Context</span>
              </label>
            </div>
          </div>
          {currentContextVisible ? (
            <VersionInsightCard
              version={rightVersion}
              tone="current"
              heading="Current context"
              branchLabel={rightVersionBranchLabel}
              statusLabel={rightVersionStatusLabel}
              lineageLabel={rightVersionLineageLabel}
              relationLabel={rightVersionRelationLabel}
              lineageBreadcrumb={rightVersionLineageBreadcrumb}
              compareReferenceVersion={leftVersion}
              compareFocusVersion={rightVersion}
              compareVersions={workspace?.versions}
              onCompareVersions={openVersionCompare}
              onSelectVersion={openVersionInHistory}
              entry={activeCompareVersionInsightEntry}
              onOpenEntryRegion={openVersionInHistory}
            />
          ) : null}
          {currentPdf ? (
            <SelectablePdf
              key={`current:${rightVersion?.id || currentPdf}`}
              title="Current version PDF"
              pdfUrl={currentPdf}
              selectable
              clearSelectionSignal={pdfSelectionClearSignal}
              jumpTarget={pdfJumpTarget}
              onSelectRegion={(selection) => void handlePdfRegionSelection(selection)}
              onCtrlClickRegion={(selection) => void handlePdfCtrlClick(selection)}
              onClearSelection={() => setAnnotationTarget(null)}
            />
          ) : showSourceDiffFallback && leftVersion && rightVersion ? (
            <SourceDiffFallback version={rightVersion} reference={leftVersion} side="current" message={diffFailureNotice} />
          ) : (
            <div className="pdf-empty">当前版本</div>
          )}
        </section>
      </main>
    );
  }

  function renderWorkspaceBootstrapState() {
    const headline = workspaceBootstrapHeadline(observedDraftingMode, observedCommand?.status);
    const description = workspaceBootstrapDescription(observedDraftingMode, observedCommand?.status);
    const statusMessage = commandMessage(observedCommand);
    const isFailed = observedCommand?.status === 'failed';

    return (
      <section className={`workspace-placeholder ${isFailed ? 'is-failed' : ''}`} aria-live="polite">
        <div className="workspace-placeholder__card">
          <div className="workspace-placeholder__eyebrow">
            <span>TEXOR</span>
            <strong>{observedDraftingMode === 'understand-project' ? '源库理解阶段' : observedDraftingMode === 'initial-draft' ? 'v1 起稿阶段' : '工作区初始化'}</strong>
          </div>
          <h2>{headline}</h2>
          <p>{description}</p>
          <div className="workspace-placeholder__status">
            {isFailed ? <CircleAlert size={18} /> : <LoaderCircle className="spin" size={18} />}
            <span>{statusMessage}</span>
          </div>
          <div className="workspace-placeholder__note">
            {observedDraftingMode === 'understand-project'
              ? '这一阶段不会生成论文版本，也不会出现可编辑正文。源库理解完成后，系统会自动进入首版初稿生成。'
              : '首版主稿保存完成后，写作界面会自动切换到可浏览和可修改的论文视图。'}
          </div>
        </div>
      </section>
    );
  }

  function renderDesktopWorkbenchCard() {
    if (!desktopReady) {
      return null;
    }

    return (
      <section className="desktop-launchpad" aria-label="桌面版工作区入口">
        <div className="desktop-launchpad__copy">
          <span>Desktop V1</span>
          <strong>论文优先的研究写作 IDE</strong>
          <p>中心始终是论文，代码、终端和远端执行围绕稿件展开。你可以直接打开本地项目，或通过 SSH 连接远端研究环境。</p>
          {desktopReady && shortWindowSessionKey ? (
            <div className="desktop-launchpad__window-chip">
              <strong>Current window</strong>
              <span>session {shortWindowSessionKey}</span>
            </div>
          ) : null}
        </div>

        <div className="desktop-launchpad__actions">
          <button type="button" className="icon-button" onClick={() => void importDesktopVSCodeSettings()} disabled={isBusy}>
            {busyState === 'import-vscode-config' ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
            <span>{vscodeImported ? '重新导入 VS Code 配置' : '导入 VS Code 配置'}</span>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void openWorkspaceInNewWindow()}
            disabled={isBusy || !window.texorDesktop}
          >
            {busyState === 'open-workspace-window' && pendingWindowPaperId === '__blank__' ? <LoaderCircle className="spin" size={15} /> : <PanelsTopLeft size={15} />}
            <span>新建窗口</span>
          </button>
        </div>

        {health?.desktop?.diagnostics?.logPath ? (
          <div className={`desktop-launchpad__diagnostics is-${health.desktop.diagnostics.startupStatus || 'ready'}`}>
            <strong>Desktop diagnostics</strong>
            <span>{health.desktop.diagnostics.startupStatus === 'degraded' ? '启动处于降级状态' : '启动日志已启用'}</span>
            <code>{health.desktop.diagnostics.logPath}</code>
            {health.desktop.diagnostics.logChannels?.length ? (
              <div className="desktop-launchpad__diagnostic-channels">
                {health.desktop.diagnostics.logChannels.map((entry) => (
                  <span key={entry.channel} className={entry.exists ? 'is-present' : 'is-missing'}>
                    {entry.channel.replace('desktop-', '')}: {entry.exists ? 'ok' : 'missing'}
                  </span>
                ))}
              </div>
            ) : null}
            {health.desktop.diagnostics.bundleAvailable ? (
              <button type="button" className="icon-button" onClick={() => void handleExportDesktopDiagnostics()} disabled={isBusy}>
                {busyState === 'export-desktop-diagnostics' ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />}
                <span>导出诊断包</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="desktop-launchpad__grid">
          <label className="sidebar-field">
            <span>项目来源</span>
            <div className="mode-switch">
              <button type="button" className={connectionMode === 'local' ? 'is-active' : ''} onClick={() => setConnectionMode('local')}>
                本地
              </button>
              <button type="button" className={connectionMode === 'ssh' ? 'is-active' : ''} onClick={() => setConnectionMode('ssh')}>
                SSH
              </button>
            </div>
          </label>

          {connectionMode === 'ssh' ? (
            <>
              <label className="sidebar-field">
                <span>SSH 主机</span>
                <select className="path-input" value={sshHostAlias} onChange={(event) => setSshHostAlias(event.target.value)}>
                  {sshHosts.length ? sshHosts.map((host) => (
                    <option key={host.alias} value={host.alias}>
                      {host.alias}{host.user ? ` · ${host.user}` : ''}
                    </option>
                  )) : <option value="">未发现 ~/.ssh/config 主机</option>}
                </select>
              </label>
              <label className="sidebar-field span-2">
                <span>远端项目路径</span>
                <input
                  className="path-input"
                  value={remoteProjectPath}
                  onChange={(event) => setRemoteProjectPath(event.target.value)}
                  placeholder="/home/user/research/project"
                />
              </label>
            </>
          ) : (
            <label className="sidebar-field span-2">
              <span>本地项目路径</span>
              <input
                className="path-input"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder="/path/to/source-repo"
              />
            </label>
          )}
        </div>

        <div className="desktop-launchpad__footer">
          <span>{preparedTarget ? `当前目标: ${preparedTarget.displayLabel}` : '尚未准备项目目标'}</span>
          <button type="button" className="icon-button primary-action" onClick={() => void prepareCurrentExecutionTarget()} disabled={isBusy}>
            {busyState === 'prepare-project' ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}
            <span>准备项目</span>
          </button>
        </div>
      </section>
    );
  }

  function renderWorkspaceFilesPanel() {
    const target = workspaceExecutionTarget(workspace, projectPath);

    return (
      <section className="workspace-files-panel">
        <div className="workspace-files-panel__header">
          <div>
            <span>Code Workspace</span>
            <strong>{workspaceDisplayRoot(workspace, preparedTarget, projectPath) || '未打开项目'}</strong>
          </div>
          <div className="workspace-files-panel__meta">
            <span>{executionTargetLabel(target || undefined)}</span>
            {workspaceFileDirty ? <em>未保存</em> : null}
          </div>
        </div>

        <div className="workspace-files-panel__body">
          <aside className="workspace-files-panel__tree">
            {workspaceFiles.length ? (
              workspaceFiles.map((node) => (
                <button
                  type="button"
                  key={node.path}
                  className={`workspace-files-panel__node is-${node.kind} ${activeWorkspaceFile === node.path ? 'is-active' : ''}`}
                  onClick={() => {
                    if (node.kind === 'file') {
                      setActiveWorkspaceFile(node.path);
                    }
                  }}
                  style={{ paddingLeft: `${12 + node.depth * 14}px` }}
                  disabled={node.kind !== 'file'}
                >
                  <span>{node.name}</span>
                </button>
              ))
            ) : (
              <div className="workspace-files-panel__empty">打开项目后这里会显示代码与论文文件树</div>
            )}
          </aside>

          <div className="workspace-files-panel__editor">
            <div className="workspace-files-panel__editor-head">
              <strong>{activeWorkspaceFile || '选择一个文件'}</strong>
              <div className="workspace-files-panel__editor-actions">
                <button type="button" className="workspace-chat-sidebar__secondary-button" onClick={() => void saveActiveWorkspaceFile()} disabled={!workspaceFileDirty || isBusy || !activeWorkspaceFile}>
                  保存
                </button>
              </div>
            </div>
            <textarea
              className="workspace-files-panel__textarea"
              value={workspaceFileContent}
              onChange={(event) => {
                setWorkspaceFileContent(event.target.value);
                setWorkspaceFileDirty(true);
              }}
              placeholder="这里可以查看和编辑论文项目里的源文件。"
              disabled={!activeWorkspaceFile}
            />
          </div>
        </div>

        <div className="workspace-files-panel__command">
          <div className="workspace-files-panel__command-bar">
            <input
              className="path-input"
              value={workspaceCommandInput}
              onChange={(event) => setWorkspaceCommandInput(event.target.value)}
              placeholder="输入要在项目中执行的命令"
            />
            <button type="button" className="workspace-chat-sidebar__primary-button" onClick={() => void runActiveWorkspaceCommand()} disabled={isBusy || !target}>
              {busyState === 'workspace-command' ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
              <span>运行</span>
            </button>
          </div>
          <pre className="workspace-files-panel__command-output">{workspaceCommandResult ? `${workspaceCommandResult.stdout}${workspaceCommandResult.stderr ? `\n${workspaceCommandResult.stderr}` : ''}`.trim() || '(无输出)' : '命令输出会显示在这里。'}</pre>
        </div>
      </section>
    );
  }

  function renderProjectHub() {
    return (
      <main className="project-hub">
        {error ? (
          <div className="error-banner">
            <CircleAlert size={15} />
            <span>{error}</span>
          </div>
        ) : null}

        {renderDesktopWorkbenchCard()}

        <section className="hub-gallery" aria-label="论文项目预览">
          <button
            type="button"
            className="hub-preview-card hub-preview-card--new"
            onClick={() => openProjectSetup('new')}
            disabled={isBusy}
          >
            <div className="hub-preview-card__frame">
              <div className="hub-preview-card__sheet hub-preview-card__sheet--blank">
                <div className="hub-preview-card__blank-mark">
                  <FilePlus2 size={34} />
                </div>
                <div className="hub-preview-card__blank-lines" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
            <div className="hub-preview-card__footer">
              <strong>新建稿库</strong>
              <span>Blank manuscript space</span>
            </div>
          </button>

          {workspaceList.map((item) => {
            const isActive = workspace?.paper.id === item.paperId;
            const cardTitle = item.title || item.projectRoot || 'Untitled Manuscript';
            const isOpeningInNewWindow = busyState === 'open-workspace-window' && pendingWindowPaperId === item.paperId;
            return (
              <article key={item.paperId} className={`hub-preview-card ${isActive ? 'is-active' : ''}`}>
                <div
                  className="hub-preview-card__main"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => handleHubCardOpen(item.paperId, event)}
                  onPointerDown={(event) => handleHubCardPointerDown(item.paperId, event)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleHubCardOpen(item.paperId, event);
                    }
                  }}
                  aria-label={desktopReady ? `打开 ${cardTitle}。按住 Command、Control 或 Shift 可在新窗口打开。` : `打开 ${cardTitle}`}
                >
                  <div className="hub-preview-card__frame">
                    <PdfThumbnailPreview paperId={item.paperId} versionId={item.currentVersionId} title={cardTitle} />
                    <div className="hub-preview-card__dogear" aria-hidden="true" />
                  </div>
                  <div className="hub-preview-card__footer">
                    <div className="hub-preview-card__footer-main">
                      <strong>{cardTitle}</strong>
                      <span>{dateLabel(item.updatedAt)}</span>
                    </div>
                    {desktopReady ? (
                      <div className="hub-preview-card__window-hint">
                        <PanelsTopLeft size={12} />
                        <span>Cmd/Ctrl/Shift 或中键可新开窗口</span>
                      </div>
                    ) : null}
                  </div>
                </div>
                {desktopReady ? (
                  <button
                    type="button"
                    className="hub-preview-card__secondary-action"
                    onClick={() => void openWorkspaceInNewWindow(item.paperId)}
                    disabled={isBusy}
                    aria-label={`在新窗口打开 ${cardTitle}`}
                    title="在新窗口打开"
                  >
                    {isOpeningInNewWindow ? <LoaderCircle className="spin" size={14} /> : <PanelsTopLeft size={14} />}
                    <span>{isOpeningInNewWindow ? '正在打开…' : '新窗口打开'}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="workspace-item__delete"
                  onClick={() => void removeWorkspace(item)}
                  disabled={isBusy}
                  aria-label={`删除 ${cardTitle}`}
                  title="删除项目记录"
                >
                  <X size={13} />
                </button>
                <button
                  type="button"
                  className="workspace-item__action workspace-item__open-window"
                  onClick={() => void openWorkspaceInNewWindow(item.paperId)}
                  disabled={isBusy}
                  aria-label={`在新窗口打开 ${cardTitle}`}
                  title="在新窗口打开"
                >
                  {isOpeningInNewWindow ? <LoaderCircle className="spin" size={13} /> : <ExternalLink size={13} />}
                </button>
              </article>
            );
          })}
        </section>

        {projectLoaderOpen ? (
          <div className="hub-modal-backdrop" onClick={closeProjectSetup}>
            <section className="hub-modal" role="dialog" aria-modal="true" aria-labelledby="hub-modal-title" onClick={(event) => event.stopPropagation()}>
              <div className="hub-modal__header">
                <div>
                  <span>{projectMode === 'new' ? '新建稿库' : '载入稿库'}</span>
                  <strong id="hub-modal-title">{projectMode === 'new' ? '从零开始建立稿库' : '接着已有稿件继续写作或返修'}</strong>
                </div>
                <button type="button" className="ghost-icon-button" onClick={closeProjectSetup} aria-label="关闭初始化弹窗">
                  <X size={16} />
                </button>
              </div>

              <div className="hub-modal__body">
                <div className="mode-switch" role="tablist" aria-label="稿库模式">
                  <button type="button" className={projectMode === 'new' ? 'is-active' : ''} onClick={() => setProjectMode('new')}>
                    <FilePlus2 size={14} />
                    <span>新建稿库</span>
                  </button>
                  <button type="button" className={projectMode === 'load' ? 'is-active' : ''} onClick={() => setProjectMode('load')}>
                    <FolderOpen size={14} />
                    <span>载入稿库</span>
                  </button>
                </div>

                <div className="hub-setup-grid">
                  <label className="sidebar-field span-2">
                    <span>源库路径</span>
                    <input
                      className="path-input"
                      value={projectPath}
                      onChange={(event) => setProjectPath(event.target.value)}
                      placeholder="/path/to/source-repo"
                      aria-label="源库路径"
                    />
                    <small>
                      {projectMode === 'new'
                        ? '代码、实验和结果所在目录。'
                        : '当前稿件对应的代码与结果目录。'}
                    </small>
                  </label>

                  <label className="sidebar-field">
                    <span>目标期刊或会议</span>
                    <div className="journal-combobox">
                      <input
                        className="journal-input"
                        value={targetJournal}
                        onChange={(event) => {
                          setTargetJournal(event.target.value);
                          setSuggestionsOpen(true);
                        }}
                        onFocus={() => setSuggestionsOpen(templateSuggestions.length > 0)}
                        onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
                        placeholder="默认 arXiv"
                        aria-label="目标期刊"
                        autoComplete="off"
                      />
                      {suggestionsOpen && templateSuggestions.length > 0 ? (
                        <div className="journal-suggestions">
                          {templateSuggestions.map((suggestion) => (
                            <button
                              type="button"
                              key={`${suggestion.id}-${suggestion.label}`}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setTargetJournal(suggestion.label);
                                setSelectedTemplate(suggestion);
                                setTemplateStatus(null);
                                setSuggestionsOpen(false);
                                if (!suggestion.cached) {
                                  setStatus('首次使用，下载模板');
                                  window.setTimeout(() => {
                                    void ensureSelectedTemplateForUse();
                                  }, 0);
                                }
                              }}
                            >
                              <span>{suggestion.label}</span>
                              <small>{suggestion.publisher} · {suggestion.templateFamily} · {suggestion.cached ? '已缓存' : '首次使用需下载'}</small>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <small>留空默认使用 arXiv。</small>
                  </label>

                  <label className="sidebar-field">
                    <span>已有论文入口 .tex</span>
                    <input
                      className="path-input"
                      value={texPath}
                      onChange={(event) => setTexPath(event.target.value)}
                      placeholder={projectMode === 'new' ? '可选，用于已有初稿' : '返修或续写时建议提供'}
                      aria-label="已有论文 tex 文件路径"
                    />
                    <small>
                      {projectMode === 'new'
                        ? '可选；提供后会作为起稿。'
                        : '返修或续写时建议提供。'}
                    </small>
                  </label>
                </div>

                <details className="hub-advanced">
                  <summary>更多设置</summary>
                  <div className="hub-advanced__body">
                    <div className="hub-setup-grid">
                      <label className="sidebar-field">
                        <span>Agent 后端</span>
                        <select className="path-input" value={agentBackend} onChange={(event) => setAgentBackend(event.target.value as AgentBackend)}>
                          <option value="texor-agent">自定义模型 API</option>
                          <option value="codex-cli">Codex CLI</option>
                          <option value="codex-native">原生 Codex</option>
                          <option value="claude-code">Claude Code</option>
                        </select>
                      </label>

                      <label className="sidebar-field">
                        <span>任务模式</span>
                        <div className="mode-switch">
                          <button
                            type="button"
                            className={projectTaskSpeedMode === 'quick' ? 'is-active' : ''}
                            onClick={() => setProjectTaskSpeedMode('quick')}
                          >
                            快速
                          </button>
                          <button
                            type="button"
                            className={projectTaskSpeedMode === 'deep' ? 'is-active' : ''}
                            onClick={() => setProjectTaskSpeedMode('deep')}
                          >
                            深度
                          </button>
                        </div>
                      </label>
                    </div>

                    {selectedTemplate ? (
                      <div className={`template-status is-${templateStatus?.status || (selectedTemplate.cached ? 'cached' : 'pending')}`}>
                        <span>{templateStatus?.message || (selectedTemplate.cached ? '模板已缓存' : templateDownloadingId === selectedTemplate.id ? '首次使用，正在下载模板...' : '首次使用会自动下载模板')}</span>
                        {!selectedTemplate.cached && templateStatus?.status !== 'downloaded' && templateStatus?.status !== 'cached' ? (
                          <button type="button" onClick={() => void ensureSelectedTemplateForUse()} disabled={isBusy}>
                            {templateDownloadingId === selectedTemplate.id ? <LoaderCircle className="spin" size={13} /> : null}
                            <span>{templateDownloadingId === selectedTemplate.id ? '下载中' : '下载'}</span>
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    {agentBackend === 'texor-agent' ? (
                      <div className="hub-setup-grid">
                        <label className="sidebar-field span-2">
                          <span>Base URL</span>
                          <input className="path-input" value={agentBaseUrl} onChange={(event) => setAgentBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
                        </label>
                        <label className="sidebar-field">
                          <span>模型</span>
                          <input className="path-input" value={agentModel} onChange={(event) => setAgentModel(event.target.value)} placeholder={DEFAULT_TEXOR_AGENT_MODEL} />
                        </label>
                        <label className="sidebar-field">
                          <span>图片模型</span>
                          <input className="path-input" value={agentImageModel} onChange={(event) => setAgentImageModel(event.target.value)} placeholder="gpt-image-1" />
                        </label>
                        <label className="sidebar-field span-2">
                          <span>API Key</span>
                          <input className="path-input" value={agentApiKey} onChange={(event) => setAgentApiKey(event.target.value)} placeholder="sk-..." type="password" />
                        </label>
                      </div>
                    ) : isCodexBackend(agentBackend) ? (
                      <div className="hub-setup-grid">
                        <label className="sidebar-field">
                          <span>Codex 模型</span>
                          <input
                            className="path-input"
                            value={codexModel}
                            onChange={(event) => setCodexModel(event.target.value)}
                            placeholder={DEFAULT_CODEX_MODEL}
                          />
                        </label>
                        <label className="sidebar-field">
                          <span>推理强度</span>
                          <select className="path-input" value={codexReasoningEffort} onChange={(event) => setCodexReasoningEffort(event.target.value)}>
                            <option value="xhigh">xhigh</option>
                            <option value="high">high</option>
                            <option value="medium">medium</option>
                            <option value="low">low</option>
                            <option value="minimal">minimal</option>
                          </select>
                        </label>
                      </div>
                    ) : agentBackend === 'claude-code' ? (
                      <div className="hub-setup-grid">
                        <label className="sidebar-field span-2">
                          <span>Claude 模型</span>
                          <input
                            className="path-input"
                            value={claudeModel}
                            onChange={(event) => setClaudeModel(event.target.value)}
                            placeholder="claude-sonnet-4-20250514"
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                </details>

                <div className="loader-actions">
                  <button type="button" className="icon-button sidebar-secondary" onClick={() => void importExistingTexDraft()} disabled={isBusy}>
                    {busyState === 'import-tex' ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}
                    <span>导入到稿库</span>
                  </button>
                  <button type="button" className="icon-button primary-action sidebar-start" onClick={() => void startProjectWithCodex()} disabled={isBusy}>
                    {busyState === 'load-project' || busyState === 'new-project' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
                    <span>
                      {projectMode === 'new'
                        ? texPath.trim()
                          ? '创建稿库并初始化'
                          : '创建稿库并开始写作'
                        : '载入稿库并初始化'}
                    </span>
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </main>
    );
  }

  function renderWorkspaceStage() {
    const minimalToolbarTitle = workspace ? workspace.paper.title : topbarState;
    return (
      <main className="writing-stage">
        {error ? (
          <div className="error-banner">
            <CircleAlert size={15} />
            <span>{error}</span>
          </div>
        ) : null}
        {!error && pendingWorkspaceUpdate ? (
          <div className="workspace-update-banner">
            <div className="workspace-update-banner__copy">
              <strong>检测到其他窗口的新版本 {pendingWorkspaceUpdate.label}</strong>
              <span>{pendingWorkspaceUpdate.summary} · {dateLabel(pendingWorkspaceUpdate.createdAt)}</span>
            </div>
            <div className="workspace-update-banner__actions">
              <button type="button" className="workspace-chat-sidebar__secondary-button" onClick={() => void followPendingWorkspaceUpdate()} disabled={isBusy}>
                {busyState === 'sync-external-version' ? <LoaderCircle className="spin" size={14} /> : <ArrowUp size={14} />}
                <span>跟进最新版本</span>
              </button>
              <button type="button" className="workspace-chat-sidebar__secondary-button" onClick={deferPendingWorkspaceUpdate} disabled={isBusy}>
                <span>稍后处理</span>
              </button>
            </div>
          </div>
        ) : null}

        <section className="workspace-stage-shell">
          {workspaceToolbarVisible ? (
            <header className="workspace-toolbar">
              <div className="workspace-toolbar__group workspace-toolbar__group--left">
                <button type="button" className="workspace-toolbar__button workspace-toolbar__button--back" onClick={() => setScreenMode('hub')} aria-label="返回项目首页">
                  <ArrowLeft size={15} />
                  <span>主页</span>
                </button>
                {isDesktopResizableLayout() ? (
                  <button
                    type="button"
                    className="workspace-toolbar__button"
                    onClick={() => setLeftPaneOpen((value) => !value)}
                    aria-pressed={leftPaneOpen}
                    aria-label={leftPaneOpen ? '隐藏左侧辅助面板' : '显示左侧辅助面板'}
                  >
                    {leftPaneOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                    <span>{leftPaneOpen ? '聚焦论文' : '辅助'}</span>
                  </button>
                ) : null}
                {workspace ? (
                  <button
                    type="button"
                    className="workspace-toolbar__button"
                    onClick={() => {
                      setDraftVersionId(workspace.currentVersion.id);
                      setDraftOpen(true);
                    }}
                  >
                    <History size={14} />
                    <span>历史</span>
                  </button>
                ) : null}
              </div>

              <div className="workspace-toolbar__group workspace-toolbar__group--center">
                <button
                  type="button"
                  className={`workspace-toolbar__brand is-${observedCommand?.status || (health?.ok ? 'ready' : 'connecting')}`}
                  onClick={() => setObserverOpen((value) => !value)}
                  aria-expanded={observerOpen}
                  aria-label="切换 TEXOR 会话栏"
                >
                  <span>{shortWindowSessionKey ? `TEXOR · ${shortWindowSessionKey}` : 'TEXOR'}</span>
                  <strong>{minimalToolbarTitle}</strong>
                </button>
              </div>

              <div className="workspace-toolbar__group workspace-toolbar__group--right">
                {canPauseObservedCommand ? (
                  <button type="button" className="workspace-toolbar__button workspace-toolbar__button--accent" onClick={() => void pauseObservedCommand()} disabled={isBusy} aria-label="暂停">
                    {busyState === 'pause-command' ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
                  </button>
                ) : canResumeObservedCommand && observedCommand ? (
                  <button type="button" className="workspace-toolbar__button workspace-toolbar__button--accent" onClick={() => void resumeCodexCommand(observedCommand)} disabled={isBusy} aria-label="继续">
                    <RotateCcw size={14} />
                  </button>
                ) : null}

                {(canPauseObservedCommand || canResumeObservedCommand) ? (
                  <button type="button" className="workspace-toolbar__button workspace-toolbar__button--danger" onClick={() => void terminateObservedCommand()} disabled={isBusy} aria-label="终止">
                    <X size={14} />
                  </button>
                ) : null}
                <div className={`workspace-toolbar__actions-menu ${workspaceActionsOpen ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    className="workspace-toolbar__button workspace-toolbar__button--ghost"
                    onClick={() => setWorkspaceActionsOpen((value) => !value)}
                    aria-expanded={workspaceActionsOpen}
                    aria-label="更多操作"
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {workspaceActionsOpen ? (
                    <div className="workspace-model-switcher__panel">
                      <div className="workspace-model-switcher__header">
                        <strong>工作区操作</strong>
                        <span>把次要控制收在这里，保持论文主视图更安静。</span>
                      </div>
                      <div className="workspace-model-switcher__actions workspace-model-switcher__actions--stacked">
                        {workspace ? (
                          <button
                            type="button"
                            className="workspace-chat-sidebar__secondary-button"
                            onClick={() => {
                              setWorkspaceActionsOpen(false);
                              void openWorkspaceInNewWindow(workspace.paper.id);
                            }}
                            disabled={isBusy}
                          >
                            {busyState === 'open-workspace-window' && pendingWindowPaperId === workspace.paper.id ? <LoaderCircle className="spin" size={14} /> : <PanelsTopLeft size={14} />}
                            <span>在新窗口继续写</span>
                          </button>
                        ) : null}
                        {workspace ? (
                          <button
                            type="button"
                            className="workspace-chat-sidebar__secondary-button"
                            onClick={() => {
                              setWorkspaceActionsOpen(false);
                              void handleDownloadCurrentPdf();
                            }}
                            disabled={isBusy}
                          >
                            {busyState === 'download-pdf' ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
                            <span>下载 PDF</span>
                          </button>
                        ) : null}
                        {workspace ? (
                          <button
                            type="button"
                            className="workspace-chat-sidebar__secondary-button"
                            onClick={() => {
                              setWorkspaceActionsOpen(false);
                              void handleExportWorkspaceBundle();
                            }}
                            disabled={isBusy}
                          >
                            {busyState === 'export-workspace' ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}
                            <span>导出稿库</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="workspace-chat-sidebar__secondary-button"
                          onClick={() => {
                            setWorkspaceActionsOpen(false);
                            setObserverOpen((value) => !value);
                          }}
                        >
                          {observerOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                          <span>{observerOpen ? '隐藏会话栏' : '显示会话栏'}</span>
                        </button>
                        <button
                          type="button"
                          className="workspace-chat-sidebar__secondary-button"
                          onClick={() => {
                            setWorkspaceActionsOpen(false);
                            setWorkspaceToolbarVisible(false);
                          }}
                        >
                          <PanelTopClose size={14} />
                          <span>隐藏顶栏</span>
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </header>
          ) : (
            <div className="workspace-toolbar-collapsed">
              <button
                type="button"
                className="workspace-toolbar-collapsed__toggle"
                onClick={() => setWorkspaceToolbarVisible(true)}
                aria-label="展开顶栏"
              >
                <LayoutPanelTop size={14} />
                <span>{minimalToolbarTitle}</span>
              </button>
            </div>
          )}

          <div ref={workspaceCanvasRef} className="workspace-canvas" style={workspaceCanvasStyle}>
            <div className="workspace-canvas__main">
              {showWorkspaceBootstrapState ? renderWorkspaceBootstrapState() : renderPdfCompare()}
            </div>
            {observerOpen && isDesktopResizableLayout() ? (
              <div
                className={`column-resizer workspace-sidebar-resizer ${activeResizeTarget === 'observer-pane' ? 'is-active' : ''}`}
                role="separator"
                aria-label="调整会话面板宽度"
                aria-orientation="vertical"
                aria-valuenow={Math.round(observerPaneWidth)}
                tabIndex={0}
                onPointerDown={(event) => beginResize('observer-pane', event)}
                onKeyDown={(event) => handleResizerKeyDown('observer-pane', event)}
              />
            ) : null}
            {renderWorkspaceSidebar()}
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className={`studio-app ${screenMode === 'workspace' ? 'is-workspace' : 'is-hub'}`}>
      {screenMode === 'hub' ? renderProjectHub() : renderWorkspaceStage()}

      {draftOpen && workspace ? (
        <div className="draft-drawer-backdrop" onClick={() => setDraftOpen(false)}>
          <aside className="draft-drawer" role="dialog" aria-modal="true" aria-label="版本历史抽屉" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <strong>{workspace.paper.title}</strong>
                <span>{workspace.paper.targetJournal}</span>
                {shortWindowSessionKey ? <em>window {shortWindowSessionKey}</em> : null}
              </div>
              <button type="button" className="ghost-icon-button" onClick={() => setDraftOpen(false)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="drawer-body">
              <section className="drawer-history" aria-label="版本历史">
                <VersionInsightCard
                  version={draftVersion}
                  tone="neutral"
                  heading={draftVersionIsCurrent ? 'Current manuscript preview' : 'Historical manuscript preview'}
                  branchLabel={workspace && draftVersion ? versionBranchLabel(draftVersion, workspace.versions) : ''}
                  statusLabel={workspace && draftVersion ? versionLatestStatusLabel(draftVersion, workspace.currentVersion, pendingWorkspaceUpdateVersionId) : ''}
                  lineageLabel={draftVersionLineageLabel}
                  relationLabel={draftVersionRelationLabel}
                  lineageBreadcrumb={draftVersionLineageBreadcrumb}
                  compareReferenceVersion={draftVersion}
                  compareFocusVersion={rightVersion}
                  compareVersions={workspace.versions}
                  onCompareVersions={openVersionCompare}
                  onSelectVersion={openVersionInHistory}
                  entry={activeHistoryPreviewVersionInsightEntry}
                  onOpenEntryRegion={openVersionInHistory}
                />
                <div className="version-timeline-toolbar" aria-label="历史过滤">
                  {historyFilterOptions.map((option) => (
                    <button
                      type="button"
                      key={option}
                      className={`version-timeline-filter ${historyFilterMode === option ? 'is-active' : ''}`}
                      onClick={() => setHistoryFilterMode(option)}
                    >
                      <span>{historyFilterLabel(option)}</span>
                      <strong>{historyFilterCounts[option]}</strong>
                    </button>
                  ))}
                </div>
                {!draftVersionVisibleInHistoryFilter && draftVersion ? (
                  <div className="version-timeline-note">
                    当前预览停留在 {versionTypeBadge(draftVersion)} 版本，而左侧列表正在聚焦 {historyFilterLabel(historyFilterMode)}。
                  </div>
                ) : null}
                {rightVersion && draftVersion && rightVersion.id !== workspace.currentVersion.id ? (
                  <div className="version-timeline-note version-timeline-note--focus">
                    当前工作分支停留在 {rightVersion.label}。从这里点选历史版本会默认对比到这个右侧 focus，而不是自动跳回最新版本。
                  </div>
                ) : null}
                <div className="version-timeline">
                  {historyTimelineGroups.length ? historyTimelineGroups.map((group) => {
                    const { label: groupLabel, versions, containsDraftPreview, containsViewedVersion, containsLatestCurrent, containsPendingExternal, containsNavigationPath } = group;
                    const shouldForceOpen = containsDraftPreview || containsViewedVersion || containsLatestCurrent || containsPendingExternal || containsNavigationPath;
                    const collapsed = !shouldForceOpen && collapsedHistoryGroups[groupLabel];
                    const groupStatus = containsPendingExternal
                      ? 'New in other window'
                      : containsNavigationPath
                        ? 'Lineage path'
                      : containsDraftPreview
                        ? 'Previewed'
                        : containsViewedVersion
                          ? 'Current view'
                          : containsLatestCurrent
                            ? 'Latest'
                            : '';
                    return (
                      <section className={`version-timeline-group ${collapsed ? 'is-collapsed' : ''} ${containsNavigationPath ? 'is-highlighted' : ''}`} key={groupLabel} aria-label={groupLabel}>
                        <button
                          type="button"
                          className="version-timeline-group__toggle"
                          aria-expanded={!collapsed}
                          onClick={() =>
                            setCollapsedHistoryGroups((current) => ({
                              ...current,
                              [groupLabel]: !collapsed,
                            }))
                          }
                        >
                          <div className="version-timeline-group__label">
                            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                            <span>{groupLabel}</span>
                          </div>
                          <div className="version-timeline-group__meta">
                            <strong>{versions.length}</strong>
                            {groupStatus ? <span>{groupStatus}</span> : null}
                          </div>
                        </button>
                        {!collapsed ? (
                          <div className="version-timeline-group__items">
                            {versions.map((version) => {
                              const touched = versionTouchedRegions(version, 3);
                              const gaps = versionOpenItems(version, 2);
                              const isLatestCurrent = version.id === workspace.currentVersion.id;
                              const isViewedVersion = version.id === rightVersion?.id;
                              const isPendingExternal = version.id === pendingWorkspaceUpdateVersionId;
                              const isNavigationPath = Boolean(historyNavigationState?.highlightedVersionIds.includes(version.id));
                              const navigationContext = historyNavigationVersionContext(version, historyNavigationState, workspace.versions, currentCompareContext);
                              const timelineCompareContext = historyTimelineCompareContext(version, workspace, rightVersion);
                              const navigationRoleLabel = navigationContext?.roleLabel || '';
                              const navigationRoleHint = navigationContext?.roleHint || '';
                              const navigationActionLabel = navigationContext?.actionLabel || '';
                              const compareActionLabel = timelineCompareContext?.compareActionLabel || '';
                              const compareSharedAncestor = timelineCompareContext?.sharedAncestor || null;
                              const timelineActionDuplicatesNavigation = Boolean(
                                navigationContext?.compareReferenceVersion?.id === version.id &&
                                navigationContext?.compareFocusVersion?.id === timelineCompareContext?.compareTarget.id,
                              );
                              const canCompareTimelineVersion = Boolean(
                                timelineCompareContext &&
                                timelineCompareContext.compareTarget.id !== version.id &&
                                !timelineActionDuplicatesNavigation,
                              );
                              const canCompareTimelineSplit = Boolean(
                                compareSharedAncestor &&
                                timelineCompareContext &&
                                compareSharedAncestor.id !== version.id &&
                                compareSharedAncestor.id !== timelineCompareContext.compareTarget.id,
                              );
                              const timelineObserverEntryActive = Boolean(
                                activeHistoryPreviewEntryContext &&
                                activeHistoryPreviewEntryContext.versionId === version.id &&
                                draftVersion?.id === version.id,
                              );
                              const branchLabel = versionBranchLabel(version, workspace.versions);
                              const headBadge = isPendingExternal
                                ? 'New in other window'
                                : isViewedVersion
                                  ? viewedVersionIsCurrent
                                    ? 'Current view'
                                    : 'Viewed now'
                                  : isLatestCurrent
                                    ? 'Latest'
                                    : dateLabel(version.createdAt);
                              return (
                                <article
                                  key={version.id}
                                  className={`version-timeline-item ${draftVersion?.id === version.id ? 'is-active' : ''} ${isPendingExternal ? 'is-pending-external' : ''} ${isViewedVersion ? 'is-viewed' : ''} ${isNavigationPath ? 'is-lineage-path' : ''}`}
                                >
                                  <div
                                    className="version-timeline-item__preview"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => previewVersionFromHistory(version)}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        previewVersionFromHistory(version);
                                      }
                                    }}
                                  >
                                    <div className="version-timeline-item__head">
                                      <strong>{version.label}</strong>
                                      <span>{headBadge}</span>
                                    </div>
                                    {navigationRoleLabel ? <div className="version-timeline-item__path-role">{navigationRoleLabel}</div> : null}
                                    {navigationContext?.relationLabel ? (
                                      <div className="version-timeline-item__path-relation">{navigationContext.relationLabel}</div>
                                    ) : null}
                                    {navigationContext?.routeSegments.length ? (
                                      <div className="version-timeline-item__path-route">
                                        <strong>{versionPathHeadingLabel('focus-route')}</strong>
                                        {navigationContext.routeSegments.map((item, index) =>
                                          item.type === 'version' && item.versionId ? (
                                            <button
                                              type="button"
                                              key={`${version.id}-${item.versionId}-${index}`}
                                              className="version-timeline-item__path-route-link"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                openVersionInHistory(item.versionId || '');
                                              }}
                                            >
                                              {item.label}
                                            </button>
                                          ) : (
                                            <span key={`${version.id}-${item.label}-${index}`} className="version-timeline-item__path-route-separator">
                                              {item.label}
                                            </span>
                                          ),
                                        )}
                                      </div>
                                    ) : null}
                                  {navigationRoleHint ? <div className="version-timeline-item__path-hint">{navigationRoleHint}</div> : null}
                                    <div className={`version-timeline-item__type is-${versionTypeLabel(version)}`}>{versionTypeBadge(version)}</div>
                                    <p>{versionSummaryLabel(version)}</p>
                                    <em>{versionTimelineMeta(version)}</em>
                                    {branchLabel ? <div className="version-timeline-item__branch">{branchLabel}</div> : null}
                                    {timelineObserverEntryActive && activeHistoryPreviewEntryPresentation ? (
                                      <div className="version-timeline-item__entry" title={activeHistoryPreviewEntryPresentation.revisionTitle}>
                                        <span className="version-timeline-item__entry-label">{activeHistoryPreviewEntryPresentation.label}</span>
                                        <button
                                          type="button"
                                          className="version-timeline-item__entry-chip"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            openVersionInHistory(version.id, activeHistoryPreviewEntryContext?.regionQuery || '', activeHistoryPreviewEntryContext);
                                          }}
                                          title={activeHistoryPreviewEntryPresentation.focusTitle}
                                        >
                                          {activeHistoryPreviewEntryContext?.regionLabel || activeHistoryPreviewEntryPresentation.detail}
                                        </button>
                                        {activeHistoryPreviewCompareActionLabel && activeHistoryPreviewCompareReferenceVersion && draftVersion ? (
                                          <button
                                            type="button"
                                            className="version-timeline-item__entry-action"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              openVersionCompare(
                                                activeHistoryPreviewCompareReferenceVersion.id,
                                                draftVersion.id,
                                                activeHistoryPreviewEntryContext?.regionQuery || '',
                                                {
                                                  kind: 'observer-saved-region',
                                                  regionLabel: activeHistoryPreviewEntryContext?.regionLabel || '',
                                                  regionQuery: activeHistoryPreviewEntryContext?.regionQuery || '',
                                                },
                                              );
                                            }}
                                            title={activeHistoryPreviewCompareActionTitle || activeHistoryPreviewCompareActionLabel}
                                          >
                                            {activeHistoryPreviewCompareActionLabel}
                                          </button>
                                        ) : null}
                                      </div>
                                    ) : null}
                                    {touched.length ? (
                                      <div className="version-timeline-item__regions">
                                        {touched.map((item) => (
                                          <span key={item}>{item}</span>
                                        ))}
                                      </div>
                                    ) : null}
                                    {gaps.length ? (
                                      <div className="version-timeline-item__gaps">
                                        {gaps.map((item) => (
                                          <span key={item}>{item}</span>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                  {navigationActionLabel || canCompareTimelineVersion || canCompareTimelineSplit ? (
                                    <div className="version-timeline-item__actions">
                                      {navigationActionLabel ? (
                                        <button
                                          type="button"
                                          className="version-timeline-item__path-action"
                                          onClick={() => {
                                            const referenceId = navigationContext?.compareReferenceVersion?.id || version.id;
                                            compareHistoryPathVersion(referenceId);
                                          }}
                                        >
                                          {navigationActionLabel}
                                        </button>
                                      ) : null}
                                      {canCompareTimelineVersion ? (
                                        <button
                                          type="button"
                                          className="version-timeline-item__path-action version-timeline-item__path-action--compare"
                                          title={versionCompareActionTitle(version, timelineCompareContext?.compareTarget, timelineCompareContext?.pathLabel)}
                                          onClick={() => {
                                            if (timelineCompareContext) {
                                              openVersionCompare(version.id, timelineCompareContext.compareTarget.id);
                                            }
                                          }}
                                        >
                                          {compareActionLabel}
                                        </button>
                                      ) : null}
                                      {canCompareTimelineSplit ? (
                                        <button
                                          type="button"
                                          className="version-timeline-item__path-action version-timeline-item__path-action--split"
                                          title={versionCompareSplitTitle(compareSharedAncestor || undefined, timelineCompareContext?.compareTarget || undefined)}
                                          onClick={() => {
                                            if (compareSharedAncestor && timelineCompareContext) {
                                              openVersionCompare(compareSharedAncestor.id, timelineCompareContext.compareTarget.id);
                                            }
                                          }}
                                        >
                                          {versionCompareShortcutLabel('split', compareSharedAncestor || undefined, timelineCompareContext?.compareTarget || undefined, workspace.versions)}
                                        </button>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </article>
                              );
                            })}
                          </div>
                        ) : null}
                      </section>
                    );
                  }) : (
                    <div className="version-timeline-empty">
                      <strong>{historyFilterLabel(historyFilterMode)}</strong>
                      <span>{historyFilterEmptyLabel(historyFilterMode)}</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="drawer-preview" aria-label="版本预览">
                {activeHistoryPreviewEntryContext && activeHistoryPreviewEntryPresentation ? (
                  <div className="drawer-preview__entry" title={activeHistoryPreviewEntryPresentation.revisionTitle}>
                    <span className="drawer-preview__entry-label">{activeHistoryPreviewEntryPresentation.label}</span>
                    <span className="drawer-preview__entry-copy">{activeHistoryPreviewEntryPresentation.detail}</span>
                    <button
                      type="button"
                      className="drawer-preview__entry-chip"
                      onClick={() => openVersionInHistory(
                        activeHistoryPreviewEntryContext.versionId,
                        activeHistoryPreviewEntryContext.regionQuery,
                        activeHistoryPreviewEntryContext,
                      )}
                      title={activeHistoryPreviewEntryPresentation.focusTitle}
                    >
                      {activeHistoryPreviewEntryContext.regionLabel}
                    </button>
                    {activeHistoryPreviewCompareActionLabel && activeHistoryPreviewCompareReferenceVersion && draftVersion ? (
                      <button
                        type="button"
                        className="drawer-preview__entry-action"
                        onClick={() => openVersionCompare(
                          activeHistoryPreviewCompareReferenceVersion.id,
                          draftVersion.id,
                          activeHistoryPreviewEntryContext.regionQuery,
                          {
                            kind: 'observer-saved-region',
                            regionLabel: activeHistoryPreviewEntryContext.regionLabel,
                            regionQuery: activeHistoryPreviewEntryContext.regionQuery,
                          },
                        )}
                        title={activeHistoryPreviewCompareActionTitle || activeHistoryPreviewCompareActionLabel}
                      >
                        {activeHistoryPreviewCompareActionLabel}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {draftVersion && !draftVersionIsCurrent ? (
                  <div className="drawer-preview__hint">
                    <div className="drawer-preview__hint-copy">
                      <span>历史版本为只读预览。</span>
                      <strong>{restoreOutcomeHint(draftVersion, workspace)}</strong>
                    </div>
                    <button
                      type="button"
                      className="workspace-chat-sidebar__secondary-button"
                      onClick={() => void restoreVersionAsCurrent(draftVersion.id, restoreCheckpointSummary(draftVersion, workspace))}
                      disabled={isBusy}
                    >
                      <RotateCcw size={14} />
                      <span>恢复此版本</span>
                    </button>
                  </div>
                ) : null}
                <PaperPreview
                  blocks={draftVersion?.blocks || []}
                  onAnnotate={draftVersionIsCurrent ? (target) => setAnnotationTarget(target) : undefined}
                  compact
                  focusQuery={draftFocusQuery}
                />
              </section>
            </div>
          </aside>
        </div>
      ) : null}

      {screenMode === 'workspace' && annotationTarget ? (
        <QuickIssueBar
          selectedText={annotationTarget.selectedText}
          anchor={annotationTarget.anchor}
          onCancel={() => {
            setAnnotationTarget(null);
            setPdfSelectionClearSignal((signal) => signal + 1);
            window.getSelection()?.removeAllRanges();
          }}
          onSubmit={(payload) => handleRevision(payload)}
        />
      ) : null}
    </div>
  );
}

export default App;
