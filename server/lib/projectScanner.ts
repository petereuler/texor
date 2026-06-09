import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectAnalysis, ProjectCommandHint, ProjectDossier, ResultArtifact } from '../types.js';
import { readGitContext } from './gitContext.js';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  '.texor-data',
]);

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.py',
  '.ipynb',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.tsv',
  '.r',
  '.jl',
  '.m',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.java',
  '.go',
  '.rs',
  '.sh',
]);

const RESULT_EXTENSIONS = new Map<string, ResultArtifact['kind']>([
  ['.png', 'figure'],
  ['.jpg', 'figure'],
  ['.jpeg', 'figure'],
  ['.svg', 'figure'],
  ['.pdf', 'document'],
  ['.csv', 'table'],
  ['.tsv', 'table'],
  ['.json', 'metrics'],
  ['.log', 'other'],
]);

const ENTRYPOINT_PATH_PATTERN = /(train|main|run|launch|infer|inference|predict|demo|serve|eval|test|experiment|finetune|validate|sweep|benchmark)/i;
const FIGURE_PATH_PATTERN = /(plot|figure|chart|visual|viz|draw|graph)/i;
const EXPERIMENT_PATH_PATTERN = /(train|experiment|benchmark|ablation|eval|test|validate|finetune|sweep|search|runner|launch)/i;

const DATASET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bcifar-?10\b/i, label: 'CIFAR-10' },
  { pattern: /\bcifar-?100\b/i, label: 'CIFAR-100' },
  { pattern: /\bimagenet(?:-1k)?\b/i, label: 'ImageNet' },
  { pattern: /\bmscoco\b|\bcoco\b/i, label: 'COCO' },
  { pattern: /\bpascal\s+voc\b|\bvoc20(?:07|12)\b/i, label: 'PASCAL VOC' },
  { pattern: /\bcityscapes\b/i, label: 'Cityscapes' },
  { pattern: /\blibrispeech\b/i, label: 'LibriSpeech' },
  { pattern: /\bwikitext(?:-103|-2)?\b/i, label: 'WikiText' },
  { pattern: /\bsquad(?:\sv2)?\b/i, label: 'SQuAD' },
  { pattern: /\bglue\b/i, label: 'GLUE' },
  { pattern: /\bsuperglue\b/i, label: 'SuperGLUE' },
  { pattern: /\bms\s*marco\b/i, label: 'MS MARCO' },
  { pattern: /\bptb\b|\bpenn treebank\b/i, label: 'Penn Treebank' },
  { pattern: /\bkitti\b/i, label: 'KITTI' },
  { pattern: /\bnuscenes\b/i, label: 'nuScenes' },
  { pattern: /\bade20k\b/i, label: 'ADE20K' },
  { pattern: /\bscannet\b/i, label: 'ScanNet' },
  { pattern: /\bmodelnet\b/i, label: 'ModelNet' },
  { pattern: /\bucf101\b/i, label: 'UCF101' },
  { pattern: /\bhmdb51\b/i, label: 'HMDB51' },
];

const METRIC_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\baccuracy\b/i, label: 'accuracy' },
  { pattern: /\btop-?1\b/i, label: 'top-1 accuracy' },
  { pattern: /\btop-?5\b/i, label: 'top-5 accuracy' },
  { pattern: /\bf1(?:-score)?\b/i, label: 'F1' },
  { pattern: /\bprecision\b/i, label: 'precision' },
  { pattern: /\brecall\b/i, label: 'recall' },
  { pattern: /\bauroc\b|\bauc\b/i, label: 'AUC/AUROC' },
  { pattern: /\bmap\b|\bmean average precision\b/i, label: 'mAP' },
  { pattern: /\bndcg\b/i, label: 'NDCG' },
  { pattern: /\bbleu\b/i, label: 'BLEU' },
  { pattern: /\brouge\b/i, label: 'ROUGE' },
  { pattern: /\bmeteor\b/i, label: 'METEOR' },
  { pattern: /\bcider\b/i, label: 'CIDEr' },
  { pattern: /\bperplexity\b|\bppl\b/i, label: 'perplexity' },
  { pattern: /\bpsnr\b/i, label: 'PSNR' },
  { pattern: /\bssim\b/i, label: 'SSIM' },
  { pattern: /\bmae\b/i, label: 'MAE' },
  { pattern: /\bmse\b/i, label: 'MSE' },
  { pattern: /\brmse\b/i, label: 'RMSE' },
  { pattern: /\biou\b/i, label: 'IoU' },
  { pattern: /\bdice\b/i, label: 'Dice' },
  { pattern: /\blatency\b/i, label: 'latency' },
  { pattern: /\bthroughput\b/i, label: 'throughput' },
];

interface TextRecord {
  relativePath: string;
  content: string;
  snippet: string;
}

function takeSnippet(content: string, maxLength = 260): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function countExtension(filePath: string, counts: Map<string, number>): void {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) {
    return;
  }
  counts.set(ext, (counts.get(ext) || 0) + 1);
}

function pushUniqueString(values: string[], value: string, limit: number): void {
  const normalized = value.trim();
  if (!normalized || values.includes(normalized) || values.length >= limit) {
    return;
  }
  values.push(normalized);
}

function pushUniqueCommandHint(values: ProjectCommandHint[], hint: ProjectCommandHint, limit: number): void {
  const command = hint.command.trim();
  const source = hint.source.trim();
  if (!command || !source || values.length >= limit) {
    return;
  }
  if (values.some((entry) => entry.command === command || (entry.command === command && entry.source === source))) {
    return;
  }
  values.push({
    command,
    source,
    reason: hint.reason.trim() || 'Candidate project command.',
  });
}

async function walkProject(rootPath: string): Promise<string[]> {
  const discovered: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0 && discovered.length < 800) {
    const current = stack.pop() as string;
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      discovered.push(fullPath);
      if (discovered.length >= 800) {
        break;
      }
    }
  }

  return discovered;
}

function detectMethodHints(contents: string[]): string[] {
  const joined = contents.join('\n');
  const hints: string[] = [];
  if (/torch|pytorch/i.test(joined)) hints.push('The project appears to rely on PyTorch for training or inference.');
  if (/transformer|attention/i.test(joined)) hints.push('Transformer-like modeling components appear in the codebase.');
  if (/cnn|convolution/i.test(joined)) hints.push('Convolution-based feature extraction is part of the implementation.');
  if (/lstm|gru|recurrent/i.test(joined)) hints.push('Sequential modeling baselines or recurrent modules appear in the project.');
  if (/ablation/i.test(joined)) hints.push('The repository includes ablation-oriented experiment structure.');
  if (/latency|throughput|profil/i.test(joined)) hints.push('Performance or deployment metrics are part of the project evidence.');
  return Array.from(new Set(hints)).slice(0, 5);
}

function detectResultHints(artifacts: ResultArtifact[]): string[] {
  const hints: string[] = [];
  if (artifacts.some((artifact) => artifact.kind === 'table')) hints.push('Tabular result artifacts are available for the manuscript draft.');
  if (artifacts.some((artifact) => artifact.kind === 'figure')) hints.push('Visual result artifacts can be used to support the paper narrative.');
  if (artifacts.some((artifact) => artifact.kind === 'metrics')) hints.push('Machine-readable metrics are available for quantitative writing.');
  return hints.length > 0 ? hints : ['No strong result artifact was detected automatically, so the first draft may contain placeholders.'];
}

function fileInterestingScore(relativePath: string): number {
  const basename = path.basename(relativePath).toLowerCase();
  const segments = relativePath.split(/[\\/]/).length;
  let score = 0;
  if (/readme/i.test(basename)) score += 20;
  if (ENTRYPOINT_PATH_PATTERN.test(basename)) score += 14;
  if (EXPERIMENT_PATH_PATTERN.test(relativePath)) score += 8;
  if (FIGURE_PATH_PATTERN.test(relativePath)) score += 4;
  score += Math.max(0, 6 - segments);
  return score;
}

function rankPaths(paths: string[], limit: number, extraFilter?: (value: string) => boolean): string[] {
  return [...new Set(paths)]
    .filter((value) => !extraFilter || extraFilter(value))
    .sort((left, right) => fileInterestingScore(right) - fileInterestingScore(left) || left.localeCompare(right))
    .slice(0, limit);
}

function collectDatasetHints(relativePaths: string[], records: TextRecord[]): string[] {
  const hints: string[] = [];
  const joined = [relativePaths.join('\n'), ...records.map((record) => `${record.relativePath}\n${record.content}`)].join('\n');
  for (const { pattern, label } of DATASET_PATTERNS) {
    if (pattern.test(joined)) {
      pushUniqueString(hints, label, 6);
    }
  }

  const datasetPaths = rankPaths(relativePaths, 3, (value) => /(^|[\\/])(data|dataset|datasets|corpus)([\\/]|$)/i.test(value));
  if (datasetPaths.length > 0) {
    pushUniqueString(hints, `dataset-related paths: ${datasetPaths.join(', ')}`, 6);
  }
  return hints;
}

function collectMetricHints(relativePaths: string[], records: TextRecord[]): string[] {
  const hints: string[] = [];
  const joined = [relativePaths.join('\n'), ...records.map((record) => `${record.relativePath}\n${record.content}`)].join('\n');
  for (const { pattern, label } of METRIC_PATTERNS) {
    if (pattern.test(joined)) {
      pushUniqueString(hints, label, 8);
    }
  }
  return hints;
}

function commandReason(command: string): string {
  if (/\b(train|fit|finetune|pretrain)\b/i.test(command)) {
    return 'Likely training or fine-tuning command.';
  }
  if (/\b(eval|evaluate|test|benchmark|validate)\b/i.test(command)) {
    return 'Likely evaluation or benchmark command.';
  }
  if (/\b(plot|figure|visual|viz|draw|render)\b/i.test(command)) {
    return 'Likely plotting or figure-generation command.';
  }
  return 'Candidate project command extracted from repository text.';
}

function collectCommandHints(records: TextRecord[]): ProjectCommandHint[] {
  const hints: ProjectCommandHint[] = [];
  const commandPattern = /(?:^|\n)\s*(?:\$|>)?\s*((?:python(?:3)?|bash|sh|torchrun|accelerate launch|deepspeed|uv run|make|Rscript|node)\s+[^\n]{1,220})/g;

  for (const record of records) {
    let match: RegExpExecArray | null = null;
    while ((match = commandPattern.exec(record.content)) !== null) {
      const command = match[1]?.trim();
      if (!command || /\b(rm|del|rmdir)\b/i.test(command)) {
        continue;
      }
      pushUniqueCommandHint(
        hints,
        {
          command,
          source: record.relativePath,
          reason: commandReason(command),
        },
        8,
      );
    }
  }

  if (hints.length > 0) {
    return hints;
  }

  const fallbackFiles = rankPaths(
    records.map((record) => record.relativePath),
    4,
    (value) => /\.(py|sh|r|jl|m)$/i.test(value) && (ENTRYPOINT_PATH_PATTERN.test(value) || FIGURE_PATH_PATTERN.test(value)),
  );
  for (const filePath of fallbackFiles) {
    pushUniqueCommandHint(
      hints,
      {
        command: path.extname(filePath).toLowerCase() === '.sh' ? `bash ${filePath}` : `python ${filePath}`,
        source: filePath,
        reason: ENTRYPOINT_PATH_PATTERN.test(filePath) ? 'Fallback command from likely entrypoint script.' : 'Fallback command from likely figure or utility script.',
      },
      8,
    );
  }
  return hints;
}

function buildOpenQuestions(dossier: Omit<ProjectDossier, 'agentBrief' | 'openQuestions'>, resultArtifacts: ResultArtifact[]): string[] {
  const questions: string[] = [];
  if (dossier.datasetHints.length === 0) {
    pushUniqueString(questions, 'Dataset identity is still unclear from the lightweight scan.', 6);
  }
  if (dossier.metricHints.length === 0) {
    pushUniqueString(questions, 'Metric names are still unclear; the manuscript may need conservative TODO markers for quantitative claims.', 6);
  }
  if (dossier.commandHints.length === 0) {
    pushUniqueString(questions, 'No reliable runnable experiment command was extracted automatically.', 6);
  }
  if (resultArtifacts.every((artifact) => artifact.kind !== 'figure')) {
    pushUniqueString(questions, 'No obvious figure artifact was detected yet, so figure sections may need placeholders or generated diagrams.', 6);
  }
  if (resultArtifacts.every((artifact) => artifact.kind !== 'table' && artifact.kind !== 'metrics')) {
    pushUniqueString(questions, 'No strong tabular or machine-readable metrics artifact was detected yet.', 6);
  }
  if (dossier.entryPoints.length === 0) {
    pushUniqueString(questions, 'The scan did not isolate a clear training or evaluation entrypoint.', 6);
  }
  return questions;
}

function buildAgentBrief(projectName: string, methods: string[], dossier: Omit<ProjectDossier, 'agentBrief'>, resultArtifacts: ResultArtifact[]): string {
  const parts = [
    `${projectName} should be treated as a research codebase rather than a generic software project.`,
    dossier.entryPoints.length > 0
      ? `Likely entrypoints include ${dossier.entryPoints.slice(0, 3).join(', ')}.`
      : 'No reliable training or evaluation entrypoint was isolated from the lightweight scan.',
    methods.length > 0 ? `Method cues: ${methods.slice(0, 2).join(' ')}` : '',
    dossier.datasetHints.length > 0
      ? `Dataset hints: ${dossier.datasetHints.slice(0, 4).join(', ')}.`
      : 'Dataset identity is still unclear from the scanned files.',
    dossier.metricHints.length > 0
      ? `Metric hints: ${dossier.metricHints.slice(0, 5).join(', ')}.`
      : 'Metric names are still unclear from the scanned files.',
    resultArtifacts.length > 0
      ? `Detected result artifacts include ${resultArtifacts.slice(0, 3).map((artifact) => artifact.path).join(', ')}.`
      : 'No strong result artifact was automatically detected yet.',
    dossier.commandHints.length > 0
      ? `Candidate runnable commands: ${dossier.commandHints.slice(0, 2).map((hint) => hint.command).join(' ; ')}.`
      : '',
    dossier.openQuestions.length > 0
      ? `Open questions: ${dossier.openQuestions.slice(0, 2).join(' ')}`
      : '',
  ].filter(Boolean);

  return parts.join(' ').replace(/\s+/g, ' ').trim();
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

function compactPreviewCell(value: unknown, limit = 72): string {
  const raw = typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return raw.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function previewRowsFromJson(parsed: unknown): string[][] | undefined {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return undefined;
    }
    if (parsed.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
      const objects = parsed as Array<Record<string, unknown>>;
      const headers = [...new Set(objects.flatMap((entry) => Object.keys(entry)))].slice(0, 6);
      const rows = objects
        .slice(0, 4)
        .map((entry) => headers.map((header) => compactPreviewCell(entry[header])));
      return [headers, ...rows];
    }
    if (parsed.every((entry) => Array.isArray(entry))) {
      return (parsed as unknown[][])
        .slice(0, 5)
        .map((row) => row.slice(0, 6).map((cell) => compactPreviewCell(cell)))
        .filter((row) => row.some(Boolean));
    }
    return parsed
      .slice(0, 5)
      .map((entry) => [compactPreviewCell(entry)])
      .filter((row) => row.some(Boolean));
  }
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed as Record<string, unknown>)
      .slice(0, 6)
      .map(([key, value]) => [key, compactPreviewCell(value)]);
  }
  return undefined;
}

async function previewArtifact(filePath: string, ext: string): Promise<string[][] | undefined> {
  if (!['.csv', '.tsv', '.json'].includes(ext)) {
    return undefined;
  }
  const raw = await fs.readFile(filePath, 'utf8');
  if (ext === '.json') {
    try {
      return previewRowsFromJson(JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  }
  const delimiter = ext === '.tsv' ? '\t' : ',';
  return raw
    .split('\n')
    .slice(0, 5)
    .map((line) => splitDelimitedLine(line, delimiter).map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
}

function resultArtifactSummary(relativePath: string, kind: ResultArtifact['kind'], preview?: string[][]): string {
  if (preview && preview.length > 1) {
    const columnCount = Math.max(...preview.map((row) => row.length));
    const rowCount = Math.max(0, preview.length - 1);
    return `Captured ${kind} artifact from ${relativePath} with preview shape ${rowCount}x${columnCount}.`;
  }
  if (preview && preview.length === 1) {
    return `Captured ${kind} artifact from ${relativePath} with a single preview row.`;
  }
  return `Captured ${kind} artifact from ${relativePath}.`;
}

export async function scanProject(rootPath: string): Promise<ProjectAnalysis> {
  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory()) {
    throw new Error('The provided path is not a directory.');
  }

  const projectName = path.basename(rootPath);
  const files = await walkProject(rootPath);
  const relativePaths = files.map((filePath) => path.relative(rootPath, filePath));
  const languageCounts = new Map<string, number>();
  const textSamples: string[] = [];
  const textRecords: TextRecord[] = [];
  const rawEvidence: string[] = [];
  const importantFiles: ProjectAnalysis['importantFiles'] = [];
  const resultArtifacts: ResultArtifact[] = [];
  let readmeSummary = '';

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    const relativePath = path.relative(rootPath, filePath);
    countExtension(filePath, languageCounts);

    if (RESULT_EXTENSIONS.has(ext)) {
      const kind = RESULT_EXTENSIONS.get(ext) as ResultArtifact['kind'];
      const preview = await previewArtifact(filePath, ext);
      resultArtifacts.push({
        path: relativePath,
        kind,
        summary: resultArtifactSummary(relativePath, kind, preview),
        preview,
      });
    }

    if (!TEXT_EXTENSIONS.has(ext)) {
      continue;
    }

    const fileStat = await fs.stat(filePath);
    if (fileStat.size > 96 * 1024) {
      continue;
    }

    const content = await fs.readFile(filePath, 'utf8').catch(() => '');
    if (!content) {
      continue;
    }
    const snippet = takeSnippet(content);
    if (snippet) {
      textSamples.push(content);
      textRecords.push({ relativePath, content, snippet });
      rawEvidence.push(`${relativePath}: ${snippet}`);
    }

    if (!readmeSummary && /readme/i.test(path.basename(filePath))) {
      readmeSummary = snippet;
    }

    if (/(train|test|run|experiment|model|result|plot|eval|figure|dataset|data)/i.test(relativePath) && importantFiles.length < 10) {
      importantFiles.push({
        path: relativePath,
        reason: 'Likely relevant to experiments, results, datasets, or manuscript grounding.',
        snippet,
      });
    }
  }

  const methods = detectMethodHints(textSamples);
  const results = detectResultHints(resultArtifacts);
  const entryPoints = rankPaths(relativePaths, 8, (value) => /readme/i.test(path.basename(value)) || ENTRYPOINT_PATH_PATTERN.test(value));
  const experimentFiles = rankPaths(relativePaths, 8, (value) => EXPERIMENT_PATH_PATTERN.test(value));
  const figureScripts = rankPaths(relativePaths, 6, (value) => FIGURE_PATH_PATTERN.test(value));
  const datasetHints = collectDatasetHints(relativePaths, textRecords);
  const metricHints = collectMetricHints(relativePaths, textRecords);
  const commandHints = collectCommandHints(textRecords);

  const dossierWithoutSummary: Omit<ProjectDossier, 'agentBrief'> = {
    entryPoints,
    experimentFiles,
    figureScripts,
    datasetHints,
    metricHints,
    commandHints,
    openQuestions: [],
  };
  dossierWithoutSummary.openQuestions = buildOpenQuestions(dossierWithoutSummary, resultArtifacts);

  const dossier: ProjectDossier = {
    ...dossierWithoutSummary,
    agentBrief: buildAgentBrief(projectName, methods, dossierWithoutSummary, resultArtifacts),
  };

  const gitContext = await readGitContext(rootPath);

  return {
    rootPath,
    projectName,
    overview: `texor inspected ${files.length} files under ${projectName}. ${methods[0] || 'The repository appears to contain a research or technical implementation.'}`,
    purpose: readmeSummary || `The ${projectName} repository appears to be a project that can be turned into a paper draft with AI assistance.`,
    methods: methods.length > 0 ? methods : ['The implementation likely contains model code, experiment scripts, and evaluation logic.'],
    results,
    recommendedSections: ['Abstract', 'Introduction', 'Method', 'Experimental Setup', 'Results', 'Conclusion'],
    languageBreakdown: Array.from(languageCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, value]) => ({ label, value })),
    importantFiles,
    resultArtifacts: resultArtifacts.slice(0, 8),
    ingestNotes: [
      'This analysis is only a lightweight context pass for AI drafting.',
      'Large files and cache-heavy folders were skipped to keep the interaction responsive.',
      'The dossier is heuristic and should be treated as evidence cues rather than guaranteed facts.',
      gitContext.isRepo ? `Git context detected on branch ${gitContext.branch}.` : 'No git metadata was detected for the imported project.',
    ],
    rawEvidence: rawEvidence.slice(0, 12),
    dossier,
    gitContext,
  };
}
