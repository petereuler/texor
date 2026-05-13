import path from 'node:path';
import { dataPath } from './appPaths.js';

const globalBuildsDir = dataPath('builds');

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function buildsDirForProject(projectRoot?: string): string {
  return projectRoot ? path.join(path.resolve(projectRoot), '.texor', 'builds') : globalBuildsDir;
}

export function buildPdfUrl(buildId: string, relativePdfPath: string, projectRoot?: string): string {
  const normalized = relativePdfPath.split(path.sep).join('/');
  const query = projectRoot ? `?projectRoot=${encodeURIComponent(path.resolve(projectRoot))}` : '';
  return `/api/builds/${encodeURIComponent(buildId)}/${normalized}${query}`;
}

export function resolveBuildRequestPath(relativePath: string, projectRoot?: string): string | null {
  const normalized = relativePath.replace(/^[/\\]+/, '');
  if (!normalized) {
    return null;
  }
  const buildRoot = buildsDirForProject(projectRoot);
  const resolved = path.resolve(buildRoot, normalized);
  return isInside(buildRoot, resolved) ? resolved : null;
}

export function resolveBuildUrlPath(pdfUrl: string, fallbackProjectRoot?: string): { filePath: string; buildRoot: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(pdfUrl, 'http://texor.local');
  } catch {
    return null;
  }
  if (!parsed.pathname.startsWith('/api/builds/')) {
    return null;
  }
  const relativePath = decodeURIComponent(parsed.pathname.replace('/api/builds/', ''));
  const projectRoot = parsed.searchParams.get('projectRoot') || fallbackProjectRoot;
  const buildRoot = buildsDirForProject(projectRoot || undefined);
  const filePath = resolveBuildRequestPath(relativePath, projectRoot || undefined);
  return filePath ? { filePath, buildRoot } : null;
}
