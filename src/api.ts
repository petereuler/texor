import {
  BridgeCommand,
  BridgeCommandPayload,
  BridgeCommandType,
  CodexFeedback,
  CodexFeedbackPayload,
  CompileResult,
  DiffCompileResult,
  HealthResponse,
  ModelConfig,
  PdfSelectionLocateRequest,
  PdfSelectionLocateResult,
  ProjectAnalysis,
  RevisionPayload,
  RevisionResult,
  TemplateSuggestion,
  TemplateEnsureResult,
  WorkspaceSnapshot,
  WorkspaceSummary,
} from './types';

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health');
}

export function scanProject(rootPath: string): Promise<ProjectAnalysis> {
  return request<ProjectAnalysis>('/api/projects/scan', {
    method: 'POST',
    body: JSON.stringify({ rootPath }),
  });
}

export function generatePaper(analysis: ProjectAnalysis, targetJournal: string, modelConfig?: ModelConfig): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>('/api/papers/generate', {
    method: 'POST',
    body: JSON.stringify({ analysis, targetJournal, modelConfig }),
  });
}

export function importTexPaper(payload: { texPath: string; projectRoot: string; targetJournal: string; title?: string }): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>('/api/papers/import-tex', {
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

export function deleteWorkspace(paperId: string): Promise<{ deletedPaperIds: string[]; projectRoot?: string; workspaces: WorkspaceSummary[] }> {
  return request<{ deletedPaperIds: string[]; projectRoot?: string; workspaces: WorkspaceSummary[] }>(`/api/workspaces/${paperId}`, {
    method: 'DELETE',
  });
}

export function getWorkspace(paperId: string): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>(`/api/papers/${paperId}`);
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

export function updateBridgeCommand(commandId: string, payload: Partial<Pick<BridgeCommand, 'control'>> & { control?: BridgeCommand['control'] | null }): Promise<BridgeCommand> {
  return request<BridgeCommand>(`/api/bridge/commands/${commandId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function listBridgeCommands(status?: string, options: { paperId?: string; projectPath?: string } = {}): Promise<BridgeCommand[]> {
  const params = new URLSearchParams({ limit: '12' });
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
