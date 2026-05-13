import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FilePlus2,
  FolderOpen,
  History,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { diffWordsWithSpace } from 'diff';
import { useEffect, useMemo, useState } from 'react';
import {
  compileDiff,
  createBridgeCommand,
  deleteWorkspace,
  getHealth,
  getWorkspace,
  importTexPaper,
  ensureTemplate,
  listBridgeCommands,
  listWorkspaces,
  locatePdfSelection,
  searchTemplates,
  submitCodexFeedback,
  updateBridgeCommand,
} from './api';
import { AnnotationTarget, PaperPreview } from './components/PaperPreview';
import { QuickIssueBar } from './components/QuickIssueBar';
import { PdfRegionSelection, SelectablePdf } from './components/SelectablePdf';
import { BridgeCommand, DiffCompileResult, HealthResponse, TemplateEnsureResult, TemplateSuggestion, WorkspaceSnapshot, WorkspaceSummary } from './types';

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

function commandMessage(command?: BridgeCommand | null): string {
  if (!command) {
    return '等待 TEXOR';
  }
  if (command.message) {
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

function compactLogMessage(message: string): string {
  return message
    .replace(/^codex\s*/i, '')
    .replace(/^exec\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldShowCodexLog(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return !(
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
    /^[-\w./]+:\s*\/?[-\w./]+/.test(normalized) ||
    normalized.length > 2200 ||
    normalized.includes('/.texor/codex-feedback/') ||
    normalized.includes('.texor/codex-feedback')
  );
}

function storedModelConfig(): { provider?: string; baseUrl?: string; model?: string; apiKey?: string; imageModel?: string } {
  return {
    provider: window.localStorage.getItem('texor.agentProvider') || 'OpenAI-compatible',
    baseUrl: window.localStorage.getItem('texor.agentBaseUrl') || 'https://api.openai.com/v1',
    model: window.localStorage.getItem('texor.agentModel') || 'gpt-4.1-mini',
    imageModel: window.localStorage.getItem('texor.agentImageModel') || 'gpt-image-1',
    apiKey: window.localStorage.getItem('texor.agentApiKey') || '',
  };
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

function reusableSessionCommand(commands: BridgeCommand[]): BridgeCommand | null {
  const candidates = commands
    .filter((command) => command.type === 'codex-task' && (command.sessionId || typeof command.result?.sessionId === 'string'))
    .filter((command) => command.status === 'done' || command.status === 'running' || command.status === 'failed')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  return candidates[candidates.length - 1] || null;
}

function sessionIdFromCommand(command: BridgeCommand | null): string | undefined {
  return command?.sessionId || (command?.result?.sessionId as string | undefined);
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

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [projectPath, setProjectPath] = useState('');
  const [texPath, setTexPath] = useState('');
  const [targetJournal, setTargetJournal] = useState('');
  const [projectBrief, setProjectBrief] = useState('');
  const [projectMode, setProjectMode] = useState<'load' | 'new'>('load');
  const [agentBackend, setAgentBackend] = useState<'texor-agent' | 'codex-cli'>(() => (window.localStorage.getItem('texor.agentBackend') as 'texor-agent' | 'codex-cli') || 'texor-agent');
  const [agentProvider, setAgentProvider] = useState(() => storedModelConfig().provider || 'OpenAI-compatible');
  const [agentBaseUrl, setAgentBaseUrl] = useState(() => storedModelConfig().baseUrl || 'https://api.openai.com/v1');
  const [agentModel, setAgentModel] = useState(() => storedModelConfig().model || 'gpt-4.1-mini');
  const [agentImageModel, setAgentImageModel] = useState(() => storedModelConfig().imageModel || 'gpt-image-1');
  const [agentApiKey, setAgentApiKey] = useState(() => storedModelConfig().apiKey || '');
  const [workspaceList, setWorkspaceList] = useState<WorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [diffPdf, setDiffPdf] = useState<DiffCompileResult | null>(null);
  const [leftVersionId, setLeftVersionId] = useState('');
  const [rightVersionId, setRightVersionId] = useState('');
  const [manualVersionSelection, setManualVersionSelection] = useState(false);
  const [annotationTarget, setAnnotationTarget] = useState<AnnotationTarget | null>(null);
  const [pdfSelectionClearSignal, setPdfSelectionClearSignal] = useState(0);
  const [templateSuggestions, setTemplateSuggestions] = useState<TemplateSuggestion[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateSuggestion | null>(null);
  const [templateStatus, setTemplateStatus] = useState<TemplateEnsureResult | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [bridgeCommands, setBridgeCommands] = useState<BridgeCommand[]>([]);
  const [observerOpen, setObserverOpen] = useState(() => window.localStorage.getItem('texor.codexObserverOpen') !== 'false');
  const [busyState, setBusyState] = useState<string | null>(null);
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getHealth()
      .then((payload) => setHealth(payload))
      .catch((reason: Error) => setError(reason.message));

    void refreshWorkspaceList(true);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshWorkspaceList(false);
      if (!workspace) {
        return;
      }
      void getWorkspace(workspace.paper.id)
        .then((snapshot) => {
          const hasNewVersion = snapshot.currentVersion.id !== workspace.currentVersion.id || snapshot.versions.length !== workspace.versions.length;
          if (
            snapshot.currentVersion.id === workspace.currentVersion.id &&
            snapshot.versions.length === workspace.versions.length &&
            snapshot.paper.codexSessionId === workspace.paper.codexSessionId
          ) {
            return;
          }
          applyWorkspace(snapshot, { keepManualComparison: !hasNewVersion });
        })
        .catch(() => undefined);
    }, 3000);

    return () => window.clearInterval(interval);
  }, [workspace]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void listBridgeCommands(undefined, {
        paperId: workspace?.paper.id,
        projectPath: projectPath.trim() || workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath,
      })
        .then((commands) => {
          setBridgeCommands(commands);
          const active = [...commands].reverse().find((command) => command.status === 'queued' || command.status === 'running');
          if (active) {
            setStatus(active.status === 'queued' ? '等待 VSCode' : 'Agent 处理中');
            return;
          }
        })
        .catch(() => undefined);
    }, 2500);

    return () => window.clearInterval(interval);
  }, [projectPath, workspace]);

  useEffect(() => {
    window.localStorage.setItem('texor.codexObserverOpen', String(observerOpen));
  }, [observerOpen]);

  useEffect(() => {
    window.localStorage.setItem('texor.agentBackend', agentBackend);
    window.localStorage.setItem('texor.agentProvider', agentProvider);
    window.localStorage.setItem('texor.agentBaseUrl', agentBaseUrl);
    window.localStorage.setItem('texor.agentModel', agentModel);
    window.localStorage.setItem('texor.agentImageModel', agentImageModel);
    window.localStorage.setItem('texor.agentApiKey', agentApiKey);
  }, [agentBackend, agentProvider, agentBaseUrl, agentModel, agentImageModel, agentApiKey]);

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
    const currentIndex = snapshot.versions.findIndex((version) => version.id === right);
    const left = currentIndex > 0 ? snapshot.versions[currentIndex - 1].id : '';
    return { left, right };
  }

  function alignVersionSelection(snapshot: WorkspaceSnapshot, force = false) {
    if (!force && manualVersionSelection && leftVersionId && rightVersionId) {
      return;
    }
    const next = defaultComparison(snapshot);
    setLeftVersionId(next.left);
    setRightVersionId(next.right);
  }

  function applyWorkspace(snapshot: WorkspaceSnapshot, options: { keepManualComparison?: boolean } = {}) {
    setWorkspace(snapshot);
    setTargetJournal(snapshot.paper.targetJournal);
    setProjectPath(snapshot.paper.projectRoot || snapshot.paper.analysis?.rootPath || '');
    setTexPath(sourcePathForVersion(snapshot, snapshot.currentVersion) || '');
    setProjectBrief('');
    setDraftOpen(false);
    setStatus(snapshot.currentVersion.label);
    if (!options.keepManualComparison) {
      setManualVersionSelection(false);
    }
    alignVersionSelection(snapshot, !options.keepManualComparison);
    void refreshDiffPdf(snapshot);
  }

  async function ensureSelectedTemplateForUse(): Promise<void> {
    if (!selectedTemplate) {
      return;
    }
    if (selectedTemplate.cached || templateStatus?.status === 'cached' || templateStatus?.status === 'downloaded') {
      return;
    }

    setStatus('首次使用，下载模板');
    setTemplateStatus({
      ok: false,
      id: selectedTemplate.id,
      status: 'failed',
      message: '首次使用，正在下载模板...',
      sourceUrl: selectedTemplate.sourceUrl,
      officialPage: selectedTemplate.officialPage,
    });
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
  }

  async function refreshWorkspaceList(openLatest: boolean) {
    try {
      const summaries = await listWorkspaces();
      setWorkspaceList(summaries);
      if (!openLatest || workspace || summaries.length === 0) {
        return;
      }
      const snapshot = await getWorkspace(summaries[0].paperId);
      applyWorkspace(snapshot);
    } catch {
      if (openLatest) {
        setWorkspace(null);
        setDiffPdf(null);
      }
    }
  }

  async function openWorkspace(paperId: string) {
    setBusyState('open-workspace');
    setError(null);
    try {
      const snapshot = await getWorkspace(paperId);
      applyWorkspace(snapshot);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '打开项目失败。');
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
      setWorkspaceList(result.workspaces);
      if (workspace?.paper.id === item.paperId || result.deletedPaperIds.includes(workspace?.paper.id || '')) {
        setWorkspace(null);
        setDiffPdf(null);
        setLeftVersionId('');
        setRightVersionId('');
        setManualVersionSelection(false);
        setProjectPath('');
        setTexPath('');
        setProjectBrief('');
        setStatus('Ready');
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
    try {
      const compiled = await compileDiff(snapshot.paper.id, currentId, previousId);
      setDiffPdf(compiled);
      if (!compiled.ok) {
        setError(diffCompileFailureMessage(compiled));
      } else if (error?.startsWith('PDF 编译失败')) {
        setError(null);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Diff 编译请求失败。';
      setDiffPdf(null);
      setError(message);
    }
  }

  function selectComparison(side: 'left' | 'right', versionId: string) {
    setManualVersionSelection(true);
    const nextLeft = side === 'left' ? versionId : leftVersionId;
    const nextRight = side === 'right' ? versionId : rightVersionId;
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
    setManualVersionSelection(false);
    setLeftVersionId(next.left);
    setRightVersionId(next.right);
    void refreshDiffPdf(workspace, next.left, next.right);
  }

  async function handleRevision(payload: { issue: string; changeRequest: string }) {
    if (!workspace || !annotationTarget) {
      return;
    }

    const activeVersionId = rightVersion?.id || workspace.currentVersion.id;
    const rootPath = workspace.paper.projectRoot || workspace.paper.analysis?.rootPath || projectPath.trim();
    if (!rootPath) {
      setError('请先载入项目路径。项目路径是 Agent 理解和控制代码的工作区，论文 .tex 路径不能代替它。');
      return;
    }
    setBusyState('feedback');
    setError(null);
    try {
      const selectedAgentConfig = {
        provider: agentProvider.trim() || 'OpenAI-compatible',
        baseUrl: agentBaseUrl.trim() || 'https://api.openai.com/v1',
        model: agentModel.trim() || 'gpt-4.1-mini',
        imageModel: agentImageModel.trim() || 'gpt-image-1',
        apiKey: agentApiKey.trim(),
      };
      const localModelEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(selectedAgentConfig.baseUrl);
      if (agentBackend === 'texor-agent' && !selectedAgentConfig.apiKey && !localModelEndpoint) {
        setError('TEXOR 需要模型 API Key。可以切换到本机 CLI 兼容模式，或填写 OpenAI-compatible API。');
        return;
      }
      await submitCodexFeedback({
        paperId: workspace.paper.id,
        versionId: activeVersionId,
        targetBlockId: annotationTarget.blockId,
        selectedText: annotationTarget.selectedText,
        sourceFile: annotationTarget.sourceFile,
        sourceLine: annotationTarget.sourceLine,
        sourceSnippet: annotationTarget.sourceSnippet,
        issue: payload.issue,
        changeRequest: payload.changeRequest,
        source: 'texor-web',
      });
      await createBridgeCommand('codex-task', {
        projectPath: rootPath,
        targetJournal: targetJournal.trim() || workspace.paper.targetJournal,
        agentBackend,
        modelConfig: agentBackend === 'texor-agent' ? selectedAgentConfig : undefined,
        instruction: `${payload.issue}\n\n${payload.changeRequest}`,
        paperId: workspace.paper.id,
        versionId: activeVersionId,
        baseVersionId: activeVersionId,
        selectedText: annotationTarget.selectedText,
        sourceFile: annotationTarget.sourceFile,
        sourceLine: annotationTarget.sourceLine,
        sourceSnippet: annotationTarget.sourceSnippet,
        source: 'annotation',
        resumeSessionId: reusableSessionId,
        continuedFromCommandId: reusableCommandSessionId === reusableSessionId ? reusableCommand?.id : undefined,
      });
      setAnnotationTarget(null);
      setPdfSelectionClearSignal((signal) => signal + 1);
      setDraftOpen(false);
      setStatus('已发送给 TEXOR');
      window.getSelection()?.removeAllRanges();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '反馈发送失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function startProjectWithCodex(mode = projectMode) {
    const rootPath = projectPath.trim();
    if (!rootPath) {
      setError(mode === 'new' ? '请输入新项目路径。' : '请输入项目路径。');
      return;
    }

    setBusyState(mode === 'new' ? 'new-project' : 'load-project');
    setError(null);
    const journal = targetJournal.trim();
    const importSourcePath = texPath.trim();
    const manuscriptPath = canonicalManuscriptPath(rootPath);
    const brief = projectBrief.trim();
    const selectedAgentConfig = {
      provider: agentProvider.trim() || 'OpenAI-compatible',
      baseUrl: agentBaseUrl.trim() || 'https://api.openai.com/v1',
      model: agentModel.trim() || 'gpt-4.1-mini',
      imageModel: agentImageModel.trim() || 'gpt-image-1',
      apiKey: agentApiKey.trim(),
    };
    const localModelEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(selectedAgentConfig.baseUrl);
    if (agentBackend === 'texor-agent' && !selectedAgentConfig.apiKey && !localModelEndpoint) {
      setError('TEXOR 需要模型 API Key。可以切换到本机 CLI 兼容模式，或填写 OpenAI-compatible API。');
      return;
    }
    try {
      await ensureSelectedTemplateForUse();
      let workingSnapshot = workspace;
      if (importSourcePath && importSourcePath !== manuscriptPath) {
        if (!journal) {
          setError('导入已有论文 .tex 需要先输入目标期刊或会议。');
          return;
        }
        workingSnapshot = await importTexPaper({
          texPath: importSourcePath,
          projectRoot: rootPath,
          targetJournal: journal,
        });
        applyWorkspace(workingSnapshot);
        setTexPath(sourcePathForVersion(workingSnapshot, workingSnapshot.currentVersion) || manuscriptPath);
      }
      await createBridgeCommand('codex-task', {
        projectPath: rootPath,
        targetJournal: journal || undefined,
        agentBackend,
        modelConfig: agentBackend === 'texor-agent' ? selectedAgentConfig : undefined,
        instruction:
          mode === 'new'
            ? [
                '建立论文主稿。',
                importSourcePath
                  ? `用户提供的 .tex 已导入为项目主稿 ${manuscriptPath}。请只在这个 main.tex 上继续修改。`
                  : `未提供已有论文，请从零开始在 ${manuscriptPath} 写入完整可编译 LaTeX。`,
                brief ? `用户补充:\n${brief}` : undefined,
              ]
                .filter((line): line is string => Boolean(line))
                .join('\n\n')
            : [
          '加载研究项目并继续论文撰写。',
          importSourcePath
            ? `用户提供的 .tex 已导入为项目主稿 ${manuscriptPath}。请只在这个 main.tex 上继续修改。`
            : `请以项目主稿 ${manuscriptPath} 为唯一论文入口；如该文件不存在，请从零创建完整可编译 LaTeX。`,
          brief ? `用户补充:\n${brief}` : undefined,
        ]
                .filter((line): line is string => Boolean(line))
                .join('\n\n'),
        paperId: mode === 'load' ? workingSnapshot?.paper.id : undefined,
        versionId: mode === 'load' ? rightVersion?.id || workingSnapshot?.currentVersion.id : undefined,
        baseVersionId: mode === 'load' ? rightVersion?.id || workingSnapshot?.currentVersion.id : undefined,
        source: 'browser',
        draftingMode: importSourcePath || workingSnapshot ? 'continue' : 'initial-draft',
        resumeSessionId: sessionIdForProject(rootPath),
        continuedFromCommandId: reusableCommandSessionId === sessionIdForProject(rootPath) ? reusableCommand?.id : undefined,
      });
      setStatus('TEXOR 已接收');
      setObserverOpen(true);
      void refreshWorkspaceList(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : mode === 'new' ? '新建项目失败。' : '加载项目失败。');
    } finally {
      setBusyState(null);
    }
  }

  async function importExistingTexDraft() {
    const sourcePath = texPath.trim();
    const rootPath = projectPath.trim();
    const journal = targetJournal.trim();
    if (!rootPath) {
      setError('请先输入项目路径。项目路径是 Agent 理解和操作代码的工作区，不能用 .tex 路径代替。');
      return;
    }
    if (!sourcePath) {
      setError('请输入已有论文 .tex 文件路径。');
      return;
    }
    if (!journal) {
      setError('请输入目标期刊或会议。');
      return;
    }

    setBusyState('import-tex');
    setError(null);
    try {
      await ensureSelectedTemplateForUse();
      const snapshot = await importTexPaper({
        texPath: sourcePath,
        projectRoot: rootPath,
        targetJournal: journal,
      });
      applyWorkspace(snapshot);
      setTexPath(sourcePathForVersion(snapshot, snapshot.currentVersion) || canonicalManuscriptPath(rootPath));
      void refreshWorkspaceList(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入 LaTeX 失败。');
    } finally {
      setBusyState(null);
    }
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
    if (!observedCommand || observedCommand.status !== 'running') {
      return;
    }
    setBusyState('terminate-command');
    setError(null);
    try {
      await updateBridgeCommand(observedCommand.id, { control: 'terminate' });
      setStatus('正在终止');
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
    const rootPath =
      ('projectPath' in payload && payload.projectPath) ||
      workspace?.paper.projectRoot ||
      workspace?.paper.analysis?.rootPath ||
      projectPath.trim();
    if (!rootPath) {
      setError('请先输入项目路径。恢复 Agent 对话也必须绑定到代码项目工作区。');
      return;
    }
    setBusyState('codex-task');
    setError(null);
    try {
      await createBridgeCommand('codex-task', {
        projectPath: rootPath,
        targetJournal: 'targetJournal' in payload ? payload.targetJournal : targetJournal.trim() || undefined,
        agentBackend: 'agentBackend' in payload ? payload.agentBackend : agentBackend,
        modelConfig: 'modelConfig' in payload ? payload.modelConfig : undefined,
        instruction: resumePrompt(command),
        paperId: 'paperId' in payload ? payload.paperId : workspace?.paper.id,
        versionId: 'versionId' in payload ? payload.versionId : workspace?.currentVersion.id,
        baseVersionId: 'baseVersionId' in payload ? payload.baseVersionId : rightVersion?.id || workspace?.currentVersion.id,
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
      sourceSnippet: located?.snippet,
      anchor: selection.anchor,
    });
  }

  const isBusy = Boolean(busyState);
  const currentPdf = diffPdf?.current.pdfUrl;
  const previousPdf = diffPdf?.previous?.pdfUrl;
  const leftVersion = workspace?.versions.find((version) => version.id === (leftVersionId || diffPdf?.previousVersionId));
  const rightVersion = workspace?.versions.find((version) => version.id === (rightVersionId || diffPdf?.currentVersionId)) || workspace?.currentVersion;
  const diffFailureNotice = diffPdf && !diffPdf.ok ? diffCompileFailureMessage(diffPdf) : '';
  const showSourceDiffFallback = Boolean(diffFailureNotice && leftVersion && rightVersion);
  const versionOptions = workspace?.versions || [];
  const observedCommand = useMemo(() => {
    const ordered = [...bridgeCommands].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const active = [...ordered].reverse().find((command) => command.status === 'queued' || command.status === 'running');
    if (active) {
      return active;
    }
    const latest = ordered[ordered.length - 1] || null;
    return latest && isRecentCommand(latest) ? latest : null;
  }, [bridgeCommands]);
  const observedSessionId = observedCommand?.sessionId || (observedCommand?.result?.sessionId as string | undefined);
  const reusableCommand = reusableSessionCommand(bridgeCommands);
  const reusableCommandSessionId = sessionIdFromCommand(reusableCommand);
  function sessionIdForProject(rootPath?: string): string | undefined {
    const key = normalizeProjectKey(rootPath || projectPath || workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath);
    const activeKey = normalizeProjectKey(workspace?.paper.projectRoot || workspace?.paper.analysis?.rootPath);
    if (!key) {
      return workspace?.paper.codexSessionId;
    }
    if (workspace?.paper.codexSessionId && activeKey === key) {
      return workspace.paper.codexSessionId;
    }
    const summary = workspaceList.find((item) => normalizeProjectKey(item.projectRoot) === key);
    if (summary?.codexSessionId) {
      return summary.codexSessionId;
    }
    return commandMatchesProject(reusableCommand, key, workspace) ? reusableCommandSessionId : undefined;
  }
  const reusableSessionId = sessionIdForProject();
  const canResumeObservedCommand = Boolean(
    observedCommand &&
      observedCommand.type === 'codex-task' &&
      observedSessionId &&
      (observedCommand.status === 'failed' || observedCommand.phase === 'interrupted'),
  );
  const canPauseObservedCommand = Boolean(observedCommand && observedCommand.type === 'codex-task' && observedCommand.status === 'running');
  const observedLogs = (observedCommand?.logs || []).filter((entry) => shouldShowCodexLog(entry.message)).slice(-36);
  const topbarState =
    observedCommand?.status === 'running' || observedCommand?.status === 'queued' ? commandMessage(observedCommand) : workspace ? 'Ready' : '未载入';
  const islandMode =
    observedCommand?.status === 'running' || observedCommand?.status === 'queued'
      ? 'active'
      : workspace
        ? 'ready'
        : 'idle';

  return (
    <div className="studio-app">
      <header className="topbar">
        <div className="brand-mark topbar-brand" aria-label="TEXOR">
          <span>TEXOR</span>
        </div>
        <div className={`status-orb is-${observedCommand?.status || (health?.ok ? 'ready' : 'connecting')} mode-${islandMode}`}>
          <div className="status-orb__copy" aria-live="polite">
            <strong>{topbarState}</strong>
          </div>
        </div>
      </header>

      <div className="workspace-shell">
        <aside className="project-sidebar" aria-label="项目">
          <details className="sidebar-section current-project compact-details" open={Boolean(workspace)}>
            <summary>
              <span>当前项目</span>
              <strong>{workspace?.currentVersion.label || '未载入'}</strong>
            </summary>
            <p>{workspace?.paper.projectRoot || workspace?.paper.title || '选择一个项目，或新建一个 texor 项目。'}</p>
            <div className="workspace-stats">
              <span>{workspace ? `${workspace.versions.length} 个版本` : '0 个版本'}</span>
              <span>{bridgeCommands.length} 条对话</span>
            </div>
            {workspace ? (
              <button type="button" className="icon-button sidebar-secondary" onClick={() => setDraftOpen(true)}>
                <History size={14} />
                <span>版本历史</span>
              </button>
            ) : null}
          </details>

          <details className="sidebar-section workspace-list compact-details">
            <summary>
              <span>项目库</span>
              <strong>{workspaceList.length}</strong>
            </summary>
            <div className="workspace-items">
              {workspaceList.length ? (
                workspaceList.map((item) => (
                  <div
                    key={item.paperId}
                    className={`workspace-item ${workspace?.paper.id === item.paperId ? 'is-active' : ''}`}
                  >
                    <button type="button" className="workspace-item__main" onClick={() => void openWorkspace(item.paperId)} disabled={isBusy}>
                      <strong>{item.projectRoot || item.title}</strong>
                      <span>{item.sourcePath ? `论文 ${item.sourcePath}` : item.title}</span>
                      <em>
                        {item.currentVersionLabel} · {item.versionCount} 版 · {dateLabel(item.updatedAt)}
                      </em>
                    </button>
                    <button
                      type="button"
                      className="workspace-item__delete"
                      onClick={() => void removeWorkspace(item)}
                      disabled={isBusy}
                      aria-label={`删除 ${item.projectRoot || item.title}`}
                      title="删除项目记录"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="workspace-empty">暂无项目</div>
              )}
            </div>
          </details>

          <details className="sidebar-section compact-details" open={!workspace || !canPauseObservedCommand}>
            <summary>
              <span>{projectMode === 'new' ? '新建项目记录' : '加载项目记录'}</span>
              <strong>{projectMode === 'new' ? '新项目' : '已有项目'}</strong>
            </summary>
            <div className="mode-switch" role="tablist" aria-label="项目模式">
              <button
                type="button"
                className={projectMode === 'load' ? 'is-active' : ''}
                onClick={() => setProjectMode('load')}
                title="加载已有 TEXOR 项目记录，继续同一个项目的 Agent 对话和论文版本历史"
              >
                <FolderOpen size={14} />
                <span>加载项目</span>
              </button>
              <button
                type="button"
                className={projectMode === 'new' ? 'is-active' : ''}
                onClick={() => setProjectMode('new')}
                title="为这个代码项目建立新的 TEXOR 记录，从已有 .tex 或空白主稿开始"
              >
                <FilePlus2 size={14} />
                <span>新建项目</span>
              </button>
            </div>
            <label className="sidebar-field">
              <span>代码项目路径 · 必填</span>
              <input
                className="path-input"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder="/path/to/code-project"
                aria-label="项目路径"
              />
              <small>Agent 在这里理解项目、运行实验、生成或更新图表。</small>
            </label>
            <label className="sidebar-field">
              <span>Agent 后端</span>
              <select className="path-input" value={agentBackend} onChange={(event) => setAgentBackend(event.target.value as 'texor-agent' | 'codex-cli')}>
                <option value="texor-agent">TEXOR · 用户模型 API</option>
                <option value="codex-cli">TEXOR · 本机 CLI 兼容模式</option>
              </select>
              <small>{agentBackend === 'texor-agent' ? 'TEXOR 自己编排工具循环，底层模型由用户提供。' : '继续使用本机 CLI 兼容模式。'}</small>
            </label>
            {agentBackend === 'texor-agent' ? (
              <div className="agent-config-grid">
                <label className="sidebar-field">
                  <span>Base URL</span>
                  <input className="path-input" value={agentBaseUrl} onChange={(event) => setAgentBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
                </label>
                <label className="sidebar-field">
                  <span>模型</span>
                  <input className="path-input" value={agentModel} onChange={(event) => setAgentModel(event.target.value)} placeholder="gpt-4.1-mini / deepseek-chat" />
                </label>
                <label className="sidebar-field">
                  <span>图片模型</span>
                  <input className="path-input" value={agentImageModel} onChange={(event) => setAgentImageModel(event.target.value)} placeholder="gpt-image-1" />
                </label>
                <label className="sidebar-field">
                  <span>API Key</span>
                  <input className="path-input" value={agentApiKey} onChange={(event) => setAgentApiKey(event.target.value)} placeholder="sk-..." type="password" />
                </label>
              </div>
            ) : null}
            <label className="sidebar-field">
              <span>导入论文 .tex · 当前项目可选</span>
              <input
                className="path-input"
                value={texPath}
                onChange={(event) => setTexPath(event.target.value)}
                placeholder="已有初稿 .tex，可留空"
                aria-label="已有论文 tex 文件路径"
              />
              <small>只作为当前项目的初稿导入，TEXOR 会复制到项目内 .texor/manuscript/main.tex。</small>
            </label>
            <label className="sidebar-field">
              <span>期刊</span>
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
                  placeholder="输入期刊或会议"
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
            </label>
            {selectedTemplate ? (
              <div className={`template-status is-${templateStatus?.status || (selectedTemplate.cached ? 'cached' : 'pending')}`}>
                <span>{templateStatus?.message || (selectedTemplate.cached ? '模板已缓存' : '首次使用会自动下载模板')}</span>
                {!selectedTemplate.cached && templateStatus?.status !== 'downloaded' && templateStatus?.status !== 'cached' ? (
                  <button type="button" onClick={() => void ensureSelectedTemplateForUse()} disabled={isBusy}>
                    {status === '首次使用，下载模板' ? <LoaderCircle className="spin" size={13} /> : null}
                    <span>下载</span>
                  </button>
                ) : null}
              </div>
            ) : null}
            <label className="sidebar-field">
              <span>给 Agent</span>
              <textarea
                className="project-brief"
                value={projectBrief}
                onChange={(event) => setProjectBrief(event.target.value)}
                placeholder="可选：补充目标、数据、希望强调的贡献"
                rows={3}
              />
            </label>
            <button type="button" className="icon-button sidebar-secondary" onClick={() => void importExistingTexDraft()} disabled={isBusy}>
              {busyState === 'import-tex' ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}
              <span>导入当前项目 .tex</span>
            </button>
            <button type="button" className="icon-button primary-action sidebar-start" onClick={() => void startProjectWithCodex()} disabled={isBusy}>
              {busyState === 'load-project' || busyState === 'new-project' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
              <span>{projectMode === 'new' ? '新建并启动' : '加载并启动'}</span>
            </button>
          </details>

          {canPauseObservedCommand ? (
            <div className="sidebar-section writing-controls">
              <button type="button" className="icon-button primary-action sidebar-start" onClick={() => void pauseObservedCommand()} disabled={isBusy}>
                {busyState === 'pause-command' ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                <span>暂停撰写</span>
              </button>
              <button type="button" className="icon-button sidebar-secondary danger" onClick={() => void terminateObservedCommand()} disabled={isBusy}>
                <X size={14} />
                <span>终止撰写</span>
              </button>
            </div>
          ) : canResumeObservedCommand && observedCommand ? (
            <div className="sidebar-section writing-controls">
              <button type="button" className="icon-button primary-action sidebar-start" onClick={() => void resumeCodexCommand(observedCommand)} disabled={isBusy}>
                <RotateCcw size={15} />
                <span>继续撰写</span>
              </button>
              <button type="button" className="icon-button sidebar-secondary danger" onClick={() => void terminateObservedCommand()} disabled={isBusy}>
                <X size={14} />
                <span>终止撰写</span>
              </button>
            </div>
          ) : null}

          <section className={`codex-observer ${observerOpen ? 'is-open' : 'is-collapsed'}`}>
            <button
              type="button"
              className="codex-observer__toggle"
              onClick={() => setObserverOpen((value) => !value)}
              aria-expanded={observerOpen}
            >
              <Sparkles size={15} />
              <span>TEXOR</span>
              <strong>{commandStatusLabel(observedCommand)}</strong>
              {observerOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            {observerOpen ? (
              <div className="codex-observer__body">
                <div className="codex-progress" aria-live="polite" aria-label="TEXOR 当前状态">
                  <div className={`codex-progress__pulse is-${observedCommand?.status || 'idle'}`}>
                    {observedCommand?.status === 'running' || observedCommand?.status === 'queued' ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : observedCommand?.status === 'failed' ? (
                      <CircleAlert size={16} />
                    ) : (
                      <Check size={16} />
                    )}
                  </div>
                  <div className="codex-progress__copy">
                    <strong>{commandMessage(observedCommand)}</strong>
                    {observedCommand ? (
                      <span>
                        {observedCommand.phase || observedCommand.status}
                        {observedSessionId ? ` · ${observedSessionId.slice(0, 8)}` : ''}
                      </span>
                    ) : (
                      <span>没有正在运行的任务</span>
                    )}
                  </div>
                </div>
                <div className="codex-log-list" aria-label="TEXOR 输出">
                  {observedLogs.length ? (
                    observedLogs.map((entry) => (
                      <div className={`codex-log-entry is-${entry.stream}`} key={entry.id}>
                        <time>{commandTimeLabel(entry.time)}</time>
                        <p>{compactLogMessage(entry.message)}</p>
                      </div>
                    ))
                  ) : (
                    <div className="codex-log-empty">等待 TEXOR 输出</div>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        </aside>

        <div className="workbench-main">
          {error ? (
            <div className="error-banner">
              <CircleAlert size={15} />
              <span>{error}</span>
            </div>
          ) : null}

          <main className="pdf-compare">
            <section className="pdf-pane previous-pane">
              <div className="pane-label">
                <span>Previous</span>
                <select
                  value={leftVersion?.id || ''}
                  onChange={(event) => selectComparison('left', event.target.value)}
                  aria-label="选择左侧版本"
                  disabled={!workspace || versionOptions.length < 2}
                >
                  <option value="">None</option>
                  {versionOptions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.label}
                    </option>
                  ))}
                </select>
                {manualVersionSelection ? (
                  <button type="button" className="pane-reset" onClick={resetComparison}>
                    最新
                  </button>
                ) : null}
              </div>
              {previousPdf ? (
                <SelectablePdf title="Previous version PDF" pdfUrl={previousPdf} />
              ) : showSourceDiffFallback && leftVersion && rightVersion ? (
                <SourceDiffFallback version={leftVersion} reference={rightVersion} side="previous" message={diffFailureNotice} />
              ) : (
                <div className="pdf-empty">上一版本</div>
              )}
            </section>

            <section className="pdf-pane current-pane">
              <div className="pane-label">
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
              </div>
              {currentPdf ? (
                <SelectablePdf
                  title="Current version PDF"
                  pdfUrl={currentPdf}
                  selectable
                  clearSelectionSignal={pdfSelectionClearSignal}
                  onSelectRegion={(selection) => void handlePdfRegionSelection(selection)}
                />
              ) : showSourceDiffFallback && leftVersion && rightVersion ? (
                <SourceDiffFallback version={rightVersion} reference={leftVersion} side="current" message={diffFailureNotice} />
              ) : (
                <div className="pdf-empty">当前版本</div>
              )}
            </section>
          </main>
        </div>
      </div>

      {draftOpen && workspace ? (
        <aside className="draft-drawer">
          <div className="drawer-head">
            <div>
              <strong>{workspace.paper.title}</strong>
              <span>{workspace.paper.targetJournal}</span>
            </div>
            <button type="button" className="ghost-icon-button" onClick={() => setDraftOpen(false)} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
          <PaperPreview
            blocks={workspace.currentVersion.blocks}
            onAnnotate={(target) => setAnnotationTarget(target)}
            compact
          />
        </aside>
      ) : null}

      {annotationTarget ? (
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
