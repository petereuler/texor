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
  gitContext: GitContext;
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
  provider?: string;
  imageModel?: string;
}

export interface PaperRecord {
  id: string;
  title: string;
  targetJournal: string;
  authors: string[];
  projectRoot?: string;
  assetRoots?: string[];
  analysis?: ProjectAnalysis;
  codexSessionId?: string;
  codexSessionUpdatedAt?: string;
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
  sourcePath?: string;
  codexSessionId?: string;
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
  sourceSnippet?: string;
  issue: string;
  changeRequest: string;
  modelConfig?: ModelConfig;
}

export interface RevisionResult {
  snapshot: WorkspaceSnapshot;
  diffSummary: string;
  mode: 'mock' | 'openai-compatible';
  route?: 'quick-local' | 'codex';
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

export interface TemplateCatalogEntry {
  id: string;
  name: string;
  publisher: string;
  type: 'journal' | 'conference' | 'journal-conference';
  templateFamily: string;
  localPath: string;
  archivePath: string;
  sourceUrl: string;
  officialPage: string;
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
  sourcePath?: string;
  assetRoots?: string[];
}

export interface CodexPaperVersionRequest {
  latex: string;
  summary?: string;
  sourcePath?: string;
  basedOnVersionId?: string;
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
  sourceSnippet?: string;
  issue: string;
  changeRequest: string;
  source?: CodexFeedback['source'];
}

export interface CodexFeedbackStatusRequest {
  status: CodexFeedbackStatus;
}

export interface StoreState {
  papers: Record<string, PaperRecord>;
  versions: Record<string, PaperVersion[]>;
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

export interface CodexTaskCommandPayload {
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

export interface CaptureActiveLatexCommandPayload {
  paperId?: string;
  title?: string;
  targetJournal?: string;
  summary?: string;
  basedOnVersionId?: string;
  projectRoot?: string;
  sourcePath?: string;
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
