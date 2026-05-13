import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { PaperBlock, PaperRecord, PaperVersion, RevisionRequest, RevisionResult, WorkspaceSnapshot } from '../types.js';
import { appendVersion } from './versionStore.js';
import { composeLatex } from './paperBuilder.js';
import { callOpenAICompatible } from './modelClient.js';

interface ModelResponse {
  mode: 'mock' | 'openai-compatible';
  content: string;
}

function compactContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function isFullLatexDocument(latex: string): boolean {
  return /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(latex) && /\\begin\{document\}/.test(latex) && /\\end\{document\}/.test(latex);
}

function normalizePdfSelectedText(text?: string): string {
  if (!text) {
    return '';
  }
  return text
    .split('\n')
    .find((line) => line.startsWith('已选文字:'))
    ?.replace(/^已选文字:\s*/, '')
    .trim() || text.replace(/\s+/g, ' ').trim();
}

function normalizeTextForSearch(text: string): string {
  return text
    .replace(/[{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFuzzyTextRegex(selectedText: string): RegExp | null {
  const words = selectedText.match(/[A-Za-z0-9%+./-]+|[\u4e00-\u9fff]+/g);
  if (!words || words.length < 3) {
    return null;
  }
  const relevantWords = words.slice(0, 48).map(escapeRegex);
  return new RegExp(relevantWords.join('[\\s~\\\\{}\\[\\](),.;:!?\\-]*'), 'i');
}

function lineWindow(content: string, line?: number, radius = 4): { start: number; end: number; text: string } | null {
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

function locateSelectedLatexSpan(latex: string, request: RevisionRequest): { start: number; end: number; text: string; confidence: 'text' | 'line' } | null {
  const selectedText = normalizePdfSelectedText(request.selectedText);
  const window = lineWindow(latex, request.sourceLine);
  const searchAreas = [
    window ? { offset: window.start, text: window.text } : null,
    { offset: 0, text: latex },
  ].filter((area): area is { offset: number; text: string } => Boolean(area));

  if (selectedText) {
    for (const area of searchAreas) {
      const exactIndex = area.text.indexOf(selectedText);
      if (exactIndex >= 0) {
        return {
          start: area.offset + exactIndex,
          end: area.offset + exactIndex + selectedText.length,
          text: area.text.slice(exactIndex, exactIndex + selectedText.length),
          confidence: 'text',
        };
      }
    }

    const fuzzyRegex = buildFuzzyTextRegex(selectedText);
    if (fuzzyRegex) {
      for (const area of searchAreas) {
        const match = area.text.match(fuzzyRegex);
        if (match?.index !== undefined) {
          return {
            start: area.offset + match.index,
            end: area.offset + match.index + match[0].length,
            text: match[0],
            confidence: 'text',
          };
        }
      }
    }

    const selectedNorm = normalizeTextForSearch(selectedText);
    if (selectedNorm.length > 24 && window) {
      const sentences = window.text.match(/[^.!?。！？\n]+[.!?。！？]?/g) || [];
      let offset = window.start;
      for (const sentence of sentences) {
        const sentenceIndex = latex.indexOf(sentence, offset);
        if (sentenceIndex >= 0) {
          offset = sentenceIndex + sentence.length;
          const sentenceNorm = normalizeTextForSearch(sentence);
          if (sentenceNorm.includes(selectedNorm.slice(0, Math.min(42, selectedNorm.length)))) {
            return {
              start: sentenceIndex,
              end: sentenceIndex + sentence.length,
              text: sentence,
              confidence: 'text',
            };
          }
        }
      }
    }
  }

  if (window) {
    const lines = window.text
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.trim() && !entry.line.trim().startsWith('\\'));
    const candidate = lines[Math.floor(lines.length / 2)] || lines[0];
    if (candidate) {
      const start = window.start + window.text.split('\n').slice(0, candidate.index).join('\n').length + (candidate.index > 0 ? 1 : 0);
      return {
        start,
        end: start + candidate.line.length,
        text: candidate.line,
        confidence: 'line',
      };
    }
  }

  return null;
}

function looksLikeSimpleWordingRequest(request: RevisionRequest): boolean {
  const text = `${request.issue}\n${request.changeRequest}`.toLowerCase();
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

function mockQuickRewrite(original: string, request: RevisionRequest): ModelResponse {
  const cleaned = original.replace(/\s+/g, ' ').trim();
  return {
    mode: 'mock',
    content: cleaned,
  };
}

async function rewriteSelectedSpan(original: string, request: RevisionRequest): Promise<ModelResponse> {
  const response = await callOpenAICompatible(
    [
      {
        role: 'system',
        content:
          'You are revising one selected span in a LaTeX manuscript. Return only the replacement text for that span. Preserve meaning, citations, LaTeX commands, math, labels, and factual claims. Do not add explanations. Do not rewrite surrounding content.',
      },
      {
        role: 'user',
        content: [
          'Selected LaTeX/text span:',
          original,
          '',
          'User revision request:',
          request.changeRequest || request.issue,
        ].join('\n'),
      },
    ],
    request.modelConfig,
    0.2,
  );
  return response || mockQuickRewrite(original, request);
}

function validateReplacement(original: string, replacement: string): string {
  const trimmed = replacement
    .replace(/^```(?:latex|tex|text)?/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!trimmed) {
    throw new Error('Quick revision produced an empty replacement.');
  }
  if (isFullLatexDocument(trimmed)) {
    throw new Error('Quick revision returned a full document instead of a local replacement.');
  }
  const maxLength = Math.max(280, original.length * 2.8);
  if (trimmed.length > maxLength) {
    throw new Error('Quick revision expanded too much for a local wording change.');
  }
  return trimmed;
}

async function quickReviseFullLatex(targetVersion: PaperVersion, request: RevisionRequest): Promise<{ latex: string; mode: ModelResponse['mode'] } | null> {
  const sourcePath = request.sourceFile || targetVersion.sourcePath;
  const latexForSearch = sourcePath ? await fs.readFile(sourcePath, 'utf8').catch(() => targetVersion.latex) : targetVersion.latex;
  const span = locateSelectedLatexSpan(latexForSearch, request);
  if (!span) {
    return null;
  }
  const modelResponse = await rewriteSelectedSpan(span.text, request);
  const replacement = validateReplacement(span.text, modelResponse.content);
  const revisedLatex = `${latexForSearch.slice(0, span.start)}${replacement}${latexForSearch.slice(span.end)}`;
  if (sourcePath) {
    await fs.writeFile(sourcePath, revisedLatex, 'utf8').catch(() => undefined);
  }
  return { latex: revisedLatex, mode: modelResponse.mode };
}

function buildPrompt(block: PaperBlock, request: RevisionRequest): string {
  const targetContext =
    block.type === 'text'
      ? block.content
      : block.type === 'figure'
        ? `${block.title}\n${block.caption}\n${block.insight}`
        : `${block.title}\n${block.caption}\n${block.headers.join(' | ')}\n${block.rows.map((row) => row.join(' | ')).join('\n')}`;

  return [
    `Block type: ${block.type}`,
    `Selected text: ${request.selectedText || 'N/A'}`,
    `Issue: ${request.issue}`,
    `Requested change: ${request.changeRequest}`,
    'Current block content:',
    targetContext,
  ].join('\n');
}

function mockReviseBlock(block: PaperBlock, request: RevisionRequest): ModelResponse {
  const revisionSentence =
    'The revised passage now states the contribution more directly, connects it to the available evidence, and narrows the claim so it reads like a reviewable manuscript paragraph.';
  if (block.type === 'text') {
    const selected = request.selectedText ? `The selected span is integrated more carefully into the surrounding argument. ` : '';
    return {
      mode: 'mock',
      content: compactContent(`${block.content} ${selected}${revisionSentence}`),
    };
  }

  if (block.type === 'figure') {
    return {
      mode: 'mock',
      content: JSON.stringify({
        caption: compactContent(`${block.caption} The caption now highlights the visual evidence that supports the main claim.`),
        insight: compactContent(`${block.insight} The interpretation has been tightened to address the user's feedback.`),
      }),
    };
  }

  const revisedRows = [...block.rows];
  revisedRows.push(['Revision focus', 'Contribution clarity', 'Evidence linkage']);
  return {
    mode: 'mock',
    content: JSON.stringify({
      caption: compactContent(`${block.caption} The table has been revised to make the comparison easier to evaluate.`),
      rows: revisedRows,
      note: compactContent(`${block.note || ''} The note now records the intended revision without inserting the raw feedback into the manuscript.`),
    }),
  };
}

function applyStructuredRevision(block: PaperBlock, modelResponse: ModelResponse): PaperBlock {
  if (block.type === 'text') {
    return {
      ...block,
      content: modelResponse.content,
    };
  }

  try {
    const parsed = JSON.parse(modelResponse.content) as Record<string, unknown>;
    if (block.type === 'figure') {
      return {
        ...block,
        caption: String(parsed.caption || block.caption),
        insight: String(parsed.insight || block.insight),
      };
    }

    return {
      ...block,
      caption: String(parsed.caption || block.caption),
      rows: Array.isArray(parsed.rows) ? (parsed.rows as string[][]) : block.rows,
      note: String(parsed.note || block.note || ''),
    };
  } catch {
    if (block.type === 'figure') {
      return {
        ...block,
        caption: compactContent(`${block.caption} ${modelResponse.content}`),
      };
    }

    if (block.type === 'table') {
      return {
        ...block,
        note: compactContent(`${block.note || ''} ${modelResponse.content}`),
      };
    }

    return block;
  }
}

export async function reviseWorkspace(
  snapshot: WorkspaceSnapshot,
  request: RevisionRequest,
): Promise<RevisionResult> {
  const targetVersion = snapshot.versions.find((version) => version.id === request.versionId) || snapshot.currentVersion;

  if (isFullLatexDocument(targetVersion.latex) && looksLikeSimpleWordingRequest(request)) {
    const quickRevision = await quickReviseFullLatex(targetVersion, request);
    if (quickRevision) {
      const nextVersion: PaperVersion = {
        id: crypto.randomUUID(),
        paperId: snapshot.paper.id,
        label: `v${snapshot.versions.length + 1}`,
        summary: `Quick wording revision: ${request.changeRequest || request.issue}`,
        createdAt: new Date().toISOString(),
        basedOnVersionId: targetVersion.id,
        sourceCommit: snapshot.paper.analysis?.gitContext.head,
        sourcePath: request.sourceFile || targetVersion.sourcePath,
        blocks: [
          {
            id: crypto.randomUUID(),
            type: 'text',
            section: 'Manuscript',
            title: 'LaTeX Manuscript',
            content: quickRevision.latex,
          },
        ],
        latex: quickRevision.latex,
      };
      const nextSnapshot = await appendVersion(snapshot.paper as PaperRecord, nextVersion);
      return {
        snapshot: nextSnapshot,
        diffSummary: `Quick local revision based on ${targetVersion.label}.`,
        mode: quickRevision.mode,
        route: 'quick-local',
      };
    }
  }

  const targetBlock = targetVersion.blocks.find((block) => block.id === request.targetBlockId);
  if (!targetBlock) {
    throw new Error('Target block not found.');
  }

  const prompt = buildPrompt(targetBlock, request);
  let modelResponse: ModelResponse | null = await callOpenAICompatible(
    [
      {
        role: 'system',
        content:
          'You revise one manuscript block for academic writing. Return only the revised content. For figure/table blocks, return JSON with the fields present in the prompt.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    request.modelConfig,
  );
  if (!modelResponse) {
    modelResponse = mockReviseBlock(targetBlock, request);
  }

  const revisedBlocks = targetVersion.blocks.map((block) =>
    block.id === targetBlock.id ? applyStructuredRevision(block, modelResponse) : block,
  );

  const nextVersion: PaperVersion = {
    id: crypto.randomUUID(),
    paperId: snapshot.paper.id,
    label: `v${snapshot.versions.length + 1}`,
    summary: `${request.issue} -> ${request.changeRequest}`,
    createdAt: new Date().toISOString(),
    basedOnVersionId: targetVersion.id,
    sourceCommit: snapshot.paper.analysis?.gitContext.head,
    blocks: revisedBlocks,
    latex: await composeLatex(snapshot.paper, revisedBlocks),
  };

  const nextSnapshot = await appendVersion(snapshot.paper as PaperRecord, nextVersion);
  return {
    snapshot: nextSnapshot,
    diffSummary: `Applied revision on ${targetBlock.title}: ${request.changeRequest}`,
    mode: modelResponse.mode,
    route: 'quick-local',
  };
}
