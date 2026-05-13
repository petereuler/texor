import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CompileResult } from '../types.js';
import { buildPdfUrl, buildsDirForProject } from './buildPaths.js';

const buildsDir = buildsDirForProject();

async function ensureBuildsDir(): Promise<void> {
  await fs.mkdir(buildsDir, { recursive: true });
}

async function findEngine(): Promise<string> {
  const candidates = ['pdflatex', 'lualatex'];
  for (const engine of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(engine, ['--version'], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('missing'))));
      });
      return engine;
    } catch {
      continue;
    }
  }
  throw new Error('No LaTeX engine found. Install lualatex or pdflatex before compiling.');
}

function createBuildId(): string {
  return `build-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function compileLatex(latex: string): Promise<CompileResult> {
  await ensureBuildsDir();
  const engine = await findEngine();
  const buildId = createBuildId();
  const outputDir = path.join(buildsDir, buildId);
  const texFile = path.join(outputDir, 'manuscript.tex');

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(texFile, latex);

  const log = await runLatexTwice(engine, 'manuscript.tex', outputDir, outputDir).catch((error: Error) => error.message);

  const pdfPath = path.join(outputDir, 'manuscript.pdf');
  try {
    await fs.access(pdfPath);
    return {
      ok: true,
      pdfUrl: buildPdfUrl(buildId, 'manuscript.pdf'),
      pdfPath,
      texPath: texFile,
      log,
      engine,
      outputDir,
    };
  } catch {
    return {
      ok: false,
      log,
      engine,
      outputDir,
    };
  }
}

function normalizeSearchDir(input: string, recursive = false): string {
  const resolved = toLatexPath(path.resolve(input));
  return recursive ? `${resolved}//` : `${resolved}/`;
}

function toLatexPath(input: string): string {
  return input.split(path.sep).join('/');
}

function latexSearchEnv(outputDir: string, compileDir: string, extraInputDirs: string[] = []): NodeJS.ProcessEnv {
  const recursiveOutput = `${toLatexPath(outputDir)}//`;
  const currentDir = `${toLatexPath(compileDir)}/`;
  const uniqueExtraDirs = [...new Set(extraInputDirs.map((entry) => path.resolve(entry)))];
  const mergePath = (name: string) => {
    const existing = process.env[name];
    const prefix = [
      currentDir,
      ...uniqueExtraDirs.flatMap((entry) => [normalizeSearchDir(entry), normalizeSearchDir(entry, true)]),
      recursiveOutput,
      '',
    ].join(path.delimiter);
    return existing ? `${prefix}${path.delimiter}${existing}` : prefix;
  };
  return {
    ...process.env,
    TEXINPUTS: mergePath('TEXINPUTS'),
    BIBINPUTS: mergePath('BIBINPUTS'),
    BSTINPUTS: mergePath('BSTINPUTS'),
  };
}

async function runLatex(engine: string, texName: string, cwd: string, outputDir: string, extraInputDirs: string[] = []): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const child = spawn(engine, ['-synctex=1', '-interaction=nonstopmode', '-halt-on-error', `-output-directory=${toLatexPath(outputDir)}`, toLatexPath(texName)], {
      cwd,
      env: latexSearchEnv(outputDir, cwd, extraInputDirs),
    });
    child.stdout.on('data', (data) => chunks.push(data.toString()));
    child.stderr.on('data', (data) => chunks.push(data.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      const combined = chunks.join('');
      if (code === 0) {
        resolve(combined);
        return;
      }
      reject(new Error(combined));
    });
  });
}

async function runLatexTwice(engine: string, texName: string, cwd: string, outputDir: string, extraInputDirs: string[] = []): Promise<string> {
  const first = await runLatex(engine, texName, cwd, outputDir, extraInputDirs);
  const second = await runLatex(engine, texName, cwd, outputDir, extraInputDirs);
  return `${first}\n${second}`;
}

function projectRootForSource(sourcePath: string, explicitProjectRoot?: string): string {
  const resolvedSource = path.resolve(sourcePath);
  if (explicitProjectRoot) {
    const resolvedRoot = path.resolve(explicitProjectRoot);
    const relative = path.relative(resolvedRoot, resolvedSource);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return resolvedRoot;
    }
  }

  const parts = resolvedSource.split(path.sep);
  const texorIndex = parts.lastIndexOf('.texor');
  if (texorIndex > 0) {
    return parts.slice(0, texorIndex).join(path.sep) || path.sep;
  }
  return path.dirname(sourcePath);
}

export async function compileLatexProject(
  latex: string,
  sourcePath?: string,
  projectRoot?: string,
  assetRoots: string[] = [],
): Promise<CompileResult> {
  if (!sourcePath) {
    return compileLatex(latex);
  }

  const engine = await findEngine();
  const buildId = createBuildId();
  const rootPath = projectRootForSource(sourcePath, projectRoot);
  const projectBuildsDir = buildsDirForProject(rootPath);
  const outputDir = path.join(projectBuildsDir, buildId);
  const relativeSource = path.relative(rootPath, sourcePath) || 'manuscript.tex';
  const texFile = path.join(outputDir, relativeSource);
  const sourceDir = path.dirname(path.resolve(sourcePath));

  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.dirname(texFile), { recursive: true });
  await fs.writeFile(texFile, latex);

  const texInput = toLatexPath(path.relative(sourceDir, texFile));
  const log = await runLatexTwice(engine, texInput, sourceDir, outputDir, [
    rootPath,
    sourceDir,
    path.dirname(texFile),
    ...assetRoots,
  ]).catch((error: Error) => error.message);

  const pdfName = `${path.basename(texFile, path.extname(texFile))}.pdf`;
  const pdfPath = path.join(outputDir, pdfName);
  try {
    await fs.access(pdfPath);
    const relativePdfPath = path.relative(outputDir, pdfPath).split(path.sep).join('/');
    return {
      ok: true,
      pdfUrl: buildPdfUrl(buildId, relativePdfPath, rootPath),
      pdfPath,
      texPath: texFile,
      log,
      engine,
      outputDir,
    };
  } catch {
    return {
      ok: false,
      log,
      engine,
      outputDir,
    };
  }
}
