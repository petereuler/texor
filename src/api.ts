import {
  BridgeCommand,
  BridgeCommandPayload,
  BridgeCommandType,
  CodexFeedback,
  CodexFeedbackPayload,
  CompileResult,
  DesktopBootstrap,
  DesktopOpenProjectRequest,
  DesktopPreparedTarget,
  DiffCompileResult,
  HealthResponse,
  ModelConfig,
  PdfSelectionLocateRequest,
  PdfSelectionLocateResult,
  ProjectExecutionTarget,
  ProjectAnalysis,
  RevisionPayload,
  RevisionResult,
  SSHHostProfile,
  SourceLineLocateRequest,
  SourceLineLocateResult,
  TemplateSuggestion,
  TemplateEnsureResult,
  WorkspaceCommandResult,
  WorkspaceFileContent,
  WorkspaceFileNode,
  WorkspaceRuntimeConfig,
  WorkspaceSnapshot,
  WorkspaceSummary,
} from './types';

const desktopServerUrl = typeof window !== 'undefined' && typeof window.__TEXOR_SERVER_URL__ === 'string'
  ? window.__TEXOR_SERVER_URL__
  : undefined;

function resolveApiUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  if (!desktopServerUrl) {
    return input;
  }
  if (input.startsWith('/')) {
    return `${desktopServerUrl}${input}`;
  }
  return `${desktopServerUrl}/${input}`;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(input), {
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    ...init,
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

function contentDispositionFilename(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const utfMatch = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) {
    return decodeURIComponent(utfMatch[1]);
  }
  const plainMatch = header.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  return plainMatch ? (plainMatch[1] || plainMatch[2])?.trim() : undefined;
}

async function requestBinary(input: string, init?: RequestInit): Promise<{ blob: Blob; filename?: string }> {
  const response = await fetch(resolveApiUrl(input), {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    ...init,
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }

  return {
    blob: await response.blob(),
    filename: contentDispositionFilename(response.headers.get('Content-Disposition')),
  };
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health');
}

export function getDesktopBootstrap(): Promise<DesktopBootstrap> {
  return request<DesktopBootstrap>('/api/desktop/bootstrap');
}

export function importVSCodeConfig(): Promise<DesktopBootstrap> {
  return request<DesktopBootstrap>('/api/desktop/import-vscode-config', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function listSSHHosts(): Promise<SSHHostProfile[]> {
  return request<SSHHostProfile[]>('/api/desktop/ssh-hosts');
}

export function prepareDesktopProject(payload: DesktopOpenProjectRequest): Promise<DesktopPreparedTarget> {
  return request<DesktopPreparedTarget>('/api/desktop/open-project', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function scanProject(rootPath: string): Promise<ProjectAnalysis> {
  return request<ProjectAnalysis>('/api/projects/scan', {
    method: 'POST',
    body: JSON.stringify({ rootPath }),
  });
}

export function generatePaper(
  analysis: ProjectAnalysis,
  targetJournal: string,
  modelConfig?: ModelConfig,
  runtimeConfig?: WorkspaceRuntimeConfig,
): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>('/api/papers/generate', {
    method: 'POST',
    body: JSON.stringify({ analysis, targetJournal, modelConfig, runtimeConfig }),
  });
}

export function importTexPaper(payload: {
  texPath: string;
  projectRoot: string;
  targetJournal: string;
  title?: string;
  runtimeConfig?: WorkspaceRuntimeConfig;
}): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>('/api/papers/import-tex', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createCodexPaper(payload: {
  title: string;
  targetJournal: string;
  latex: string;
  summary?: string;
  projectRoot: string;
  sourcePath?: string;
  runtimeConfig?: WorkspaceRuntimeConfig;
}): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>('/api/codex/papers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getLatestWorkspace(): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>('/api/workspace/latest');
}

export function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return request<WorkspaceSummary[]>('/api/workspaces');
}

export function openWorkspaceFromProjectRoot(projectRoot: string): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>('/api/workspaces/open', {
    method: 'POST',
    body: JSON.stringify({ projectRoot }),
  });
}

export function listWorkspaceFiles(target: ProjectExecutionTarget, relativePath = '.'): Promise<WorkspaceFileNode[]> {
  const params = new URLSearchParams({
    kind: target.kind,
    relativePath,
  });
  if (target.kind === 'local') {
    params.set('rootPath', target.rootPath);
  } else {
    params.set('hostAlias', target.hostAlias);
    params.set('remoteRoot', target.remoteRoot);
  }
  return request<WorkspaceFileNode[]>(`/api/workspace-files?${params.toString()}`);
}

export function readWorkspaceFile(target: ProjectExecutionTarget, relativePath: string): Promise<WorkspaceFileContent> {
  const params = new URLSearchParams({
    kind: target.kind,
    relativePath,
  });
  if (target.kind === 'local') {
    params.set('rootPath', target.rootPath);
  } else {
    params.set('hostAlias', target.hostAlias);
    params.set('remoteRoot', target.remoteRoot);
  }
  return request<WorkspaceFileContent>(`/api/workspace-file?${params.toString()}`);
}

export function writeWorkspaceFile(
  target: ProjectExecutionTarget,
  relativePath: string,
  content: string,
): Promise<WorkspaceFileContent> {
  return request<WorkspaceFileContent>('/api/workspace-file', {
    method: 'PUT',
    body: JSON.stringify({
      target,
      relativePath,
      content,
    }),
  });
}

export function runWorkspaceCommand(target: ProjectExecutionTarget, command: string, cwd?: string): Promise<WorkspaceCommandResult> {
  return request<WorkspaceCommandResult>('/api/workspace-command', {
    method: 'POST',
    body: JSON.stringify({ target, command, cwd }),
  });
}

export function deleteWorkspace(paperId: string): Promise<{ deletedPaperIds: string[]; projectRoot?: string; workspaces: WorkspaceSummary[] }> {
  return request<{ deletedPaperIds: string[]; projectRoot?: string; workspaces: WorkspaceSummary[] }>(`/api/workspaces/${paperId}`, {
    method: 'DELETE',
  });
}

export function getWorkspace(paperId: string): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>(`/api/papers/${paperId}`);
}

export function updateWorkspaceRuntimeConfig(paperId: string, runtimeConfig: WorkspaceRuntimeConfig): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>(`/api/papers/${paperId}/runtime-config`, {
    method: 'PATCH',
    body: JSON.stringify({ runtimeConfig }),
  });
}

export function restoreWorkspaceVersion(paperId: string, versionId: string, summary?: string): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>(`/api/papers/${paperId}/restore-version`, {
    method: 'POST',
    body: JSON.stringify({ versionId, summary }),
  });
}

export function applyRevision(paperId: string, payload: RevisionPayload): Promise<RevisionResult> {
  return request<RevisionResult>(`/api/papers/${paperId}/revise`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function submitCodexFeedback(payload: CodexFeedbackPayload): Promise<CodexFeedback> {
  return request<CodexFeedback>('/api/codex/feedback', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function compilePaper(paperId: string, versionId: string): Promise<CompileResult> {
  return request<CompileResult>(`/api/papers/${paperId}/compile`, {
    method: 'POST',
    body: JSON.stringify({ versionId }),
  });
}

export function compileDiff(paperId: string, currentVersionId: string, previousVersionId?: string): Promise<DiffCompileResult> {
  return request<DiffCompileResult>(`/api/papers/${paperId}/compile-diff`, {
    method: 'POST',
    body: JSON.stringify({ previousVersionId, currentVersionId }),
  });
}

export function searchTemplates(query: string): Promise<TemplateSuggestion[]> {
  const params = new URLSearchParams({ q: query, limit: '8' });
  return request<TemplateSuggestion[]>(`/api/templates/search?${params.toString()}`);
}

export function ensureTemplate(templateId: string): Promise<TemplateEnsureResult> {
  return request<TemplateEnsureResult>(`/api/templates/${encodeURIComponent(templateId)}/ensure`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function createBridgeCommand(type: BridgeCommandType, payload: BridgeCommandPayload): Promise<BridgeCommand> {
  return request<BridgeCommand>('/api/bridge/commands', {
    method: 'POST',
    body: JSON.stringify({ type, payload }),
  });
}

export function updateBridgeCommand(
  commandId: string,
  payload: {
    status?: BridgeCommand['status'];
    phase?: BridgeCommand['phase'];
    message?: BridgeCommand['message'];
    sessionId?: BridgeCommand['sessionId'];
    control?: BridgeCommand['control'] | null;
    result?: BridgeCommand['result'];
    error?: BridgeCommand['error'];
    logs?: BridgeCommand['logs'];
  },
): Promise<BridgeCommand> {
  return request<BridgeCommand>(`/api/bridge/commands/${commandId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function listBridgeCommands(status?: string, options: { paperId?: string; projectPath?: string; limit?: number } = {}): Promise<BridgeCommand[]> {
  const params = new URLSearchParams({ limit: String(options.limit || 20) });
  if (status) {
    params.set('status', status);
  }
  if (options.paperId) {
    params.set('paperId', options.paperId);
  }
  if (options.projectPath) {
    params.set('projectPath', options.projectPath);
  }
  return request<BridgeCommand[]>(`/api/bridge/commands?${params.toString()}`);
}

export function locatePdfSelection(payload: PdfSelectionLocateRequest): Promise<PdfSelectionLocateResult> {
  return request<PdfSelectionLocateResult>('/api/pdf/locate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function locateSourceLine(payload: SourceLineLocateRequest): Promise<SourceLineLocateResult> {
  return request<SourceLineLocateResult>('/api/pdf/forward-locate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function downloadBinary(input: string): Promise<{ blob: Blob; filename?: string }> {
  return requestBinary(input);
}

export function exportWorkspaceArchive(paperId: string): Promise<{ blob: Blob; filename?: string }> {
  return requestBinary(`/api/workspaces/${paperId}/export`);
}

export function exportDesktopDiagnosticsBundle(): Promise<{ blob: Blob; filename?: string }> {
  return requestBinary('/api/desktop/diagnostics/bundle');
}
