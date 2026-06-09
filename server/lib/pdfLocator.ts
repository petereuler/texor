import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PdfSelectionLocateRequest, PdfSelectionLocateResult, SourceLineLocateRequest, SourceLineLocateResult } from '../types.js';
import { resolveBuildUrlPath } from './buildPaths.js';

function buildRootForPdf(pdfPath: string, buildRoot: string): string {
  const relative = path.relative(buildRoot, pdfPath);
  const [buildId] = relative.split(path.sep);
  return path.join(buildRoot, buildId || '');
}

function projectRootForSource(sourcePath: string): string {
  const parts = path.resolve(sourcePath).split(path.sep);
  const texorIndex = parts.lastIndexOf('.texor');
  if (texorIndex > 0) {
    return parts.slice(0, texorIndex).join(path.sep) || path.sep;
  }
  return path.dirname(sourcePath);
}

function mapBuildSourceToProjectSource(
  buildSource: string,
  pdfPath: string,
  buildRoot: string,
  request: PdfSelectionLocateRequest,
): string {
  const buildOutputRoot = buildRootForPdf(pdfPath, buildRoot);
  const relativeSource = path.relative(buildOutputRoot, buildSource);
  if (relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
    return buildSource;
  }

  if (request.sourcePath) {
    const sourcePath = path.resolve(request.sourcePath);
    const sourceRoot = projectRootForSource(sourcePath);
    const sourceRelative = path.relative(sourceRoot, sourcePath);
    if (sourceRelative === relativeSource || path.basename(sourcePath) === path.basename(relativeSource)) {
      return sourcePath;
    }
    return path.join(sourceRoot, relativeSource);
  }

  if (request.projectRoot) {
    return path.join(path.resolve(request.projectRoot), relativeSource);
  }

  return buildSource;
}

function parseSynctexOutput(output: string): { sourceFile?: string; line?: number; column?: number } {
  const result: { sourceFile?: string; line?: number; column?: number } = {};
  for (const line of output.split(/\r?\n/)) {
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (key === 'Input' && !result.sourceFile) {
      result.sourceFile = value;
    }
    if (key === 'Line' && !result.line) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        result.line = parsed;
      }
    }
    if (key === 'Column' && result.column === undefined) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        result.column = parsed;
      }
    }
  }
  return result;
}

function parseSynctexViewOutput(output: string): Array<{ page: number; x: number; y: number; width: number; height: number }> {
  const results: Array<{ page: number; x: number; y: number; width: number; height: number }> = [];
  let current: Partial<{ page: number; x: number; y: number; width: number; height: number }> | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line === 'SyncTeX result begin') {
      current = null;
      continue;
    }
    if (line === 'SyncTeX result end') {
      if (
        current &&
        Number.isFinite(current.page) &&
        Number.isFinite(current.x) &&
        Number.isFinite(current.y)
      ) {
        results.push({
          page: Number(current.page),
          x: Number(current.x),
          y: Number(current.y),
          width: Number.isFinite(current.width) ? Number(current.width) : 0,
          height: Number.isFinite(current.height) ? Number(current.height) : 0,
        });
      }
      current = null;
      continue;
    }
    if (line.startsWith('Output:')) {
      if (
        current &&
        Number.isFinite(current.page) &&
        Number.isFinite(current.x) &&
        Number.isFinite(current.y)
      ) {
        results.push({
          page: Number(current.page),
          x: Number(current.x),
          y: Number(current.y),
          width: Number.isFinite(current.width) ? Number(current.width) : 0,
          height: Number.isFinite(current.height) ? Number(current.height) : 0,
        });
      }
      current = {};
      continue;
    }
    if (!current) {
      continue;
    }
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    const numeric = Number(value);
    if (key === 'Page' && Number.isFinite(numeric)) {
      current.page = numeric;
    } else if (key === 'x' && Number.isFinite(numeric)) {
      current.x = numeric;
    } else if (key === 'y' && Number.isFinite(numeric)) {
      current.y = numeric;
    } else if (key === 'W' && Number.isFinite(numeric)) {
      current.width = numeric;
    } else if (key === 'H' && Number.isFinite(numeric)) {
      current.height = numeric;
    }
  }

  if (
    current &&
    Number.isFinite(current.page) &&
    Number.isFinite(current.x) &&
    Number.isFinite(current.y)
  ) {
    results.push({
      page: Number(current.page),
      x: Number(current.x),
      y: Number(current.y),
      width: Number.isFinite(current.width) ? Number(current.width) : 0,
      height: Number.isFinite(current.height) ? Number(current.height) : 0,
    });
  }

  return results;
}

async function sourceSnippet(sourceFile: string, line = 1, radius = 10): Promise<string> {
  const raw = await fs.readFile(sourceFile, 'utf8').catch(() => '');
  if (!raw) {
    return '';
  }
  const lines = raw.split(/\r?\n/);
  const start = Math.max(0, line - radius - 1);
  const end = Math.min(lines.length, line + radius);
  return lines
    .slice(start, end)
    .map((content, index) => `${start + index + 1}: ${content}`)
    .join('\n');
}

async function readBuildInputSources(pdfPath: string): Promise<string[]> {
  const buildDir = path.dirname(pdfPath);
  const pdfBase = path.basename(pdfPath, path.extname(pdfPath));
  const synctexPath = path.join(buildDir, `${pdfBase}.synctex.gz`);
  const compressed = await fs.readFile(synctexPath).catch(() => null);
  if (!compressed) {
    return [];
  }
  const decompressed = await import('node:zlib').then(({ gunzipSync }) => gunzipSync(compressed).toString('utf8'));
  return decompressed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Input:'))
    .map((line) => line.replace(/^Input:\d+:/, '').trim())
    .filter(Boolean);
}

function unwrapSingleArgCommand(source: string, command: string): string {
  let output = '';
  let index = 0;
  const prefix = `\\${command}{`;
  while (index < source.length) {
    const commandIndex = source.indexOf(prefix, index);
    if (commandIndex < 0) {
      output += source.slice(index);
      break;
    }

    output += source.slice(index, commandIndex);
    let cursor = commandIndex + prefix.length;
    let depth = 1;
    while (cursor < source.length && depth > 0) {
      const character = source[cursor];
      if (character === '{' && source[cursor - 1] !== '\\') {
        depth += 1;
      } else if (character === '}' && source[cursor - 1] !== '\\') {
        depth -= 1;
      }
      cursor += 1;
    }

    const innerEnd = depth === 0 ? cursor - 1 : cursor;
    output += source.slice(commandIndex + prefix.length, innerEnd);
    index = cursor;
  }
  return output;
}

function normalizeLatexLine(line: string): string {
  return unwrapSingleArgCommand(unwrapSingleArgCommand(line, 'texoradd'), 'texordel')
    .replace(/%.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(line: string): Set<string> {
  return new Set(line.toLowerCase().match(/[a-z0-9_\\]+/g) || []);
}

function similarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
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

async function mapLineToProjectLine(buildSource: string, buildLine: number, projectSource: string): Promise<number> {
  if (path.resolve(buildSource) === path.resolve(projectSource)) {
    return buildLine;
  }

  const [buildRaw, projectRaw] = await Promise.all([
    fs.readFile(buildSource, 'utf8').catch(() => ''),
    fs.readFile(projectSource, 'utf8').catch(() => ''),
  ]);
  if (!buildRaw || !projectRaw) {
    return buildLine;
  }

  const buildLines = buildRaw.split(/\r?\n/);
  const projectLines = projectRaw.split(/\r?\n/);
  const target = normalizeLatexLine(buildLines[buildLine - 1] || '');
  if (!target) {
    return buildLine;
  }

  const exactMatches = projectLines
    .map((line, index) => ({ line: index + 1, normalized: normalizeLatexLine(line) }))
    .filter((entry) => entry.normalized === target);
  if (exactMatches.length) {
    return exactMatches.sort((left, right) => Math.abs(left.line - buildLine) - Math.abs(right.line - buildLine))[0].line;
  }

  let bestLine = buildLine;
  let bestScore = 0;
  for (let index = 0; index < projectLines.length; index += 1) {
    const score = similarity(target, normalizeLatexLine(projectLines[index]));
    if (score > bestScore) {
      bestScore = score;
      bestLine = index + 1;
    }
  }

  return bestScore >= 0.35 ? bestLine : buildLine;
}

function runSynctexEdit(pdfPath: string, page: number, x: number, y: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdfPath}`], {
      cwd: path.dirname(pdfPath),
    });
    const chunks: string[] = [];
    child.stdout.on('data', (data) => chunks.push(data.toString()));
    child.stderr.on('data', (data) => chunks.push(data.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      const output = chunks.join('');
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(output || `synctex exited with code ${code}`));
    });
  });
}

async function buildSourcePathForView(pdfPath: string, buildRoot: string, request: SourceLineLocateRequest): Promise<string> {
  const buildOutputRoot = buildRootForPdf(pdfPath, buildRoot);
  const buildInputs = await readBuildInputSources(pdfPath);
  if (request.sourcePath) {
    const sourcePath = path.resolve(request.sourcePath);
    const sourceRoot = projectRootForSource(sourcePath);
    const relativeSource = path.relative(sourceRoot, sourcePath);
    const directMatch = buildInputs.find((entry) => entry === sourcePath || entry.endsWith(relativeSource));
    if (directMatch) {
      return directMatch;
    }
    const buildCandidate = path.join(buildOutputRoot, relativeSource);
    const normalizedCandidate = path.normalize(buildCandidate);
    const relaxedMatch = buildInputs.find((entry) => path.normalize(entry) === normalizedCandidate || path.normalize(entry).endsWith(path.normalize(relativeSource)));
    if (relaxedMatch) {
      return relaxedMatch;
    }
    return buildCandidate;
  }

  const fileName = path.basename(request.sourcePath || 'main.tex');
  return buildInputs.find((entry) => path.basename(entry) === fileName) || path.join(buildOutputRoot, fileName);
}

function runSynctexView(pdfPath: string, sourcePath: string, line: number, column: number, pageHint = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const sourceSpec =
      pageHint > 0
        ? `${Math.max(1, line)}:${Math.max(1, column)}:${Math.max(1, pageHint)}:${sourcePath}`
        : `${Math.max(1, line)}:${Math.max(1, column)}:${sourcePath}`;
    const child = spawn(
      'synctex',
      ['view', '-i', sourceSpec, '-o', pdfPath],
      { cwd: path.dirname(pdfPath) },
    );
    const chunks: string[] = [];
    child.stdout.on('data', (data) => chunks.push(data.toString()));
    child.stderr.on('data', (data) => chunks.push(data.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      const output = chunks.join('');
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(output || `synctex exited with code ${code}`));
    });
  });
}

export async function locatePdfSelection(request: PdfSelectionLocateRequest): Promise<PdfSelectionLocateResult> {
  const buildPath = resolveBuildUrlPath(request.pdfUrl, request.projectRoot);
  if (!buildPath) {
    return { ok: false, message: 'PDF path is outside texor build output.' };
  }
  const { filePath: pdfPath, buildRoot } = buildPath;

  const page = Math.max(1, Math.round(request.page));
  const centerX = request.x + (request.width || 0) / 2;
  const centerY = request.y + (request.height || 0) / 2;

  try {
    const output = await runSynctexEdit(pdfPath, page, centerX, centerY);
    const located = parseSynctexOutput(output);
    if (!located.sourceFile || !located.line) {
      return { ok: false, message: 'SyncTeX did not return a source line.' };
    }
    const buildSource = path.isAbsolute(located.sourceFile)
      ? located.sourceFile
      : path.resolve(path.dirname(pdfPath), located.sourceFile);
    const resolvedSource = mapBuildSourceToProjectSource(buildSource, pdfPath, buildRoot, request);
    const resolvedLine = await mapLineToProjectLine(buildSource, located.line, resolvedSource);
    return {
      ok: true,
      sourceFile: resolvedSource,
      line: resolvedLine,
      column: located.column,
      snippet: await sourceSnippet(resolvedSource, resolvedLine),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'SyncTeX lookup failed.',
    };
  }
}

export async function locateSourceLine(request: SourceLineLocateRequest): Promise<SourceLineLocateResult> {
  const buildPath = resolveBuildUrlPath(request.pdfUrl, request.projectRoot);
  if (!buildPath) {
    return { ok: false, message: 'PDF path is outside texor build output.' };
  }
  const { filePath: pdfPath, buildRoot } = buildPath;

  try {
    const buildSource = await buildSourcePathForView(pdfPath, buildRoot, request);
    const output = await runSynctexView(pdfPath, buildSource, request.line, request.column || 1, request.pageHint || 0);
    const matches = parseSynctexViewOutput(output);
    const hintedPage = request.pageHint && Number.isFinite(request.pageHint) ? Math.max(1, Math.round(request.pageHint)) : 0;
    const best = matches
      .slice()
      .sort((left, right) => {
        const leftPageDistance = hintedPage > 0 ? Math.abs(left.page - hintedPage) : 0;
        const rightPageDistance = hintedPage > 0 ? Math.abs(right.page - hintedPage) : 0;
        if (leftPageDistance !== rightPageDistance) {
          return leftPageDistance - rightPageDistance;
        }
        const leftScore = left.width + left.height * 8;
        const rightScore = right.width + right.height * 8;
        return leftScore - rightScore;
      })[0];
    if (!best) {
      return { ok: false, message: 'SyncTeX did not return a PDF position.' };
    }
    return {
      ok: true,
      page: best.page,
      x: best.x,
      y: best.y,
      width: best.width,
      height: best.height,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'SyncTeX forward lookup failed.',
    };
  }
}
