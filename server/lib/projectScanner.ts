import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectAnalysis, ResultArtifact } from '../types.js';
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

async function previewArtifact(filePath: string, ext: string): Promise<string[][] | undefined> {
  if (!['.csv', '.tsv', '.json'].includes(ext)) {
    return undefined;
  }
  const raw = await fs.readFile(filePath, 'utf8');
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.entries(parsed)
        .slice(0, 6)
        .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
    } catch {
      return undefined;
    }
  }
  const delimiter = ext === '.tsv' ? '\t' : ',';
  return raw
    .split('\n')
    .slice(0, 5)
    .map((line) => line.split(delimiter).map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
}

export async function scanProject(rootPath: string): Promise<ProjectAnalysis> {
  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory()) {
    throw new Error('The provided path is not a directory.');
  }

  const projectName = path.basename(rootPath);
  const files = await walkProject(rootPath);
  const languageCounts = new Map<string, number>();
  const textSamples: string[] = [];
  const rawEvidence: string[] = [];
  const importantFiles: ProjectAnalysis['importantFiles'] = [];
  const resultArtifacts: ResultArtifact[] = [];
  let readmeSummary = '';

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    const relativePath = path.relative(rootPath, filePath);
    countExtension(filePath, languageCounts);

    if (RESULT_EXTENSIONS.has(ext)) {
      resultArtifacts.push({
        path: relativePath,
        kind: RESULT_EXTENSIONS.get(ext) as ResultArtifact['kind'],
        summary: `Captured from ${relativePath}`,
        preview: await previewArtifact(filePath, ext),
      });
    }

    if (!TEXT_EXTENSIONS.has(ext)) {
      continue;
    }

    const fileStat = await fs.stat(filePath);
    if (fileStat.size > 96 * 1024) {
      continue;
    }

    const content = await fs.readFile(filePath, 'utf8');
    const snippet = takeSnippet(content);
    if (snippet) {
      textSamples.push(content);
      rawEvidence.push(`${relativePath}: ${snippet}`);
    }

    if (!readmeSummary && /readme/i.test(path.basename(filePath))) {
      readmeSummary = snippet;
    }

    if (/(train|test|run|experiment|model|result|plot|eval)/i.test(relativePath) && importantFiles.length < 8) {
      importantFiles.push({
        path: relativePath,
        reason: 'Likely relevant to the experiment or writing context.',
        snippet,
      });
    }
  }

  const methods = detectMethodHints(textSamples);
  const results = detectResultHints(resultArtifacts);
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
      gitContext.isRepo ? `Git context detected on branch ${gitContext.branch}.` : 'No git metadata was detected for the imported project.',
    ],
    rawEvidence: rawEvidence.slice(0, 12),
    gitContext,
  };
}
