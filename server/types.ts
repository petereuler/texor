export interface ImportantFile {
  path: string;
  reason: string;
  snippet: string;
}

export interface ResultArtifact {
  path: string;
  kind: 'figure' | 'table' | 'metrics' | 'document' | 'other';
  summary: string;
  preview?: string[][];
  score?: number;
}

export interface GitCommit {
  hash: string;
  date: string;
  subject: string;
}

export interface GitContext {
  isRepo: boolean;
  branch?: string;
  head?: string;
  commits: GitCommit[];
}

export interface ProjectCommandHint {
  command: string;
  source: string;
  reason: string;
}

export interface ProjectDossier {
  agentBrief: string;
  entryPoints: string[];
  experimentFiles: string[];
  figureScripts: string[];
  datasetHints: string[];
  metricHints: string[];
  commandHints: ProjectCommandHint[];
  openQuestions: string[];
}

export interface ProjectAnalysis {
  rootPath: string;
  projectName: string;
  overview: string;
  purpose: string;
  methods: string[];
  results: string[];
  recommendedSections: string[];
  languageBreakdown: Array<{ label: string; value: number }>;
  importantFiles: ImportantFile[];
  resultArtifacts: ResultArtifact[];
  ingestNotes: string[];
  rawEvidence: string[];
  dossier: ProjectDossier;
  gitContext: GitContext;
}

export interface ManuscriptRegion {
  kind: 'abstract' | 'section' | 'subsection' | 'subsubsection' | 'figure' | 'table' | 'bibliography';
  title: string;
  label?: string;
  lineStart: number;
  lineEnd: number;
  wordCount: number;
  snippet: string;
}

export interface ManuscriptAsset {
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

export interface ManuscriptLabel {
  key: string;
  kind: 'figure' | 'table' | 'section' | 'equation' | 'algorithm' | 'other';
  line: number;
}

export interface ManuscriptCitation {
  key: string;
  count: number;
  firstLine: number;
}

export interface ManuscriptTodo {
  kind: 'todo' | 'tbd' | 'citation-gap' | 'evidence-gap' | 'missing-asset';
  line: number;
  text: string;
  regionTitle?: string;
}

export interface ManuscriptState {
  schemaVersion: number;
  extractedAt: string;
  sectionMap: ManuscriptRegion[];
  figures: ManuscriptAsset[];
  tables: ManuscriptAsset[];
  labels: ManuscriptLabel[];
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

export interface VersionChangeSummary {
  summary: string;
  touchedRegions: string[];
  addedTodos: string[];
  removedTodos: string[];
}

export interface VersionFocusTarget {
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
  selectedText?: string;
  pageHint?: number;
  regionTitle?: string;
}

interface BaseBlock {
  id: string;
  section: string;
  title: string;
}

export interface TextBlock extends BaseBlock {
  type: 'text';
  content: string;
}

export interface FigureBlock extends BaseBlock {
  type: 'figure';
  caption: string;
  insight: string;
  imageUrl: string;
}

export interface TableBlock extends BaseBlock {
  type: 'table';
  caption: string;
  headers: string[];
  rows: string[][];
  note?: string;
}

export type PaperBlock = TextBlock | FigureBlock | TableBlock;

export interface ModelConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: string;
  provider?: string;
  imageModel?: string;
}

export type ProjectExecutionTarget =
  | {
      kind: 'local';
      rootPath: string;
    }
  | {
      kind: 'ssh';
      hostAlias: string;
      remoteRoot: string;
      mirrorRoot?: string;
    };

export interface SSHHostProfile {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export interface VSCodeImportedKeybinding {
  command: string;
  key: string;
  when?: string;
}

export interface VSCodeImportBundle {
  source: string;
  importedAt: string;
  settings: Record<string, unknown>;
  keybindings: VSCodeImportedKeybinding[];
  colorTheme?: string;
  iconTheme?: string;
}

export interface DesktopBootstrap {
  isDesktop: boolean;
  platform: string;
  serverUrl?: string;
  windowSessionKey?: string;
  importedConfig?: VSCodeImportBundle | null;
  diagnostics?: {
    logDir?: string;
    logPath?: string;
    bundlePath?: string;
    bundleAvailable?: boolean;
    logChannels?: Array<{
      channel: 'desktop-main' | 'desktop-preload' | 'desktop-renderer' | 'desktop-server';
      path: string;
      exists: boolean;
      sizeBytes?: number;
      updatedAt?: string;
    }>;
    startupStatus?: 'ready' | 'degraded';
    notes?: string[];
  };
}

export interface DesktopPreparedTarget {
  target: ProjectExecutionTarget;
  effectiveRootPath: string;
  displayLabel: string;
  syncedAt?: string;
}

export interface WorkspaceFileNode {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  depth: number;
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
}

export interface WorkspaceCommandResult {
  ok: boolean;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type AgentBackend = 'texor-agent' | 'codex-cli' | 'codex-native' | 'claude-code';

export type TaskSpeedMode = 'quick' | 'deep';

export interface WorkspaceRuntimeConfig {
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

export interface PaperRecord {
  id: string;
  title: string;
  targetJournal: string;
  authors: string[];
  projectRoot?: string;
  executionTarget?: ProjectExecutionTarget;
  assetRoots?: string[];
  analysis?: ProjectAnalysis;
  codexSessionId?: string;
  codexSessionBackend?: AgentBackend;
  codexSessionUpdatedAt?: string;
  runtimeConfig?: WorkspaceRuntimeConfig;
  createdAt: string;
}

export interface PaperVersion {
  id: string;
  paperId: string;
  label: string;
  summary: string;
  createdAt: string;
  sourceCommit?: string;
  basedOnVersionId?: string;
  sourcePath?: string;
  blocks: PaperBlock[];
  latex: string;
  focusTarget?: VersionFocusTarget;
  manuscriptState?: ManuscriptState;
  changeSummary?: VersionChangeSummary;
}

export interface WorkspaceSnapshot {
  paper: PaperRecord;
  currentVersion: PaperVersion;
  versions: PaperVersion[];
}

export interface WorkspaceSummary {
  paperId: string;
  title: string;
  targetJournal: string;
  projectRoot?: string;
  executionTarget?: ProjectExecutionTarget;
  sourcePath?: string;
  codexSessionId?: string;
  codexSessionBackend?: AgentBackend;
  codexSessionUpdatedAt?: string;
  currentVersionId: string;
  currentVersionLabel: string;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RevisionRequest {
  paperId: string;
  versionId: string;
  targetBlockId: string;
  selectedText?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
  sourceSnippet?: string;
  issue: string;
  changeRequest: string;
  modelConfig?: ModelConfig;
}

export interface RevisionResult {
  snapshot: WorkspaceSnapshot;
  diffSummary: string;
  mode: 'mock' | 'openai-compatible';
  route?: 'quick-local' | 'structured-patch' | 'codex';
}

export interface CompileResult {
  ok: boolean;
  pdfUrl?: string;
  log: string;
  engine: string;
  outputDir: string;
  pdfPath?: string;
  texPath?: string;
}

export interface DiffCompileResult {
  ok: boolean;
  previous?: CompileResult;
  current: CompileResult;
  previousVersionId?: string;
  currentVersionId: string;
}

export interface PdfSelectionLocateRequest {
  pdfUrl: string;
  sourcePath?: string;
  projectRoot?: string;
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface PdfSelectionLocateResult {
  ok: boolean;
  sourceFile?: string;
  line?: number;
  column?: number;
  snippet?: string;
  message?: string;
}

export interface SourceLineLocateRequest {
  pdfUrl: string;
  sourcePath?: string;
  projectRoot?: string;
  line: number;
  column?: number;
  pageHint?: number;
}

export interface SourceLineLocateResult {
  ok: boolean;
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  message?: string;
}

export interface TemplateCatalogEntry {
  id: string;
  name: string;
  publisher: string;
  type: 'journal' | 'conference' | 'journal-conference';
  templateFamily: string;
  sourceProvider:
    | 'ieee'
    | 'acm'
    | 'elsevier'
    | 'iclr'
    | 'neurips'
    | 'cvf'
    | 'icml'
    | 'aaai'
    | 'springer'
    | 'generic';
  sourceKind: 'official-page' | 'direct-archive' | 'hybrid';
  localPath: string;
  archivePath: string;
  sourceUrl: string;
  officialPage: string;
  fallbackUrls?: string[];
  aliases: string[];
}

export interface TemplateEnsureResult {
  ok: boolean;
  id: string;
  status: 'cached' | 'downloaded' | 'manual-required' | 'failed';
  message: string;
  localPath?: string;
  officialPage?: string;
  sourceUrl?: string;
}

export interface TemplateSuggestion {
  id: string;
  label: string;
  publisher: string;
  type: TemplateCatalogEntry['type'];
  templateFamily: string;
  localPath: string;
  cached?: boolean;
  sourceUrl: string;
  officialPage: string;
  matchedName: string;
}

export interface CodexPaperCreateRequest {
  title: string;
  targetJournal: string;
  latex: string;
  summary?: string;
  authors?: string[];
  projectRoot: string;
  executionTarget?: ProjectExecutionTarget;
  sourcePath?: string;
  assetRoots?: string[];
  runtimeConfig?: WorkspaceRuntimeConfig;
}

export interface CodexPaperVersionRequest {
  latex: string;
  summary?: string;
  sourcePath?: string;
  basedOnVersionId?: string;
  title?: string;
  targetJournal?: string;
  focusTarget?: VersionFocusTarget;
}

export type CodexFeedbackStatus = 'open' | 'accepted' | 'done' | 'dismissed';

export interface CodexFeedback {
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
  taskSpeedMode?: TaskSpeedMode;
  status: CodexFeedbackStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CodexFeedbackCreateRequest {
  paperId: string;
  versionId: string;
  targetBlockId?: string;
  selectedText?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
  sourceSnippet?: string;
  issue: string;
  changeRequest: string;
  source?: CodexFeedback['source'];
  taskSpeedMode?: TaskSpeedMode;
}

export interface CodexFeedbackStatusRequest {
  status: CodexFeedbackStatus;
}

export interface StoreState {
  papers: Record<string, PaperRecord>;
  versions: Record<string, PaperVersion[]>;
  currentVersionIds?: Record<string, string>;
}

export interface FeedbackStoreState {
  feedback: Record<string, CodexFeedback>;
}

export type BridgeCommandType = 'codex-task' | 'capture-active-latex';

export type BridgeCommandStatus = 'queued' | 'running' | 'done' | 'failed';

export type BridgeCommandLogStream = 'system' | 'stdout' | 'stderr';

export type BridgeCommandControl = 'pause' | 'terminate';

export type BridgeCommandPhase =
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

export interface BridgeCommandLogEntry {
  id: string;
  time: string;
  stream: BridgeCommandLogStream;
  message: string;
}

export type DraftingMode = 'understand-project' | 'initial-draft' | 'continue';

export type CodexTaskIntent = 'auto' | 'chat' | 'edit';

export interface CodexTaskCommandPayload {
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

export interface CaptureActiveLatexCommandPayload {
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
}

export interface DesktopOpenProjectRequest {
  target: ProjectExecutionTarget;
}

export type BridgeCommandPayload = CodexTaskCommandPayload | CaptureActiveLatexCommandPayload;

export interface BridgeCommand {
  id: string;
  type: BridgeCommandType;
  payload: BridgeCommandPayload;
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

export interface BridgeCommandCreateRequest {
  type: BridgeCommandType;
  payload: BridgeCommandPayload;
}

export interface BridgeCommandUpdateRequest {
  status?: BridgeCommandStatus;
  phase?: BridgeCommandPhase;
  message?: string;
  sessionId?: string;
  control?: BridgeCommandControl | null;
  result?: Record<string, unknown>;
  error?: string;
  logs?: BridgeCommandLogEntry[];
}

export interface BridgeCommandStoreState {
  commands: Record<string, BridgeCommand>;
}
