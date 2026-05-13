import crypto from 'node:crypto';
import { diffWordsWithSpace } from 'diff';
import path from 'node:path';
import { FigureBlock, ModelConfig, PaperBlock, PaperRecord, PaperVersion, ProjectAnalysis, TableBlock, TextBlock, WorkspaceSnapshot } from '../types.js';
import { callOpenAICompatible } from './modelClient.js';

function nowIso(): string {
  return new Date().toISOString();
}

function escapeLatex(source: string): string {
  return source
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

interface WordDiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

function tokenizeWithSpace(value: string): string[] {
  return value.match(/\s+|\S+/g) || [];
}

function diffWords(previous: string, current: string): WordDiffPart[] {
  const left = tokenizeWithSpace(previous);
  const right = tokenizeWithSpace(current);
  const dp: number[][] = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      dp[leftIndex][rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? dp[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(dp[leftIndex + 1][rightIndex], dp[leftIndex][rightIndex + 1]);
    }
  }

  const parts: WordDiffPart[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      parts.push({ value: left[leftIndex] });
      leftIndex += 1;
      rightIndex += 1;
    } else if (dp[leftIndex + 1][rightIndex] >= dp[leftIndex][rightIndex + 1]) {
      parts.push({ value: left[leftIndex], removed: true });
      leftIndex += 1;
    } else {
      parts.push({ value: right[rightIndex], added: true });
      rightIndex += 1;
    }
  }

  while (leftIndex < left.length) {
    parts.push({ value: left[leftIndex], removed: true });
    leftIndex += 1;
  }
  while (rightIndex < right.length) {
    parts.push({ value: right[rightIndex], added: true });
    rightIndex += 1;
  }

  return parts;
}

function markLatexDiff(previous: string, current: string, side: 'previous' | 'current'): string {
  return diffWords(previous, current)
    .filter((part) => {
      if (side === 'current' && part.removed) {
        return false;
      }
      if (side === 'previous' && part.added) {
        return false;
      }
      return true;
    })
    .map((part) => {
      const escaped = escapeLatex(part.value);
      if (!part.value.trim()) {
        return escaped;
      }
      if (side === 'current' && part.added) {
        return `\\texoradd{${escaped}}`;
      }
      if (side === 'previous' && part.removed) {
        return `\\texordel{${escaped}}`;
      }
      return escaped;
    })
    .join('');
}

function hasFullLatexDocument(latex: string): boolean {
  return /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(latex) && /\\begin\{document\}/.test(latex);
}

function injectDiffMacros(latex: string): string {
  const macros = [
    '\\usepackage{xcolor}',
    '\\usepackage[normalem]{ulem}',
    '\\definecolor{texoraddfg}{RGB}{21,128,61}',
    '\\definecolor{texordelfg}{RGB}{185,28,28}',
    '\\providecommand{\\texoradd}[1]{\\begingroup\\textcolor{texoraddfg}{\\uline{#1}}\\endgroup}',
    '\\providecommand{\\texordel}[1]{\\begingroup\\textcolor{texordelfg}{\\sout{#1}}\\endgroup}',
    '',
  ].join('\n');

  if (/\\(?:providecommand|newcommand)\s*\{\\texoradd\}/.test(latex) || /\\(?:providecommand|newcommand)\s*\{\\texordel\}/.test(latex)) {
    return latex;
  }

  const beginDocumentIndex = latex.indexOf('\\begin{document}');
  if (beginDocumentIndex >= 0) {
    return `${latex.slice(0, beginDocumentIndex)}${macros}${latex.slice(beginDocumentIndex)}`;
  }
  return `${macros}${latex}`;
}

function isTextualLatexLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('\\')) {
    return false;
  }
  if (/^[%{}[\]&]/.test(trimmed)) {
    return false;
  }
  if (trimmed.includes('&') || trimmed.endsWith('\\\\')) {
    return false;
  }
  if (/^\$|^\[|^\]|^\\\(|^\\\)/.test(trimmed)) {
    return false;
  }
  return /[A-Za-z\u4e00-\u9fff]/.test(trimmed);
}

function markPlainLatexText(previous: string, current: string, side: 'previous' | 'current'): string {
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
    .map((part) => {
      if (!part.value.trim()) {
        return part.value;
      }
      if (side === 'current' && part.added) {
        return `\\texoradd{${part.value}}`;
      }
      if (side === 'previous' && part.removed) {
        return `\\texordel{${part.value}}`;
      }
      return part.value;
    })
    .join('');
}

function lineSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.toLowerCase().match(/[a-z0-9]+/g) || []);
  const rightTokens = new Set(right.toLowerCase().match(/[a-z0-9]+/g) || []);
  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function alignedReferenceLine(line: string, referenceLines: string[], sameIndex: number): string {
  const nearbyStart = Math.max(0, sameIndex - 3);
  const nearbyEnd = Math.min(referenceLines.length, sameIndex + 4);
  let bestLine = referenceLines[sameIndex] || '';
  let bestScore = lineSimilarity(line, bestLine);
  for (let index = nearbyStart; index < nearbyEnd; index += 1) {
    const score = lineSimilarity(line, referenceLines[index] || '');
    if (score > bestScore) {
      bestScore = score;
      bestLine = referenceLines[index] || '';
    }
  }
  return bestScore >= 0.28 ? bestLine : referenceLines[sameIndex] || '';
}

function markFullLatexDiff(previousLatex: string, currentLatex: string, side: 'previous' | 'current'): string {
  const currentLines = currentLatex.split('\n');
  const previousLines = previousLatex.split('\n');
  const outputLines = side === 'current' ? currentLines : previousLines;
  const parts: string[] = [];

  for (let index = 0; index < outputLines.length; index += 1) {
    const outputLine = outputLines[index] || '';
    const referenceLine =
      side === 'current'
        ? alignedReferenceLine(outputLine, previousLines, index)
        : alignedReferenceLine(outputLine, currentLines, index);
    const previousLine = side === 'current' ? referenceLine : outputLine;
    const currentLine = side === 'current' ? outputLine : referenceLine;
    if (isTextualLatexLine(previousLine) && isTextualLatexLine(currentLine)) {
      parts.push(markPlainLatexText(previousLine, currentLine, side));
    } else {
      parts.push(outputLine);
    }
  }

  return injectDiffMacros(parts.join('\n'));
}

function buildPlaceholderFigureUrl(title: string): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
      <rect width="1200" height="720" fill="#f8fafc"/>
      <rect x="90" y="90" width="1020" height="540" rx="12" fill="#ffffff" stroke="#d4d4d8" stroke-width="3"/>
      <path d="M170 520 C270 430 340 368 432 382 C520 396 594 290 694 268 C826 238 900 458 1032 254" fill="none" stroke="#111827" stroke-width="8" stroke-linecap="round"/>
      <text x="170" y="154" font-family="Inter, Arial, sans-serif" font-size="34" fill="#111827">${title}</text>
      <text x="170" y="192" font-family="Inter, Arial, sans-serif" font-size="20" fill="#52525b">Replace with the final paper figure when refining the draft.</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function compactPaths(paths: string[]): string {
  return paths
    .slice(0, 4)
    .map((filePath) => {
      const parts = filePath.split(/[\\/]/).filter(Boolean);
      return parts.length <= 2 ? filePath : `${parts[0]}/${parts[parts.length - 1]}`;
    })
    .join(', ');
}

function pickResultTable(analysis: ProjectAnalysis): TableBlock {
  const tableArtifact = analysis.resultArtifacts.find((artifact) => artifact.kind === 'table' && artifact.preview && artifact.preview.length > 1);
  if (tableArtifact?.preview) {
    const [headers, ...rows] = tableArtifact.preview;
    return {
      id: crypto.randomUUID(),
      type: 'table',
      section: 'Results',
      title: 'Results Table',
      caption: `Imported from ${tableArtifact.path}.`,
      headers,
      rows,
      note: 'This table can be revised in-place through the feedback flow.',
    };
  }

  return {
    id: crypto.randomUUID(),
    type: 'table',
    section: 'Results',
    title: 'Results Table',
    caption: 'Main quantitative results.',
    headers: ['Setting', 'Metric 1', 'Metric 2'],
    rows: [
      ['Baseline', 'TBD', 'TBD'],
      ['Proposed method', 'TBD', 'TBD'],
    ],
    note: 'No machine-readable result table was detected, so the draft keeps a placeholder.',
  };
}

function pickFigure(analysis: ProjectAnalysis): FigureBlock {
  const figureArtifact = analysis.resultArtifacts.find((artifact) => artifact.kind === 'figure');
  const title = figureArtifact ? path.basename(figureArtifact.path) : 'Main Figure';
  return {
    id: crypto.randomUUID(),
    type: 'figure',
    section: 'Results',
    title,
    caption: figureArtifact ? `Candidate figure derived from ${figureArtifact.path}.` : 'A figure slot for the core result or workflow.',
    insight: analysis.results[0] || 'Use this figure to support the central empirical claim.',
    imageUrl: buildPlaceholderFigureUrl(title),
  };
}

function findMatchingBlock(block: PaperBlock, reference: PaperBlock[]): PaperBlock | undefined {
  return (
    reference.find((candidate) => candidate.id === block.id) ||
    reference.find((candidate) => candidate.type === block.type && candidate.title === block.title)
  );
}

function textValue(block: PaperBlock): string {
  if (block.type === 'text') {
    return block.content;
  }
  if (block.type === 'figure') {
    return `${block.caption}\n\n${block.insight}`;
  }
  return `${block.caption}\n\n${block.headers.join(' | ')}\n${block.rows.map((row) => row.join(' | ')).join('\n')}${block.note ? `\n\n${block.note}` : ''}`;
}

function diffTextBlock(block: PaperBlock, reference: PaperBlock | undefined, side: 'previous' | 'current'): TextBlock {
  const previous = side === 'current' ? (reference ? textValue(reference) : '') : textValue(block);
  const current = side === 'current' ? textValue(block) : reference ? textValue(reference) : '';
  return {
    id: block.id,
    type: 'text',
    section: block.section,
    title: block.title,
    content: markLatexDiff(previous, current, side),
  };
}

async function draftPaperBlocks(analysis: ProjectAnalysis, targetJournal: string): Promise<PaperBlock[]> {
  const resultTable = pickResultTable(analysis);
  const figureBlock = pickFigure(analysis);
  const importantPaths = compactPaths(analysis.importantFiles.map((file) => file.path));

  return [
    {
      id: crypto.randomUUID(),
      type: 'text',
      section: 'Abstract',
      title: 'Abstract',
      content: `${analysis.purpose} This draft targets ${targetJournal} and is grounded in the imported repository rather than a manually prepared paper outline. The current evidence suggests ${analysis.results.join(' ')}`,
    },
    {
      id: crypto.randomUUID(),
      type: 'text',
      section: 'Introduction',
      title: 'Introduction',
      content: `${analysis.overview} The goal of this draft is to turn the existing project into a reviewable manuscript that can be iteratively refined through user feedback and AI-assisted rewriting.`,
    },
    {
      id: crypto.randomUUID(),
      type: 'text',
      section: 'Method',
      title: 'Method',
      content: analysis.methods.join(' '),
    },
    {
      id: crypto.randomUUID(),
      type: 'text',
      section: 'Experimental Setup',
      title: 'Experimental Setup',
      content: `The current repository suggests an experiment flow centered on ${importantPaths}. This section should be refined with exact datasets, splits, hardware, training protocol, and evaluation settings after the first drafting pass.`,
    },
    {
      id: crypto.randomUUID(),
      type: 'text',
      section: 'Results',
      title: 'Results',
      content: analysis.results.join(' '),
    },
    resultTable,
    figureBlock,
    {
      id: crypto.randomUUID(),
      type: 'text',
      section: 'Conclusion',
      title: 'Conclusion',
      content: `${analysis.projectName} already contains enough code and result structure to support a paper draft. The remaining work is mainly to tighten the writing, replace placeholders with final figures and numbers, and refine the narrative through revision rounds.`,
    },
  ];
}

function projectEvidencePrompt(analysis: ProjectAnalysis): string {
  const files = analysis.importantFiles
    .slice(0, 12)
    .map((file) => `- ${file.path}: ${file.reason}\n${file.snippet.slice(0, 900)}`)
    .join('\n\n');
  const artifacts = analysis.resultArtifacts
    .slice(0, 10)
    .map((artifact) => {
      const preview = artifact.preview?.slice(0, 6).map((row) => row.join(' | ')).join('\n');
      return `- ${artifact.path} (${artifact.kind}): ${artifact.summary}${preview ? `\n${preview}` : ''}`;
    })
    .join('\n\n');

  return [
    `Project: ${analysis.projectName}`,
    `Root path: ${analysis.rootPath}`,
    `Overview: ${analysis.overview}`,
    `Purpose: ${analysis.purpose}`,
    `Detected methods:\n${analysis.methods.map((item) => `- ${item}`).join('\n')}`,
    `Detected results:\n${analysis.results.map((item) => `- ${item}`).join('\n')}`,
    `Important files:\n${files || 'No important files detected.'}`,
    `Result artifacts:\n${artifacts || 'No result artifacts detected.'}`,
    `Raw evidence:\n${analysis.rawEvidence.slice(0, 12).join('\n')}`,
  ].join('\n\n');
}

function parseModelBlocks(content: string): Array<{ section: string; title: string; content: string }> | null {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : content;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const blocks = parsed
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => typeof entry.section === 'string' && typeof entry.title === 'string' && typeof entry.content === 'string')
      .map((entry) => ({
        section: String(entry.section),
        title: String(entry.title),
        content: String(entry.content),
      }));
    return blocks.length > 0 ? blocks : null;
  } catch {
    return null;
  }
}

async function draftPaperBlocksWithModel(
  analysis: ProjectAnalysis,
  targetJournal: string,
  modelConfig?: ModelConfig,
): Promise<PaperBlock[] | null> {
  const response = await callOpenAICompatible(
    [
      {
        role: 'system',
        content:
          'You are an academic writing assistant. Draft a project-aware manuscript outline from repository evidence. Return only valid JSON: an array of text blocks, each with section, title, and content. Do not invent numeric results. Mark unknown details as TBD.',
      },
      {
        role: 'user',
        content: [
          `Target journal or conference: ${targetJournal}`,
          'Use the following repository evidence to draft a concise first manuscript. Include Abstract, Introduction, Method, Experimental Setup, Results, and Conclusion.',
          projectEvidencePrompt(analysis),
        ].join('\n\n'),
      },
    ],
    modelConfig,
    0.25,
  );

  if (!response) {
    return null;
  }

  const textBlocks = parseModelBlocks(response.content);
  if (!textBlocks) {
    return [
      {
        id: crypto.randomUUID(),
        type: 'text',
        section: 'Draft',
        title: 'Model Draft',
        content: response.content,
      },
    ];
  }

  const blocks: PaperBlock[] = textBlocks.map((block) => ({
    id: crypto.randomUUID(),
    type: 'text',
    section: block.section,
    title: block.title,
    content: block.content,
  }));

  blocks.push(pickResultTable(analysis), pickFigure(analysis));
  return blocks;
}

export async function composeLatex(
  paper: PaperRecord,
  blocks: PaperBlock[],
  options: { rawTextContent?: boolean } = {},
): Promise<string> {
  const renderText = (content: string) => (options.rawTextContent ? content : escapeLatex(content));
  const abstractBlock = blocks.find((block) => block.type === 'text' && block.section === 'Abstract');
  const body = blocks
    .filter((block) => !(block.type === 'text' && block.section === 'Abstract'))
    .map((block) => {
      if (block.type === 'text') {
        return `\\section{${escapeLatex(block.title)}}\n${renderText(block.content)}`;
      }
      if (block.type === 'figure') {
        return `\\begin{figure}[htbp]
\\centering
\\fbox{\\parbox[c][2.0in][c]{0.88\\linewidth}{\\centering ${escapeLatex(block.title)}}}
\\caption{${escapeLatex(block.caption)}}
\\label{fig:${block.id}}
\\end{figure}

${escapeLatex(block.insight)}`;
      }

      const header = block.headers.map((entry) => `\\textbf{${escapeLatex(entry)}}`).join(' & ');
      const rows = block.rows.map((row) => row.map((cell) => escapeLatex(cell)).join(' & ')).join(' \\\\\n');
      return `\\begin{table}[htbp]
\\centering
\\caption{${escapeLatex(block.caption)}}
\\label{tab:${block.id}}
\\small
\\begin{tabular}{${'l'.repeat(Math.max(1, block.headers.length))}}
\\toprule
${header} \\\\
\\midrule
${rows} \\\\
\\bottomrule
\\end{tabular}
\\end{table}
${block.note ? `\n${escapeLatex(block.note)}` : ''}`;
    })
    .join('\n\n');

  return `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[a4paper,margin=0.9in]{geometry}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{xcolor}
\\usepackage{hyperref}
\\usepackage[normalem]{ulem}
\\definecolor{texoraddfg}{RGB}{21,128,61}
\\definecolor{texordelfg}{RGB}{185,28,28}
\\newcommand{\\texoradd}[1]{\\begingroup\\textcolor{texoraddfg}{\\uline{#1}}\\endgroup}
\\newcommand{\\texordel}[1]{\\begingroup\\textcolor{texordelfg}{\\sout{#1}}\\endgroup}
\\setlength{\\parskip}{0.5em}
\\setlength{\\parindent}{0pt}
\\begin{document}
\\title{${escapeLatex(paper.title)}}
\\author{${escapeLatex(paper.authors.join(', '))}}
\\date{\\today}
\\maketitle
\\begin{abstract}
${renderText(abstractBlock && abstractBlock.type === 'text' ? abstractBlock.content : 'Abstract placeholder.')}
\\end{abstract}

${body}
\\end{document}
`;
}

export async function composeDiffLatex(
  paper: PaperRecord,
  version: PaperVersion,
  reference: PaperVersion,
  side: 'previous' | 'current',
): Promise<string> {
  if (hasFullLatexDocument(version.latex) && hasFullLatexDocument(reference.latex)) {
    const previousLatex = side === 'current' ? reference.latex : version.latex;
    const currentLatex = side === 'current' ? version.latex : reference.latex;
    return markFullLatexDiff(previousLatex, currentLatex, side);
  }
  const diffBlocks = version.blocks.map((block) => diffTextBlock(block, findMatchingBlock(block, reference.blocks), side));
  return composeLatex(paper, diffBlocks, { rawTextContent: true });
}

export async function buildPaperWorkspace(
  analysis: ProjectAnalysis,
  targetJournal: string,
  modelConfig?: ModelConfig,
): Promise<WorkspaceSnapshot> {
  const paperId = crypto.randomUUID();
  const paper: PaperRecord = {
    id: paperId,
    title: `${analysis.projectName.replace(/[-_]/g, ' ')} manuscript draft`,
    targetJournal,
    authors: ['Author A', 'Author B'],
    analysis,
    createdAt: nowIso(),
  };

  const blocks = (await draftPaperBlocksWithModel(analysis, targetJournal, modelConfig)) || (await draftPaperBlocks(analysis, targetJournal));
  const latex = await composeLatex(paper, blocks);
  const version: PaperVersion = {
    id: crypto.randomUUID(),
    paperId,
    label: 'v1',
    summary: 'Initial AI draft',
    createdAt: nowIso(),
    sourceCommit: analysis.gitContext.head,
    blocks,
    latex,
  };

  return {
    paper,
    currentVersion: version,
    versions: [version],
  };
}
