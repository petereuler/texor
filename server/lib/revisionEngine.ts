import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { ManuscriptAsset, ManuscriptRegion, ManuscriptState, ManuscriptTodo, PaperBlock, PaperRecord, PaperVersion, RevisionRequest, RevisionResult, VersionFocusTarget, WorkspaceSnapshot } from '../types.js';
import { appendVersion } from './versionStore.js';
import { composeLatex } from './paperBuilder.js';
import { callOpenAICompatible } from './modelClient.js';

interface ModelResponse {
  mode: 'mock' | 'openai-compatible';
  content: string;
}

type RevisionRoute = 'quick-local' | 'structured-patch' | 'codex';

interface RevisionRegionPlan {
  primaryRegion?: ManuscriptRegion;
  relatedRegions: ManuscriptRegion[];
  relevantTodos: ManuscriptTodo[];
  relevantAssets: ManuscriptAsset[];
  scopeAdvice: string[];
}

function compactContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function compactWhitespace(content: string): string {
  return content.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
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

function lineNumberForOffset(content: string, offset: number): number {
  const safeOffset = Math.max(0, Math.min(content.length, offset));
  let line = 1;
  for (let index = 0; index < safeOffset; index += 1) {
    if (content[index] === '\n') {
      line += 1;
    }
  }
  return line;
}

function columnNumberForOffset(content: string, offset: number): number {
  const safeOffset = Math.max(0, Math.min(content.length, offset));
  const lineStart = content.lastIndexOf('\n', Math.max(0, safeOffset - 1));
  return Math.max(1, safeOffset - lineStart);
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

function focusTargetFromRequest(request: RevisionRequest, fallback?: Partial<VersionFocusTarget>): VersionFocusTarget | undefined {
  if (!request.sourceFile && !request.sourceLine && !request.selectedText && !fallback?.regionTitle && !fallback?.selectedText) {
    return fallback && Object.values(fallback).some(Boolean) ? { ...fallback } : undefined;
  }
  return {
    sourceFile: request.sourceFile || fallback?.sourceFile,
    sourceLine: request.sourceLine || fallback?.sourceLine,
    sourceColumn: request.sourceColumn || fallback?.sourceColumn,
    selectedText: normalizePdfSelectedText(request.selectedText) || fallback?.selectedText,
    pageHint: fallback?.pageHint,
    regionTitle: fallback?.regionTitle,
  };
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

function looksLikeFullBlockRewrite(original: string, replacement: string): boolean {
  const normalizedOriginal = compactWhitespace(original);
  const normalizedReplacement = compactWhitespace(replacement);
  if (!normalizedOriginal || !normalizedReplacement) {
    return false;
  }
  if (normalizedOriginal === normalizedReplacement) {
    return false;
  }
  return (
    normalizedReplacement.includes(normalizedOriginal.slice(0, Math.min(120, normalizedOriginal.length))) &&
    normalizedReplacement.length > normalizedOriginal.length * 1.8
  );
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

function locateSelectedTextInBlock(content: string, request: RevisionRequest): { start: number; end: number; text: string } | null {
  const selectedText = normalizePdfSelectedText(request.selectedText);
  const searchCandidates = [
    selectedText,
    request.sourceSnippet?.trim(),
  ].filter((entry): entry is string => Boolean(entry && entry.trim()));

  for (const candidate of searchCandidates) {
    const exactIndex = content.indexOf(candidate);
    if (exactIndex >= 0) {
      return {
        start: exactIndex,
        end: exactIndex + candidate.length,
        text: content.slice(exactIndex, exactIndex + candidate.length),
      };
    }
    const fuzzyRegex = buildFuzzyTextRegex(candidate);
    const match = fuzzyRegex ? content.match(fuzzyRegex) : null;
    if (match?.index !== undefined) {
      return {
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      };
    }
  }

  return null;
}

async function rewriteSelectedBlockSpan(original: string, request: RevisionRequest, block: PaperBlock): Promise<ModelResponse> {
  const response = await callOpenAICompatible(
    [
      {
        role: 'system',
        content:
          'You are revising one selected span inside a manuscript block. Return only the replacement text for that span. Preserve meaning, citations, LaTeX commands, math, labels, and surrounding structure. Do not return the full block. Do not explain.',
      },
      {
        role: 'user',
        content: [
          `Block type: ${block.type}`,
          'Selected block span:',
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
  return response || mockQuickRewrite(original, {
    ...request,
    changeRequest: request.changeRequest || request.issue,
  });
}

async function patchTextBlock(
  block: Extract<PaperBlock, { type: 'text' }>,
  request: RevisionRequest,
): Promise<{ nextBlock: Extract<PaperBlock, { type: 'text' }>; mode: ModelResponse['mode'] } | null> {
  const span = locateSelectedTextInBlock(block.content, request);
  if (!span) {
    return null;
  }
  const modelResponse = await rewriteSelectedBlockSpan(span.text, request, block);
  const replacement = validateReplacement(span.text, modelResponse.content);
  if (looksLikeFullBlockRewrite(span.text, replacement)) {
    throw new Error('Structured text revision returned an oversized replacement for the selected span.');
  }
  const revisedContent = `${block.content.slice(0, span.start)}${replacement}${block.content.slice(span.end)}`;
  return {
    nextBlock: {
      ...block,
      content: revisedContent,
    },
    mode: modelResponse.mode,
  };
}

function normalizeRevisionText(request: RevisionRequest): string {
  return `${request.issue}\n${request.changeRequest}\n${request.selectedText || ''}`.toLowerCase();
}

function regionTitleKey(region?: Pick<ManuscriptRegion, 'title'>): string {
  return compactContent(region?.title || '').toLowerCase();
}

function findRegionByLine(state: ManuscriptState | undefined, line?: number): ManuscriptRegion | undefined {
  if (!state || !line) {
    return undefined;
  }
  return state.sectionMap.find((region) => region.lineStart <= line && region.lineEnd >= line);
}

function findRegionByBlock(state: ManuscriptState | undefined, block: PaperBlock): ManuscriptRegion | undefined {
  if (!state) {
    return undefined;
  }
  const titleCandidates = [block.section, block.title]
    .map((entry) => compactContent(entry).toLowerCase())
    .filter(Boolean);
  return state.sectionMap.find((region) => {
    const title = compactContent(region.title).toLowerCase();
    return titleCandidates.some((candidate) => title === candidate || title.includes(candidate) || candidate.includes(title));
  });
}

function findRegionsMatchingTerms(state: ManuscriptState | undefined, terms: string[]): ManuscriptRegion[] {
  if (!state || terms.length === 0) {
    return [];
  }
  return state.sectionMap.filter((region) => {
    const title = compactContent(region.title).toLowerCase();
    return terms.some((term) => title.includes(term));
  });
}

function inferRequestRegionTerms(text: string): string[] {
  const regionTerms = new Set<string>();
  const mappings: Array<{ signals: string[]; terms: string[] }> = [
    { signals: ['abstract', '摘要'], terms: ['abstract'] },
    { signals: ['introduction', '引言', 'motivation', 'background'], terms: ['introduction', 'background'] },
    { signals: ['related work', '文献综述', 'references', 'citation', '参考文献', '引用'], terms: ['related work', 'reference', 'bibliography'] },
    { signals: ['method', 'approach', '方法', '模型', '架构'], terms: ['method', 'approach'] },
    { signals: ['experiment', '实验', 'setup', 'benchmark', 'dataset'], terms: ['experiment', 'setup'] },
    { signals: ['result', 'results', '结果', 'ablation', 'discussion', 'analysis'], terms: ['result', 'discussion', 'analysis'] },
    { signals: ['conclusion', '结论', 'future work'], terms: ['conclusion'] },
  ];
  for (const mapping of mappings) {
    if (mapping.signals.some((signal) => text.includes(signal))) {
      mapping.terms.forEach((term) => regionTerms.add(term));
    }
  }
  return [...regionTerms];
}

function dedupeRegions(regions: ManuscriptRegion[], primary?: ManuscriptRegion): ManuscriptRegion[] {
  const primaryKey = primary ? regionTitleKey(primary) : '';
  const seen = new Set<string>();
  const unique: ManuscriptRegion[] = [];
  for (const region of regions) {
    const key = regionTitleKey(region);
    if (!key || key === primaryKey || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(region);
  }
  return unique;
}

function inferRelatedRegions(
  state: ManuscriptState | undefined,
  block: PaperBlock,
  primaryRegion: ManuscriptRegion | undefined,
  requestText: string,
): ManuscriptRegion[] {
  if (!state) {
    return [];
  }
  const terms = new Set<string>();
  const primaryTitle = regionTitleKey(primaryRegion);
  if (primaryTitle.includes('abstract')) {
    ['introduction', 'conclusion', 'result'].forEach((term) => terms.add(term));
  }
  if (primaryTitle.includes('introduction')) {
    ['abstract', 'conclusion'].forEach((term) => terms.add(term));
  }
  if (primaryTitle.includes('method') || primaryTitle.includes('approach')) {
    ['abstract', 'experiment', 'result'].forEach((term) => terms.add(term));
  }
  if (primaryTitle.includes('experiment') || primaryTitle.includes('result') || primaryTitle.includes('discussion') || primaryTitle.includes('analysis')) {
    ['abstract', 'conclusion', 'method'].forEach((term) => terms.add(term));
  }
  if (primaryTitle.includes('conclusion')) {
    ['abstract', 'introduction', 'result'].forEach((term) => terms.add(term));
  }
  if (primaryTitle.includes('related work') || primaryTitle.includes('bibliography') || primaryTitle.includes('reference')) {
    ['introduction', 'bibliography'].forEach((term) => terms.add(term));
  }
  if (block.type === 'figure' || block.type === 'table') {
    ['result', 'experiment', 'method'].forEach((term) => terms.add(term));
  }
  if (/(全文|全篇|一致性|overall|consistency|across sections)/i.test(requestText)) {
    ['abstract', 'introduction', 'conclusion'].forEach((term) => terms.add(term));
  }
  return dedupeRegions(findRegionsMatchingTerms(state, [...terms]), primaryRegion).slice(0, 5);
}

function relevantTodosForPlan(state: ManuscriptState | undefined, primaryRegion: ManuscriptRegion | undefined, relatedRegions: ManuscriptRegion[]): ManuscriptTodo[] {
  if (!state) {
    return [];
  }
  const titles = new Set(
    [primaryRegion, ...relatedRegions]
      .map((region) => regionTitleKey(region))
      .filter(Boolean),
  );
  return state.todos
    .filter((todo) => {
      const todoTitle = compactContent(todo.regionTitle || '').toLowerCase();
      return titles.size === 0 ? todo.kind !== 'todo' : titles.has(todoTitle);
    })
    .slice(0, 4);
}

function assetMatchesRegion(asset: ManuscriptAsset, region?: ManuscriptRegion): boolean {
  return Boolean(
    region &&
      typeof asset.line === 'number' &&
      asset.line >= region.lineStart &&
      asset.line <= region.lineEnd,
  );
}

function formatAssetPlanLabel(asset: ManuscriptAsset): string {
  const label = asset.label || asset.kind;
  const targetPath = asset.assetPath || asset.assetPaths?.[0] || asset.missingAssetPaths?.[0] || '';
  return `${label}${targetPath ? ` -> ${targetPath}` : ''}${asset.assetExists === false ? ' (missing)' : ''}`;
}

function relevantAssetsForPlan(
  state: ManuscriptState | undefined,
  primaryRegion: ManuscriptRegion | undefined,
  relatedRegions: ManuscriptRegion[],
  block: PaperBlock,
): ManuscriptAsset[] {
  if (!state) {
    return [];
  }
  const assets = [...state.figures, ...state.tables];
  return [...assets]
    .filter((asset) => {
      if (assetMatchesRegion(asset, primaryRegion) || relatedRegions.some((region) => assetMatchesRegion(asset, region))) {
        return true;
      }
      if (block.type === 'figure' && asset.kind === 'figure') {
        return asset.assetExists === false;
      }
      if (block.type === 'table' && asset.kind === 'table') {
        return asset.assetExists === false;
      }
      return false;
    })
    .sort((left, right) => Number(right.assetExists === false) - Number(left.assetExists === false) || left.line - right.line)
    .slice(0, 4);
}

function scopeAdviceForPlan(
  block: PaperBlock,
  primaryRegion: ManuscriptRegion | undefined,
  relatedRegions: ManuscriptRegion[],
  todos: ManuscriptTodo[],
  assets: ManuscriptAsset[],
): string[] {
  const advice = [
    primaryRegion
      ? `Edit the primary manuscript region first: ${primaryRegion.title} (lines ${primaryRegion.lineStart}-${primaryRegion.lineEnd}).`
      : 'No primary manuscript region was resolved, so keep the change narrowly scoped to the provided block.',
  ];
  if (relatedRegions.length > 0) {
    advice.push(`If terminology, claims, or numbers shift, only mirror the minimum consistency edits in: ${relatedRegions.map((region) => region.title).join(', ')}.`);
  }
  if (block.type === 'figure' || block.type === 'table') {
    advice.push('When revising a figure/table block, keep caption language aligned with any in-text references and surrounding result discussion.');
  }
  if (assets.length > 0) {
    advice.push(`Preserve alignment with linked manuscript assets: ${assets.map((asset) => formatAssetPlanLabel(asset)).join('; ')}.`);
  }
  if (todos.length > 0) {
    advice.push('Do not erase listed open evidence gaps unless the revision truly resolves them with grounded content.');
  }
  return advice;
}

function buildRevisionRegionPlan(snapshot: WorkspaceSnapshot, targetVersion: PaperVersion, block: PaperBlock, request: RevisionRequest): RevisionRegionPlan {
  const state = targetVersion.manuscriptState || snapshot.currentVersion.manuscriptState;
  const requestText = normalizeRevisionText(request);
  const primaryRegion =
    findRegionByLine(state, request.sourceLine) ||
    findRegionByBlock(state, block) ||
    findRegionsMatchingTerms(state, inferRequestRegionTerms(requestText))[0];
  const relatedRegions = inferRelatedRegions(state, block, primaryRegion, requestText);
  const relevantTodos = relevantTodosForPlan(state, primaryRegion, relatedRegions);
  const relevantAssets = relevantAssetsForPlan(state, primaryRegion, relatedRegions, block);
  return {
    primaryRegion,
    relatedRegions,
    relevantTodos,
    relevantAssets,
    scopeAdvice: scopeAdviceForPlan(block, primaryRegion, relatedRegions, relevantTodos, relevantAssets),
  };
}

function formatRevisionRegionPlan(plan: RevisionRegionPlan): string {
  return [
    plan.primaryRegion
      ? `Primary region: ${plan.primaryRegion.title} (lines ${plan.primaryRegion.lineStart}-${plan.primaryRegion.lineEnd})`
      : 'Primary region: unresolved from manuscript state; stay scoped to the target block.',
    plan.relatedRegions.length > 0
      ? `Related consistency regions: ${plan.relatedRegions.map((region) => `${region.title} [${region.lineStart}-${region.lineEnd}]`).join('; ')}`
      : 'Related consistency regions: none strongly indicated.',
    plan.relevantTodos.length > 0
      ? `Open items near these regions: ${plan.relevantTodos.map((todo) => `${todo.kind} @ line ${todo.line}: ${todo.text}`).join(' ; ')}`
      : 'Open items near these regions: none currently flagged.',
    plan.relevantAssets.length > 0
      ? `Linked assets in scope: ${plan.relevantAssets.map((asset) => formatAssetPlanLabel(asset)).join('; ')}`
      : 'Linked assets in scope: none strongly indicated.',
    `Scope guidance: ${plan.scopeAdvice.join(' ')}`,
  ].join('\n');
}

function buildPrompt(snapshot: WorkspaceSnapshot, targetVersion: PaperVersion, block: PaperBlock, request: RevisionRequest): string {
  const targetContext =
    block.type === 'text'
      ? block.content
      : block.type === 'figure'
        ? `${block.title}\n${block.caption}\n${block.insight}`
        : `${block.title}\n${block.caption}\n${block.headers.join(' | ')}\n${block.rows.map((row) => row.join(' | ')).join('\n')}`;
  const plan = buildRevisionRegionPlan(snapshot, targetVersion, block, request);

  return [
    `Block type: ${block.type}`,
    `Selected text: ${request.selectedText || 'N/A'}`,
    `Issue: ${request.issue}`,
    `Requested change: ${request.changeRequest}`,
    'Revision region plan:',
    formatRevisionRegionPlan(plan),
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

function validateTextBlockRewrite(original: string, revised: string): string {
  const trimmed = revised.trim();
  if (!trimmed) {
    throw new Error('Structured revision produced an empty text block.');
  }
  if (isFullLatexDocument(trimmed)) {
    throw new Error('Structured revision returned a full document instead of a block update.');
  }
  const originalLength = compactWhitespace(original).length;
  const revisedLength = compactWhitespace(trimmed).length;
  if (originalLength > 180 && revisedLength > originalLength * 2.6) {
    throw new Error('Structured revision expanded too much for a single manuscript block.');
  }
  return trimmed;
}

function applyStructuredRevision(block: PaperBlock, modelResponse: ModelResponse): PaperBlock {
  if (block.type === 'text') {
    return {
      ...block,
      content: validateTextBlockRewrite(block.content, modelResponse.content),
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
  const selectedSpan = locateSelectedLatexSpan(targetVersion.latex, request);
  const requestFocusTarget = focusTargetFromRequest(request, selectedSpan
    ? {
        sourceFile: request.sourceFile || targetVersion.sourcePath,
        sourceLine: request.sourceLine || lineNumberForOffset(targetVersion.latex, selectedSpan.start),
        sourceColumn: request.sourceColumn || columnNumberForOffset(targetVersion.latex, selectedSpan.start),
        selectedText: selectedSpan.text,
      }
    : undefined);

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
        focusTarget: requestFocusTarget,
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
        diffSummary: nextSnapshot.currentVersion.changeSummary?.summary || `Quick local revision based on ${targetVersion.label}.`,
        mode: quickRevision.mode,
        route: 'quick-local',
      };
    }
  }

  const targetBlock = targetVersion.blocks.find((block) => block.id === request.targetBlockId);
  if (!targetBlock) {
    throw new Error('Target block not found.');
  }

  if (targetBlock.type === 'text' && looksLikeSimpleWordingRequest(request)) {
    const patched = await patchTextBlock(targetBlock, request);
    if (patched) {
      const revisedBlocks = targetVersion.blocks.map((block) =>
        block.id === targetBlock.id ? patched.nextBlock : block,
      );
      const nextVersion: PaperVersion = {
        id: crypto.randomUUID(),
        paperId: snapshot.paper.id,
        label: `v${snapshot.versions.length + 1}`,
        summary: `Structured patch revision: ${request.changeRequest || request.issue}`,
        createdAt: new Date().toISOString(),
        basedOnVersionId: targetVersion.id,
        sourceCommit: snapshot.paper.analysis?.gitContext.head,
        focusTarget: requestFocusTarget,
        blocks: revisedBlocks,
        latex: await composeLatex(snapshot.paper, revisedBlocks),
      };
      const nextSnapshot = await appendVersion(snapshot.paper as PaperRecord, nextVersion);
      return {
        snapshot: nextSnapshot,
        diffSummary: nextSnapshot.currentVersion.changeSummary?.summary || `Structured local patch on ${targetBlock.title}.`,
        mode: patched.mode,
        route: 'structured-patch',
      };
    }
  }

  const prompt = buildPrompt(snapshot, targetVersion, targetBlock, request);
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
    focusTarget: requestFocusTarget,
    blocks: revisedBlocks,
    latex: await composeLatex(snapshot.paper, revisedBlocks),
  };

  const nextSnapshot = await appendVersion(snapshot.paper as PaperRecord, nextVersion);
  return {
    snapshot: nextSnapshot,
    diffSummary: nextSnapshot.currentVersion.changeSummary?.summary || `Applied revision on ${targetBlock.title}: ${request.changeRequest}`,
    mode: modelResponse.mode,
    route: 'codex',
  };
}
