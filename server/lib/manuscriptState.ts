import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ManuscriptAsset,
  ManuscriptCitation,
  ManuscriptLabel,
  ManuscriptRegion,
  ManuscriptState,
  ManuscriptTodo,
  PaperVersion,
  VersionChangeSummary,
  VersionFocusTarget,
} from '../types.js';

export const CURRENT_MANUSCRIPT_STATE_SCHEMA_VERSION = 3;

const figureAssetExtensions = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg'];
const tableAssetExtensions = ['', '.tex', '.csv', '.tsv', '.json', '.yaml', '.yml'];

interface ManuscriptStateExtractionOptions {
  sourcePath?: string;
  projectRoot?: string;
  assetRoots?: string[];
}

interface AssetResolutionContext {
  sourceDir?: string;
  projectRoot?: string;
  assetRoots: string[];
  displayRoot?: string;
}

interface ResolvedAssetReference {
  displayPath: string;
  exists?: boolean;
  resolvable: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stripLatexComment(line: string): string {
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '%' && !escaped) {
      return line.slice(0, index);
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') {
      escaped = false;
    }
  }
  return line;
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => stripLatexComment(line))
    .join('\n');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function uniqueResolvedPaths(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value?.trim()) {
      continue;
    }
    const resolved = path.resolve(value);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    unique.push(resolved);
  }
  return unique;
}

function buildAssetResolutionContext(options?: ManuscriptStateExtractionOptions): AssetResolutionContext {
  const sourceDir = options?.sourcePath ? path.dirname(path.resolve(options.sourcePath)) : undefined;
  const projectRoot = options?.projectRoot ? path.resolve(options.projectRoot) : undefined;
  const assetRoots = uniqueResolvedPaths([sourceDir, ...(options?.assetRoots || []), projectRoot]);
  return {
    sourceDir,
    projectRoot,
    assetRoots,
    displayRoot: projectRoot || sourceDir || assetRoots[0],
  };
}

function compactSnippet(value: string, limit = 180): string {
  const normalized = normalizeWhitespace(stripLatexMarkup(value));
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

function extractCommandArgument(latex: string, command: string): string | undefined {
  const match = new RegExp(`\\\\${command}(?:\\*|\\s)*(?:\\[[^\\]]*\\])?\\s*\\{`, 'm').exec(latex);
  if (!match) {
    return undefined;
  }

  let index = match.index + match[0].length;
  let depth = 1;
  let output = '';
  while (index < latex.length) {
    const char = latex[index];
    if (char === '\\') {
      output += char;
      index += 1;
      if (index < latex.length) {
        output += latex[index];
      }
      index += 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
      output += char;
      index += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
      output += char;
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }

  return output.trim() || undefined;
}

function simplifyLatexInlineText(value: string): string {
  let normalized = stripComments(value);
  normalized = normalized.replace(/\\texorpdfstring\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1');
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const next = normalized.replace(/\\[A-Za-z@]+[*]?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1');
    if (next === normalized) {
      break;
    }
    normalized = next;
  }
  return normalized
    .replace(/\\[A-Za-z@]+[*]?(?:\[[^\]]*\])?/g, ' ')
    .replace(/\\./g, ' ')
    .replace(/[{}~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractDocumentTitle(latex: string): string | undefined {
  const rawTitle = extractCommandArgument(latex, 'title');
  if (!rawTitle) {
    return undefined;
  }
  const title = simplifyLatexInlineText(rawTitle);
  return title || undefined;
}

function stripLatexMarkup(value: string): string {
  return stripComments(value)
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\\[A-Za-z@]+[*]?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}&_~^]/g, ' ')
    .replace(/\\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(value: string): number {
  const tokens = stripLatexMarkup(value).match(/[A-Za-z0-9\u4e00-\u9fff]+/g);
  return tokens?.length || 0;
}

function classifyLabelKind(key: string): ManuscriptLabel['kind'] {
  const lower = key.toLowerCase();
  if (lower.startsWith('fig:')) {
    return 'figure';
  }
  if (lower.startsWith('tab:')) {
    return 'table';
  }
  if (lower.startsWith('sec:')) {
    return 'section';
  }
  if (lower.startsWith('eq:')) {
    return 'equation';
  }
  if (lower.startsWith('alg:')) {
    return 'algorithm';
  }
  return 'other';
}

function detectSectionHeader(line: string): { kind: ManuscriptRegion['kind']; title: string } | null {
  const match = line.match(/\\(section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^}]*)\}/);
  if (!match) {
    return null;
  }
  const kind =
    match[1] === 'section'
      ? 'section'
      : match[1] === 'subsection'
        ? 'subsection'
        : 'subsubsection';
  return {
    kind,
    title: compactSnippet(match[2] || 'Untitled section', 120) || 'Untitled section',
  };
}

function regionFromSpan(
  lines: string[],
  kind: ManuscriptRegion['kind'],
  title: string,
  lineStart: number,
  lineEnd: number,
  label?: string,
): ManuscriptRegion {
  const start = Math.max(1, lineStart);
  const end = Math.max(start, lineEnd);
  const text = lines.slice(start - 1, end).join('\n');
  return {
    kind,
    title,
    label,
    lineStart: start,
    lineEnd: end,
    wordCount: countWords(text),
    snippet: compactSnippet(text),
  };
}

function extractSectionMap(lines: string[]): ManuscriptRegion[] {
  const regions: ManuscriptRegion[] = [];
  const abstractStart = lines.findIndex((line) => /\\begin\{abstract\}/.test(line));
  if (abstractStart >= 0) {
    const abstractEndIndex = lines.findIndex((line, index) => index >= abstractStart && /\\end\{abstract\}/.test(line));
    regions.push(
      regionFromSpan(
        lines,
        'abstract',
        'Abstract',
        abstractStart + 1,
        abstractEndIndex >= 0 ? abstractEndIndex + 1 : lines.length,
      ),
    );
  }

  const headers = lines
    .map((line, index) => {
      const header = detectSectionHeader(line);
      return header ? { ...header, line: index + 1 } : null;
    })
    .filter((entry): entry is { kind: ManuscriptRegion['kind']; title: string; line: number } => Boolean(entry));

  for (let index = 0; index < headers.length; index += 1) {
    const current = headers[index];
    const next = headers[index + 1];
    regions.push(
      regionFromSpan(
        lines,
        current.kind,
        current.title,
        current.line,
        next ? next.line - 1 : lines.length,
      ),
    );
  }

  const bibliographyStart = lines.findIndex((line) => /\\bibliography\{|\\begin\{thebibliography\}/.test(line));
  if (bibliographyStart >= 0) {
    regions.push(regionFromSpan(lines, 'bibliography', 'Bibliography', bibliographyStart + 1, lines.length));
  }

  return regions.sort((left, right) => left.lineStart - right.lineStart);
}

function matchAllKeys(line: string, pattern: RegExp): string[] {
  const keys: string[] = [];
  for (const match of line.matchAll(pattern)) {
    const raw = typeof match[1] === 'string' ? match[1] : '';
    for (const key of raw.split(',').map((entry) => entry.trim()).filter(Boolean)) {
      keys.push(key);
    }
  }
  return keys;
}

function normalizeAssetReference(value: string): string {
  return value.replace(/\r/g, '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
}

function isExternalAssetReference(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value) || /^data:/i.test(value);
}

function isAbsoluteAssetReference(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function isResolvableLocalAssetReference(value: string): boolean {
  if (!value || isExternalAssetReference(value) || /[{}]/.test(value)) {
    return false;
  }
  if (isAbsoluteAssetReference(value)) {
    return true;
  }
  return !/\\[A-Za-z@]+/.test(value);
}

function assetCandidateReferences(rawRef: string, kind: ManuscriptAsset['kind']): string[] {
  if (!rawRef) {
    return [];
  }
  if (path.extname(rawRef)) {
    return [rawRef];
  }
  const extensions = kind === 'figure' ? figureAssetExtensions : tableAssetExtensions;
  return extensions.map((extension) => `${rawRef}${extension}`);
}

function displayAssetPath(assetPath: string, context: AssetResolutionContext): string {
  const normalized = assetPath.replace(/\\/g, '/');
  if (!context.displayRoot) {
    return normalized;
  }
  const relative = path.relative(context.displayRoot, assetPath);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return (relative || '.').replace(/\\/g, '/');
  }
  return normalized;
}

function resolveAssetReference(rawRef: string, kind: ManuscriptAsset['kind'], context: AssetResolutionContext): ResolvedAssetReference {
  const normalizedRef = normalizeAssetReference(rawRef);
  if (!normalizedRef) {
    return {
      displayPath: '',
      resolvable: false,
    };
  }
  if (isExternalAssetReference(normalizedRef) || !isResolvableLocalAssetReference(normalizedRef)) {
    return {
      displayPath: normalizedRef,
      resolvable: false,
    };
  }

  if (isAbsoluteAssetReference(normalizedRef)) {
    return {
      displayPath: displayAssetPath(normalizedRef, context),
      exists: existsSync(normalizedRef),
      resolvable: true,
    };
  }

  if (context.assetRoots.length === 0) {
    return {
      displayPath: normalizedRef,
      resolvable: false,
    };
  }

  for (const root of context.assetRoots) {
    for (const candidate of assetCandidateReferences(normalizedRef, kind)) {
      const resolved = path.resolve(root, candidate);
      if (existsSync(resolved)) {
        return {
          displayPath: displayAssetPath(resolved, context),
          exists: true,
          resolvable: true,
        };
      }
    }
  }

  return {
    displayPath: normalizedRef,
    exists: false,
    resolvable: true,
  };
}

function extractFigureAssetPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const raw = typeof match[1] === 'string' ? match[1] : '';
    if (raw.trim()) {
      paths.push(raw);
    }
  }
  return uniqueStrings(paths);
}

function extractTableAssetPaths(text: string): string[] {
  const paths: string[] = [];
  const patterns = [
    /\\input\{([^}]+)\}/g,
    /\\include\{([^}]+)\}/g,
    /\\csvautotabular\{([^}]+)\}/g,
    /\\pgfplotstabletypeset(?:\[[^\]]*\])?\{([^}]+)\}/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = typeof match[1] === 'string' ? match[1] : '';
      if (raw.trim()) {
        paths.push(raw);
      }
    }
  }
  return uniqueStrings(paths);
}

function extractLinkedAssetMetadata(text: string, kind: ManuscriptAsset['kind'], context: AssetResolutionContext): Pick<ManuscriptAsset, 'assetPath' | 'assetPaths' | 'missingAssetPaths' | 'assetExists'> {
  const rawRefs = kind === 'figure' ? extractFigureAssetPaths(text) : extractTableAssetPaths(text);
  const resolvedRefs = rawRefs
    .map((rawRef) => resolveAssetReference(rawRef, kind, context))
    .filter((entry) => entry.displayPath);
  const assetPaths = uniqueStrings(resolvedRefs.map((entry) => entry.displayPath));
  const missingAssetPaths = uniqueStrings(
    resolvedRefs.filter((entry) => entry.resolvable && entry.exists === false).map((entry) => entry.displayPath),
  );
  const resolvableRefs = resolvedRefs.filter((entry) => entry.resolvable);

  return {
    assetPath: assetPaths[0],
    assetPaths: assetPaths.length > 0 ? assetPaths : undefined,
    missingAssetPaths: missingAssetPaths.length > 0 ? missingAssetPaths : undefined,
    assetExists: resolvableRefs.length > 0 ? missingAssetPaths.length === 0 : undefined,
  };
}

function extractLabels(lines: string[]): ManuscriptLabel[] {
  const labels: ManuscriptLabel[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLatexComment(lines[index] || '');
    for (const match of line.matchAll(/\\label\{([^}]+)\}/g)) {
      const key = String(match[1] || '').trim();
      if (!key) {
        continue;
      }
      labels.push({
        key,
        kind: classifyLabelKind(key),
        line: index + 1,
      });
    }
  }
  return labels;
}

function extractCitations(lines: string[]): ManuscriptCitation[] {
  const counts = new Map<string, { count: number; firstLine: number }>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLatexComment(lines[index] || '');
    const keys = matchAllKeys(line, /\\cite[A-Za-z*]*\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]+)\}/g);
    for (const key of keys) {
      const entry = counts.get(key) || { count: 0, firstLine: index + 1 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.entries()]
    .map(([key, value]) => ({
      key,
      count: value.count,
      firstLine: value.firstLine,
    }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function extractReferenceCounts(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLatexComment(lines[index] || '');
    const keys = matchAllKeys(line, /\\[A-Za-z]*ref\{([^}]+)\}/g);
    for (const key of keys) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function extractAssetBlocks(
  lines: string[],
  kind: ManuscriptAsset['kind'],
  referenceCounts: Map<string, number>,
  context: AssetResolutionContext,
): ManuscriptAsset[] {
  const assets: ManuscriptAsset[] = [];
  const beginPattern = kind === 'figure' ? /\\begin\{figure\*?\}/ : /\\begin\{table\*?\}/;
  const endPattern = kind === 'figure' ? /\\end\{figure\*?\}/ : /\\end\{table\*?\}/;

  for (let index = 0; index < lines.length; index += 1) {
    if (!beginPattern.test(lines[index] || '')) {
      continue;
    }
    let end = index;
    while (end < lines.length && !endPattern.test(lines[end] || '')) {
      end += 1;
    }
    const text = lines.slice(index, Math.min(end + 1, lines.length)).join('\n');
    const labelMatch = text.match(/\\label\{([^}]+)\}/);
    const captionMatch = text.match(/\\caption(?:\[[^\]]*\])?\{([\s\S]*?)\}/);
    const label = labelMatch?.[1]?.trim();
    const linkedAssetMetadata = extractLinkedAssetMetadata(text, kind, context);
    assets.push({
      kind,
      label,
      caption: captionMatch?.[1] ? compactSnippet(captionMatch[1], 140) : undefined,
      line: index + 1,
      referenceCount: label ? referenceCounts.get(label) || 0 : 0,
      ...linkedAssetMetadata,
    });
    index = end;
  }

  return assets;
}

function classifyTodoKind(text: string): ManuscriptTodo['kind'] | null {
  const lower = text.toLowerCase();
  const hasTodoSignal = /(todo|fixme|xxx|\btbd\b|citation needed|add citation|missing citation|need citation)/i.test(text);
  if (!hasTodoSignal) {
    return null;
  }
  if (/(citation needed|add citation|missing citation|need citation)/i.test(text)) {
    return 'citation-gap';
  }
  if (/\btbd\b/i.test(text) && /(dataset|metric|result|experiment|baseline|ablation|figure|table|citation|proof|analysis)/i.test(text)) {
    return 'evidence-gap';
  }
  if (/(todo|fixme|xxx)/i.test(text) && /(dataset|metric|result|experiment|baseline|ablation|figure|table|citation|proof|analysis)/i.test(text)) {
    return 'evidence-gap';
  }
  if (/\btbd\b/i.test(text)) {
    return 'tbd';
  }
  return 'todo';
}

function findRegionTitleForLine(regions: ManuscriptRegion[], line: number): string | undefined {
  const hit = regions.find((region) => region.lineStart <= line && region.lineEnd >= line);
  return hit?.title;
}

function regionForLine(regions: ManuscriptRegion[], line?: number): ManuscriptRegion | undefined {
  if (!line || line < 1) {
    return undefined;
  }
  return regions.find((region) => region.lineStart <= line && region.lineEnd >= line);
}

function extractTodos(lines: string[], regions: ManuscriptRegion[]): ManuscriptTodo[] {
  const todos: ManuscriptTodo[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] || '';
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    const text = trimmed.replace(/^%\s*/, '');
    const kind = classifyTodoKind(text);
    if (!kind) {
      continue;
    }
    todos.push({
      kind,
      line: index + 1,
      text: compactSnippet(text, 180),
      regionTitle: findRegionTitleForLine(regions, index + 1),
    });
  }
  return todos;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function missingAssetTodos(assets: ManuscriptAsset[], regions: ManuscriptRegion[]): ManuscriptTodo[] {
  const seen = new Set<string>();
  const todos: ManuscriptTodo[] = [];
  for (const asset of assets) {
    const missingPaths = asset.missingAssetPaths || [];
    if (asset.assetExists !== false || missingPaths.length === 0) {
      continue;
    }
    const anchor = asset.label || asset.caption || `${asset.kind} line ${asset.line}`;
    const text = compactSnippet(`Missing ${asset.kind} asset for ${anchor}: ${missingPaths.join(', ')}`, 180);
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    todos.push({
      kind: 'missing-asset',
      line: asset.line,
      text,
      regionTitle: findRegionTitleForLine(regions, asset.line),
    });
  }
  return todos;
}

function regionKey(region: ManuscriptRegion): string {
  return region.label ? `${region.kind}:${region.label}` : `${region.kind}:${region.title.toLowerCase()}`;
}

function regionSignature(region: ManuscriptRegion): string {
  return [
    regionKey(region),
    region.wordCount,
    normalizeWhitespace(region.snippet),
  ].join('|');
}

function assetKey(asset: ManuscriptAsset): string {
  return asset.label ? `${asset.kind}:${asset.label}` : `${asset.kind}:${asset.caption || asset.line}`;
}

function assetSignature(asset: ManuscriptAsset): string {
  return [
    assetKey(asset),
    normalizeWhitespace(asset.caption || ''),
    asset.referenceCount,
    normalizeWhitespace(asset.assetPath || ''),
    normalizeWhitespace((asset.assetPaths || []).join(',')),
    normalizeWhitespace((asset.missingAssetPaths || []).join(',')),
    asset.assetExists === undefined ? 'unknown' : asset.assetExists ? 'present' : 'missing',
  ].join('|');
}

function stateSchemaReady(state?: ManuscriptState): boolean {
  return state?.schemaVersion === CURRENT_MANUSCRIPT_STATE_SCHEMA_VERSION;
}

function stateForVersion(version?: PaperVersion, options?: ManuscriptStateExtractionOptions): ManuscriptState | undefined {
  if (!version) {
    return undefined;
  }
  if (stateSchemaReady(version.manuscriptState)) {
    return version.manuscriptState;
  }
  return extractManuscriptState(version.latex, {
    ...options,
    sourcePath: version.sourcePath || options?.sourcePath,
  });
}

function deriveTouchedRegions(current: ManuscriptState, base?: ManuscriptState): string[] {
  if (!base) {
    return current.sectionMap.slice(0, 6).map((region) => region.title);
  }

  const touched: string[] = [];
  const baseRegions = new Map(base.sectionMap.map((region) => [regionKey(region), regionSignature(region)]));
  const currentRegions = new Map(current.sectionMap.map((region) => [regionKey(region), regionSignature(region)]));
  const currentRegionTitles = new Map(current.sectionMap.map((region) => [regionKey(region), region.title]));
  const baseRegionTitles = new Map(base.sectionMap.map((region) => [regionKey(region), region.title]));

  for (const key of new Set([...baseRegions.keys(), ...currentRegions.keys()])) {
    if (baseRegions.get(key) !== currentRegions.get(key)) {
      touched.push(currentRegionTitles.get(key) || baseRegionTitles.get(key) || key);
    }
  }

  const baseAssets = new Map([...base.figures, ...base.tables].map((asset) => [assetKey(asset), assetSignature(asset)]));
  const currentAssets = new Map([...current.figures, ...current.tables].map((asset) => [assetKey(asset), assetSignature(asset)]));
  for (const key of new Set([...baseAssets.keys(), ...currentAssets.keys()])) {
    if (baseAssets.get(key) !== currentAssets.get(key)) {
      touched.push(key.startsWith('figure:') ? `Figure ${key.slice('figure:'.length)}` : key.startsWith('table:') ? `Table ${key.slice('table:'.length)}` : key);
    }
  }

  return uniqueStrings(touched).slice(0, 8);
}

export function extractManuscriptState(latex: string, options?: ManuscriptStateExtractionOptions): ManuscriptState {
  const normalizedLatex = latex || '';
  const lines = normalizedLatex.replace(/\r/g, '').split('\n');
  const assetContext = buildAssetResolutionContext(options);
  const sectionMap = extractSectionMap(lines);
  const referenceCounts = extractReferenceCounts(lines);
  const labels = extractLabels(lines);
  const citations = extractCitations(lines);
  const figures = extractAssetBlocks(lines, 'figure', referenceCounts, assetContext);
  const tables = extractAssetBlocks(lines, 'table', referenceCounts, assetContext);
  const todos = [...extractTodos(lines, sectionMap), ...missingAssetTodos([...figures, ...tables], sectionMap)].sort(
    (left, right) => left.line - right.line || left.text.localeCompare(right.text),
  );
  const unresolvedEvidenceGaps = uniqueStrings(
    todos
      .filter((todo) => todo.kind === 'evidence-gap' || todo.kind === 'citation-gap' || todo.kind === 'tbd' || todo.kind === 'missing-asset')
      .map((todo) => todo.text),
  ).slice(0, 12);
  const missingAssetCount = [...figures, ...tables].reduce((count, asset) => count + (asset.missingAssetPaths?.length || 0), 0);

  return {
    schemaVersion: CURRENT_MANUSCRIPT_STATE_SCHEMA_VERSION,
    extractedAt: nowIso(),
    sectionMap,
    figures,
    tables,
    labels,
    citations,
    todos,
    unresolvedEvidenceGaps,
    stats: {
      wordCount: countWords(normalizedLatex),
      sectionCount: sectionMap.filter((region) => region.kind === 'section' || region.kind === 'subsection' || region.kind === 'subsubsection').length,
      figureCount: figures.length,
      tableCount: tables.length,
      citationCount: citations.length,
      todoCount: todos.length,
      missingAssetCount,
    },
  };
}

export function deriveVersionChangeSummary(
  version: PaperVersion,
  baseVersion?: PaperVersion,
  manuscriptState?: ManuscriptState,
  options?: ManuscriptStateExtractionOptions,
): VersionChangeSummary {
  const currentState =
    manuscriptState ||
    stateForVersion(version, options) ||
    extractManuscriptState(version.latex, {
      ...options,
      sourcePath: version.sourcePath || options?.sourcePath,
    });
  const baseState = stateForVersion(baseVersion, options);
  const currentTitle = extractDocumentTitle(version.latex);
  const baseTitle = baseVersion ? extractDocumentTitle(baseVersion.latex) : undefined;
  const titleChanged = Boolean(baseVersion && currentTitle && currentTitle !== baseTitle);
  const touchedRegions = uniqueStrings([
    ...(titleChanged ? ['Title'] : []),
    ...deriveTouchedRegions(currentState, baseState),
  ]).slice(0, 8);
  const currentTodoSet = new Set(currentState.todos.map((todo) => todo.text));
  const baseTodoSet = new Set(baseState?.todos.map((todo) => todo.text) || []);
  const addedTodos = [...currentTodoSet].filter((todo) => !baseTodoSet.has(todo)).slice(0, 6);
  const removedTodos = [...baseTodoSet].filter((todo) => !currentTodoSet.has(todo)).slice(0, 6);
  const summaryParts = [
    version.summary.trim() || undefined,
    titleChanged ? 'Title updated' : undefined,
    touchedRegions.length > 0 ? `Touched regions: ${touchedRegions.slice(0, 4).join(', ')}` : undefined,
    addedTodos.length > 0 ? `New open items: ${addedTodos.length}` : undefined,
    removedTodos.length > 0 ? `Resolved open items: ${removedTodos.length}` : undefined,
  ].filter((part): part is string => Boolean(part));

  return {
    summary: summaryParts.join(' | ') || (version.summary.trim() || 'Version update'),
    touchedRegions,
    addedTodos,
    removedTodos,
  };
}

function normalizeFocusText(value?: string): string | undefined {
  const normalized = normalizeWhitespace(stripLatexMarkup(value || ''));
  return normalized || undefined;
}

function deriveFocusTargetFromDiff(
  version: PaperVersion,
  baseVersion: PaperVersion | undefined,
  manuscriptState: ManuscriptState,
  baseState?: ManuscriptState,
): VersionFocusTarget | undefined {
  if (!baseVersion) {
    const firstRegion = manuscriptState.sectionMap[0];
    return firstRegion
      ? {
          sourceFile: version.sourcePath,
          sourceLine: firstRegion.lineStart,
          regionTitle: firstRegion.title,
        }
      : version.sourcePath
        ? { sourceFile: version.sourcePath, sourceLine: 1 }
        : undefined;
  }

  const previousLines = baseVersion.latex.replace(/\r/g, '').split('\n');
  const currentLines = version.latex.replace(/\r/g, '').split('\n');
  const maxLength = Math.max(previousLines.length, currentLines.length);
  for (let index = 0; index < maxLength; index += 1) {
    if ((previousLines[index] || '') === (currentLines[index] || '')) {
      continue;
    }
    const sourceLine = index + 1;
    const region = regionForLine(manuscriptState.sectionMap, sourceLine) || regionForLine(baseState?.sectionMap || [], sourceLine);
    const selectedText = normalizeFocusText(currentLines[index] || previousLines[index] || region?.snippet);
    return {
      sourceFile: version.sourcePath,
      sourceLine,
      selectedText,
      regionTitle: region?.title,
    };
  }

  const fallbackRegion = manuscriptState.sectionMap.find((region) => {
    return !(baseState?.sectionMap || []).some((candidate) => regionSignature(candidate) === regionSignature(region));
  }) || manuscriptState.sectionMap[0];
  if (!fallbackRegion) {
    return version.sourcePath ? { sourceFile: version.sourcePath, sourceLine: 1 } : undefined;
  }
  return {
    sourceFile: version.sourcePath,
    sourceLine: fallbackRegion.lineStart,
    selectedText: normalizeFocusText(fallbackRegion.snippet),
    regionTitle: fallbackRegion.title,
  };
}

export function deriveVersionFocusTarget(
  version: PaperVersion,
  baseVersion?: PaperVersion,
  manuscriptState?: ManuscriptState,
  options?: ManuscriptStateExtractionOptions,
): VersionFocusTarget | undefined {
  const currentState =
    manuscriptState ||
    stateForVersion(version, options) ||
    extractManuscriptState(version.latex, {
      ...options,
      sourcePath: version.sourcePath || options?.sourcePath,
    });
  const baseState = stateForVersion(baseVersion, options);
  const explicitLine = version.focusTarget?.sourceLine;
  const explicitRegion = regionForLine(currentState.sectionMap, explicitLine);
  const explicitSelectedText = normalizeFocusText(version.focusTarget?.selectedText);
  if (explicitLine || explicitSelectedText || version.focusTarget?.regionTitle) {
    return {
      sourceFile: version.focusTarget?.sourceFile || version.sourcePath,
      sourceLine: explicitLine || explicitRegion?.lineStart || 1,
      sourceColumn: version.focusTarget?.sourceColumn,
      selectedText: explicitSelectedText || normalizeFocusText(explicitRegion?.snippet),
      pageHint: version.focusTarget?.pageHint,
      regionTitle: version.focusTarget?.regionTitle || explicitRegion?.title,
    };
  }
  return deriveFocusTargetFromDiff(version, baseVersion, currentState, baseState);
}

export function enrichPaperVersion(
  version: PaperVersion,
  baseVersion?: PaperVersion,
  options?: ManuscriptStateExtractionOptions,
): PaperVersion {
  const manuscriptState = extractManuscriptState(version.latex, {
    ...options,
    sourcePath: version.sourcePath || options?.sourcePath,
  });
  return {
    ...version,
    focusTarget: deriveVersionFocusTarget(version, baseVersion, manuscriptState, options),
    manuscriptState,
    changeSummary: deriveVersionChangeSummary(version, baseVersion, manuscriptState, options),
  };
}
