import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TemplateCatalogEntry, TemplateEnsureResult, TemplateSuggestion } from '../types.js';
import { appPath, dataPath } from './appPaths.js';

const catalogPath = appPath('templates', 'catalog.json');
const templateDownloadCachePath = dataPath('templates', 'resolved-downloads.json');
const archiveExtensions = ['.zip'];
const templateFetchTimeoutMs = 12_000;
const requestHeaders = {
  'User-Agent': 'TEXOR Template Fetcher/0.2 (+https://github.com/petereuler/texor)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenPrefixScore(query: string, candidate: string): number {
  const queryParts = normalize(query).split(' ').filter(Boolean);
  const candidateParts = normalize(candidate).split(' ').filter(Boolean);
  if (queryParts.length === 0) {
    return 0;
  }

  for (let startIndex = 0; startIndex <= candidateParts.length - queryParts.length; startIndex += 1) {
    const matched = queryParts.every((part, index) => candidateParts[startIndex + index]?.startsWith(part));
    if (matched) {
      return 860 - startIndex * 18 - candidate.length / 100;
    }
  }

  return 0;
}

function fuzzyOrderedScore(query: string, candidate: string): number {
  const normalizedQuery = normalize(query).replace(/\s+/g, '');
  const normalizedCandidate = normalize(candidate).replace(/\s+/g, '');
  if (!normalizedQuery) {
    return 0;
  }

  let queryIndex = 0;
  let firstMatch = -1;
  let gaps = 0;
  let previousMatch = -1;

  for (let candidateIndex = 0; candidateIndex < normalizedCandidate.length && queryIndex < normalizedQuery.length; candidateIndex += 1) {
    if (normalizedCandidate[candidateIndex] === normalizedQuery[queryIndex]) {
      if (firstMatch === -1) {
        firstMatch = candidateIndex;
      }
      if (previousMatch !== -1) {
        gaps += candidateIndex - previousMatch - 1;
      }
      previousMatch = candidateIndex;
      queryIndex += 1;
    }
  }

  return queryIndex === normalizedQuery.length ? 360 - firstMatch * 4 - gaps : 0;
}

function compactScore(query: string, candidate: string): number {
  const normalizedQuery = normalize(query);
  const normalizedCandidate = normalize(candidate);
  if (!normalizedQuery) {
    return 0;
  }

  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const compactCandidate = normalizedCandidate.replace(/\s+/g, '');

  if (normalizedCandidate === normalizedQuery) {
    return 1000;
  }
  if (compactCandidate === compactQuery) {
    return 980;
  }
  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return 900 - normalizedCandidate.length / 100;
  }
  if (compactCandidate.startsWith(compactQuery)) {
    return 880 - compactCandidate.length / 100;
  }
  if (normalizedCandidate.includes(normalizedQuery)) {
    return 700 - normalizedCandidate.indexOf(normalizedQuery);
  }
  if (compactCandidate.includes(compactQuery)) {
    return 680 - compactCandidate.indexOf(compactQuery);
  }

  const prefixScore = tokenPrefixScore(query, candidate);
  if (prefixScore > 0) {
    return prefixScore;
  }

  const queryParts = normalizedQuery.split(' ').filter(Boolean);
  if (queryParts.length > 2) {
    return fuzzyOrderedScore(query, candidate);
  }

  let matched = 0;
  for (const part of queryParts) {
    if (normalizedCandidate.includes(part)) {
      matched += 1;
    }
  }
  if (matched === queryParts.length) {
    return 500 - normalizedCandidate.length / 100;
  }

  return fuzzyOrderedScore(query, candidate);
}

function labelForMatch(entry: TemplateCatalogEntry, matchedName: string): string {
  const normalizedMatch = normalize(matchedName);
  if (entry.id === 'ieee-tim') {
    const aliases: Record<string, string> = {
      tim: 'IEEE Transactions on Instrumentation and Measurement',
      'ieee tim': 'IEEE Transactions on Instrumentation and Measurement',
      'transactions on instrumentation and measurement': 'IEEE Transactions on Instrumentation and Measurement',
      'instrumentation and measurement': 'IEEE Transactions on Instrumentation and Measurement',
      'ieee instrumentation and measurement society tim': 'IEEE Transactions on Instrumentation and Measurement',
    };
    return aliases[normalizedMatch] || matchedName;
  }
  if (entry.id === 'ieee-article') {
    const aliases: Record<string, string> = {
      pami: 'IEEE Transactions on Pattern Analysis and Machine Intelligence',
      tpami: 'IEEE Transactions on Pattern Analysis and Machine Intelligence',
      tvcg: 'IEEE Transactions on Visualization and Computer Graphics',
    };
    return aliases[normalizedMatch] || matchedName;
  }
  if (entry.id === 'acm-acmart') {
    const aliases: Record<string, string> = {
      tog: 'ACM Transactions on Graphics',
    };
    return aliases[normalizedMatch] || matchedName;
  }
  return matchedName;
}

function buildCandidates(entry: TemplateCatalogEntry): Array<{ matchText: string; label: string }> {
  const baseNames = [entry.name, ...entry.aliases];
  const candidates: Array<{ matchText: string; label: string }> = [
    { matchText: entry.name, label: entry.name },
    { matchText: `${entry.publisher} ${entry.name}`, label: entry.name },
    { matchText: entry.templateFamily, label: entry.name },
    { matchText: `${entry.publisher} ${entry.templateFamily}`, label: entry.name },
  ];

  for (const name of baseNames) {
    const label = labelForMatch(entry, name);
    candidates.push({ matchText: name, label });
    candidates.push({ matchText: `${entry.publisher} ${name}`, label });
    candidates.push({ matchText: `${entry.templateFamily} ${name}`, label });
    candidates.push({ matchText: `${entry.publisher} ${entry.templateFamily} ${name}`, label });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${normalize(candidate.matchText)}:${normalize(candidate.label)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function readTemplateCatalog(): Promise<TemplateCatalogEntry[]> {
  const raw = await fs.readFile(catalogPath, 'utf8');
  return JSON.parse(raw) as TemplateCatalogEntry[];
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = templateFetchTimeoutMs): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function bundledLocalPath(entry: TemplateCatalogEntry): string | undefined {
  return entry.localPath ? appPath(...entry.localPath.split(/[\\/]+/)) : undefined;
}

function cachedLocalPath(entry: TemplateCatalogEntry): string | undefined {
  if (entry.localPath) {
    return dataPath(...entry.localPath.split(/[\\/]+/));
  }
  return dataPath('templates', 'packages', entry.id);
}

async function resolvedLocalPath(entry: TemplateCatalogEntry): Promise<string | undefined> {
  const cached = cachedLocalPath(entry);
  if (cached && (await pathExists(cached))) {
    return cached;
  }
  const bundled = bundledLocalPath(entry);
  if (bundled && (await pathExists(bundled))) {
    return bundled;
  }
  return undefined;
}

async function isTemplateCached(entry: TemplateCatalogEntry): Promise<boolean> {
  return Boolean(await resolvedLocalPath(entry));
}

function directDownloadUrl(entry: TemplateCatalogEntry): string | undefined {
  if (entry.sourceUrl && hasArchiveSuffix(entry.sourceUrl)) {
    return entry.sourceUrl;
  }

  const archiveName = path.basename(entry.archivePath || '').toLowerCase();
  const knownArchives: Record<string, string> = {
    'ieeetran.zip': 'https://mirrors.ctan.org/macros/latex/contrib/IEEEtran.zip',
    'acmart.zip': 'https://mirrors.ctan.org/macros/latex/contrib/acmart.zip',
    'elsarticle.zip': 'https://mirrors.ctan.org/macros/latex/contrib/elsarticle.zip',
    'els-cas-templates.zip': 'https://mirrors.ctan.org/macros/latex/contrib/els-cas-templates.zip',
    'iclr2026.zip': 'https://github.com/ICLR/Master-Template/raw/master/iclr2026.zip',
  };
  return knownArchives[archiveName];
}

function hasArchiveSuffix(url: string): boolean {
  const lower = url.toLowerCase();
  return archiveExtensions.some((extension) => lower.includes(extension));
}

function uniqUrls(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function templateDownloadHints(entry: TemplateCatalogEntry): string[] {
  const archiveName = path.basename(entry.archivePath || '').replace(/\.(zip|tar\.gz|tgz|tar)$/i, '');
  return uniqUrls([
    archiveName,
    entry.templateFamily,
    entry.id,
    entry.name,
    entry.publisher,
    ...(entry.aliases || []),
  ]).map((value) => normalize(value));
}

async function readDownloadCache(): Promise<Record<string, { url: string; resolvedAt: string; source: string }>> {
  try {
    return JSON.parse(await fs.readFile(templateDownloadCachePath, 'utf8')) as Record<string, { url: string; resolvedAt: string; source: string }>;
  } catch {
    return {};
  }
}

async function writeDownloadCache(cache: Record<string, { url: string; resolvedAt: string; source: string }>): Promise<void> {
  await fs.mkdir(path.dirname(templateDownloadCachePath), { recursive: true });
  await fs.writeFile(templateDownloadCachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractLinksFromHtml(html: string, pageUrl: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const anchorRegex = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const href = decodeHtmlEntities(match[2] || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
      continue;
    }
    try {
      const absolute = new URL(href, pageUrl).toString();
      links.push({
        url: absolute,
        text: stripTags(decodeHtmlEntities(match[3] || '')),
      });
    } catch {
      // Ignore malformed URLs.
    }
  }
  return links;
}

function scoreDownloadCandidate(
  entry: TemplateCatalogEntry,
  candidate: { url: string; text: string },
  pageUrl: string,
): number {
  const haystack = `${candidate.url} ${candidate.text}`.toLowerCase();
  if (haystack.includes('pdf') || haystack.includes('instructions') || haystack.includes('guidelines')) {
    return -100;
  }
  let score = 0;
  if (hasArchiveSuffix(candidate.url)) {
    score += 1200;
  }
  if (haystack.includes('download')) {
    score += 160;
  }
  if (haystack.includes('template')) {
    score += 140;
  }
  if (haystack.includes('style')) {
    score += 80;
  }
  if (new URL(candidate.url).host === new URL(pageUrl).host) {
    score += 50;
  }
  for (const hint of templateDownloadHints(entry)) {
    if (haystack.includes(hint)) {
      score += 45;
    }
  }
  if (candidate.url.toLowerCase().includes('portalparts.acm.org')) {
    score += 120;
  }
  return score;
}

async function probeArchiveUrl(url: string): Promise<boolean> {
  const looksLikeArchiveResponse = (response: Response): boolean => {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const disposition = (response.headers.get('content-disposition') || '').toLowerCase();
    return (
      hasArchiveSuffix(response.url || url) ||
      disposition.includes('.zip') ||
      contentType.includes('zip') ||
      contentType.includes('octet-stream')
    );
  };

  try {
    const headResponse = await fetchWithTimeout(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: requestHeaders,
    });
    if (headResponse.ok && looksLikeArchiveResponse(headResponse)) {
      return true;
    }
  } catch {
    // Some sites reject HEAD; fall through to GET.
  }

  try {
    const getResponse = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'follow',
      headers: requestHeaders,
    });
    if (!getResponse.ok) {
      return false;
    }
    await getResponse.body?.cancel().catch(() => undefined);
    return looksLikeArchiveResponse(getResponse);
  } catch {
    return false;
  }
}

async function fetchHtmlPage(url: string): Promise<{ url: string; html: string } | null> {
  try {
    const response = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: requestHeaders,
    });
    if (!response.ok) {
      return null;
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) {
      return null;
    }
    return {
      url: response.url || url,
      html: await response.text(),
    };
  } catch {
    return null;
  }
}

async function resolveFromAcmOfficialPage(entry: TemplateCatalogEntry): Promise<{ url: string; source: string } | null> {
  if (entry.sourceProvider !== 'acm') {
    return null;
  }
  const page = await fetchHtmlPage(entry.officialPage);
  if (!page) {
    return null;
  }
  const links = extractLinksFromHtml(page.html, page.url);
  const preferred = links.find((link) => {
    const text = `${link.text} ${link.url}`.toLowerCase();
    return text.includes('download the template files') || text.includes('acmart');
  });
  if (!preferred || !(await probeArchiveUrl(preferred.url))) {
    return null;
  }
  return {
    url: preferred.url,
    source: page.url,
  };
}

async function resolveFromElsevierOfficialPage(entry: TemplateCatalogEntry): Promise<{ url: string; source: string } | null> {
  if (entry.sourceProvider !== 'elsevier') {
    return null;
  }
  const page = await fetchHtmlPage(entry.officialPage);
  if (!page) {
    return null;
  }
  const links = extractLinksFromHtml(page.html, page.url);
  const preferredTexts =
    entry.id === 'elsevier-cas'
      ? ['single and double column', 'cas', 'here']
      : ['journal article template package', 'elsarticle'];
  const ranked = links
    .map((link) => ({
      link,
      score: preferredTexts.reduce((total, token) => total + (`${link.text} ${link.url}`.toLowerCase().includes(token) ? 80 : 0), 0),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  for (const { link } of ranked) {
    if (await probeArchiveUrl(link.url)) {
      return {
        url: link.url,
        source: page.url,
      };
    }
  }
  return null;
}

async function resolveProviderDownloadUrl(entry: TemplateCatalogEntry): Promise<{ url: string; source: string } | null> {
  if (entry.sourceKind === 'direct-archive') {
    return null;
  }
  if (entry.sourceProvider === 'acm') {
    return resolveFromAcmOfficialPage(entry);
  }
  if (entry.sourceProvider === 'elsevier') {
    return resolveFromElsevierOfficialPage(entry);
  }
  return null;
}

async function resolveDownloadUrl(entry: TemplateCatalogEntry): Promise<{ url: string; source: string } | null> {
  const cache = await readDownloadCache();
  const cached = cache[entry.id]?.url;
  if (cached && await probeArchiveUrl(cached)) {
    return {
      url: cached,
      source: 'cache',
    };
  }

  const directCandidates = uniqUrls([
    directDownloadUrl(entry),
    ...(entry.fallbackUrls || []),
  ]);
  for (const candidate of directCandidates) {
    if (await probeArchiveUrl(candidate)) {
      cache[entry.id] = {
        url: candidate,
        resolvedAt: new Date().toISOString(),
        source: 'direct',
      };
      await writeDownloadCache(cache);
      return {
        url: candidate,
        source: 'direct',
      };
    }
  }

  const providerResolved = await resolveProviderDownloadUrl(entry);
  if (providerResolved) {
    cache[entry.id] = {
      url: providerResolved.url,
      resolvedAt: new Date().toISOString(),
      source: providerResolved.source,
    };
    await writeDownloadCache(cache);
    return providerResolved;
  }

  return null;
}

function unzipArchive(archiveFile: string, outputDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? 'powershell.exe' : 'unzip';
    const args = process.platform === 'win32'
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          '& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }',
          archiveFile,
          outputDir,
        ]
      : ['-oq', archiveFile, '-d', outputDir];
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    child.stdout.on('data', (data) => chunks.push(data.toString()));
    child.stderr.on('data', (data) => chunks.push(data.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(chunks.join('').trim() || `${executable} exited with code ${code}`));
    });
  });
}

export async function ensureTemplate(entryId: string): Promise<TemplateEnsureResult> {
  const catalog = await readTemplateCatalog();
  const entry = catalog.find((candidate) => candidate.id === entryId);
  if (!entry) {
    return {
      ok: false,
      id: entryId,
      status: 'failed',
      message: '没有找到这个期刊模板。',
    };
  }

  const existingPath = await resolvedLocalPath(entry);
  if (existingPath) {
    return {
      ok: true,
      id: entry.id,
      status: 'cached',
      message: '模板已缓存。',
      localPath: existingPath,
      officialPage: entry.officialPage,
      sourceUrl: entry.sourceUrl,
    };
  }

  const resolvedDownload = await resolveDownloadUrl(entry);
  if (!resolvedDownload) {
    return {
      ok: false,
      id: entry.id,
      status: 'manual-required',
      message: '这个期刊或会议模板暂时还没接入自动下载，请打开官方页面获取。',
      officialPage: entry.officialPage,
      sourceUrl: entry.sourceUrl,
    };
  }

  const targetLocalPath = cachedLocalPath(entry);
  if (!targetLocalPath) {
    return {
      ok: false,
      id: entry.id,
      status: 'failed',
      message: '模板本地路径无效。',
      officialPage: entry.officialPage,
      sourceUrl: entry.sourceUrl,
    };
  }

  try {
    const archiveFile = dataPath('templates', 'archives', path.basename(entry.archivePath || `${entry.id}.zip`));
    const extractRoot = path.dirname(targetLocalPath);
    await fs.mkdir(path.dirname(archiveFile), { recursive: true });
    await fs.mkdir(extractRoot, { recursive: true });

    const response = await fetch(resolvedDownload.url, {
      redirect: 'follow',
      headers: requestHeaders,
    });
    if (!response.ok) {
      throw new Error(`download failed with status ${response.status}`);
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new Error('resolved template URL returned HTML instead of an archive');
    }
    await fs.writeFile(archiveFile, Buffer.from(await response.arrayBuffer()));
    await unzipArchive(archiveFile, extractRoot);

    const downloadedPath = (await pathExists(targetLocalPath)) ? targetLocalPath : extractRoot;
    return {
      ok: true,
      id: entry.id,
      status: 'downloaded',
      message: '首次使用，模板已下载并缓存。',
      localPath: downloadedPath,
      officialPage: entry.officialPage,
      sourceUrl: resolvedDownload.url,
    };
  } catch (error) {
    return {
      ok: false,
      id: entry.id,
      status: 'failed',
      message: error instanceof Error ? error.message : '模板下载失败。',
      officialPage: entry.officialPage,
      sourceUrl: resolvedDownload.url,
    };
  }
}

export async function searchTemplateCatalog(query: string, limit = 8): Promise<TemplateSuggestion[]> {
  const catalog = await readTemplateCatalog();
  const bestByLabel = new Map<string, TemplateSuggestion & { score: number }>();

  for (const entry of catalog) {
    for (const candidate of buildCandidates(entry)) {
      const score = compactScore(query, candidate.matchText);
      if (score > 0) {
        const duplicateKey = normalize(candidate.label);
        const suggestion = {
          id: entry.id,
          label: candidate.label,
          publisher: entry.publisher,
          type: entry.type,
          templateFamily: entry.templateFamily,
          localPath: entry.localPath,
          cached: false,
          sourceUrl: entry.sourceUrl,
          officialPage: entry.officialPage,
          matchedName: candidate.matchText,
          score,
        };
        const previous = bestByLabel.get(duplicateKey);
        if (!previous || suggestion.score > previous.score) {
          bestByLabel.set(duplicateKey, suggestion);
        }
      }
    }
  }

  const ranked = [...bestByLabel.values()]
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit);

  return Promise.all(
    ranked.map(async ({ score: _score, ...suggestion }) => {
      const entry = catalog.find((candidate) => candidate.id === suggestion.id);
      return {
        ...suggestion,
        cached: entry ? await isTemplateCached(entry) : false,
      };
    }),
  );
}
