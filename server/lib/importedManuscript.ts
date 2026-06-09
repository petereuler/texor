import { promises as fs } from 'node:fs';
import path from 'node:path';

const skippedDirectoryNames = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.texor',
  'node_modules',
  '__pycache__',
]);

const skippedFileNames = new Set([
  '.DS_Store',
]);

const skippedFileSuffixes = [
  '.aux',
  '.bcf',
  '.blg',
  '.fdb_latexmk',
  '.fls',
  '.log',
  '.out',
  '.run.xml',
  '.synctex.gz',
  '.toc',
  '.lof',
  '.lot',
  '.nav',
  '.snm',
  '.vrb',
  '.xdv',
];

const preservedManuscriptEntries = new Set([
  'failed-drafts',
]);

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function shouldSkipImportEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    return skippedDirectoryNames.has(name);
  }
  if (skippedFileNames.has(name)) {
    return true;
  }
  return skippedFileSuffixes.some((suffix) => name.endsWith(suffix));
}

async function resetManuscriptDirectory(manuscriptDir: string): Promise<void> {
  await fs.mkdir(manuscriptDir, { recursive: true });
  const entries = await fs.readdir(manuscriptDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (preservedManuscriptEntries.has(entry.name)) {
      continue;
    }
    await fs.rm(path.join(manuscriptDir, entry.name), { recursive: true, force: true });
  }
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<number> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  let copiedFileCount = 0;

  for (const entry of entries) {
    if (shouldSkipImportEntry(entry.name, entry.isDirectory())) {
      continue;
    }

    const sourceEntryPath = path.join(sourceDir, entry.name);
    const targetEntryPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(targetEntryPath, { recursive: true });
      copiedFileCount += await copyDirectoryContents(sourceEntryPath, targetEntryPath);
      continue;
    }

    if (entry.isFile()) {
      await fs.mkdir(path.dirname(targetEntryPath), { recursive: true });
      await fs.copyFile(sourceEntryPath, targetEntryPath);
      copiedFileCount += 1;
      continue;
    }

    if (!entry.isSymbolicLink()) {
      continue;
    }

    const resolved = await fs.realpath(sourceEntryPath).catch(() => null);
    if (!resolved) {
      continue;
    }

    const stat = await fs.stat(resolved).catch(() => null);
    if (stat?.isDirectory()) {
      await fs.mkdir(targetEntryPath, { recursive: true });
      copiedFileCount += await copyDirectoryContents(resolved, targetEntryPath);
      continue;
    }

    if (stat?.isFile() && !shouldSkipImportEntry(path.basename(resolved), false)) {
      await fs.mkdir(path.dirname(targetEntryPath), { recursive: true });
      await fs.copyFile(resolved, targetEntryPath);
      copiedFileCount += 1;
    }
  }

  return copiedFileCount;
}

export async function importManuscriptWorkspace(sourcePath: string, manuscriptPath: string): Promise<{
  latex: string;
  copiedFileCount: number;
  sourceDir: string;
  manuscriptDir: string;
}> {
  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedManuscriptPath = path.resolve(manuscriptPath);
  const sourceDir = path.dirname(resolvedSourcePath);
  const manuscriptDir = path.dirname(resolvedManuscriptPath);
  const latex = await fs.readFile(resolvedSourcePath, 'utf8');

  await fs.mkdir(manuscriptDir, { recursive: true });

  const sourceAlreadyInsideManuscript = isInside(manuscriptDir, resolvedSourcePath);
  let copiedFileCount = 0;

  if (!sourceAlreadyInsideManuscript) {
    await resetManuscriptDirectory(manuscriptDir);
    copiedFileCount = await copyDirectoryContents(sourceDir, manuscriptDir);
  }

  await fs.writeFile(resolvedManuscriptPath, latex, 'utf8');

  return {
    latex,
    copiedFileCount,
    sourceDir,
    manuscriptDir,
  };
}
