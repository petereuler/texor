import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPath } from './appPaths.js';

export type DesktopLogChannel = 'desktop-main' | 'desktop-preload' | 'desktop-renderer' | 'desktop-server';

const DESKTOP_LOG_CHANNELS: DesktopLogChannel[] = ['desktop-main', 'desktop-preload', 'desktop-renderer', 'desktop-server'];

export interface DesktopDiagnosticsSnapshot {
  logDir: string;
  logFiles: Array<{
    channel: DesktopLogChannel;
    path: string;
    exists: boolean;
    sizeBytes?: number;
    updatedAt?: string;
  }>;
  environment: {
    desktop: boolean;
    platform: NodeJS.Platform;
    appRoot?: string;
    dataDir?: string;
    serverUrl?: string;
    logPath?: string;
    pid: number;
  };
}

export interface DesktopDiagnosticsBundle {
  archivePath: string;
  filename: string;
  cleanup: () => Promise<void>;
}

function homeRelativeDisplayPath(targetPath: string): string {
  const home = os.homedir();
  const normalized = path.resolve(targetPath);
  if (normalized === home) {
    return '~';
  }
  if (normalized.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, normalized).replace(/\\/g, '/')}`;
  }
  return normalized;
}

export function desktopLogDir(): string {
  return path.dirname(process.env.TEXOR_DESKTOP_LOG_PATH || dataPath('logs', 'desktop-main.log'));
}

export function desktopLogPathFor(channel: DesktopLogChannel): string {
  if (channel === 'desktop-main') {
    return process.env.TEXOR_DESKTOP_LOG_PATH || path.join(desktopLogDir(), 'desktop-main.log');
  }
  return path.join(desktopLogDir(), `${channel}.log`);
}

export async function appendDesktopChannelLog(
  channel: DesktopLogChannel,
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
): Promise<string> {
  const target = desktopLogPathFor(channel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `[${new Date().toISOString()}] [${level}] ${message}\n`, 'utf8');
  return target;
}

async function describeLogFile(channel: DesktopLogChannel) {
  const target = desktopLogPathFor(channel);
  try {
    const stat = await fs.stat(target);
    return {
      channel,
      path: target,
      exists: true,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return {
      channel,
      path: target,
      exists: false,
    };
  }
}

export async function readDesktopDiagnosticsSnapshot(): Promise<DesktopDiagnosticsSnapshot> {
  const logFiles = await Promise.all(DESKTOP_LOG_CHANNELS.map((channel) => describeLogFile(channel)));
  return {
    logDir: desktopLogDir(),
    logFiles,
    environment: {
      desktop: process.env.TEXOR_DESKTOP === '1',
      platform: process.platform,
      appRoot: process.env.TEXOR_APP_ROOT,
      dataDir: process.env.TEXOR_DATA_DIR,
      serverUrl: process.env.TEXOR_SERVER_URL,
      logPath: process.env.TEXOR_DESKTOP_LOG_PATH,
      pid: process.pid,
    },
  };
}

export async function buildDesktopDiagnosticsBundle(): Promise<DesktopDiagnosticsBundle> {
  const snapshot = await readDesktopDiagnosticsSnapshot();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'texor-desktop-diagnostics-'));
  const bundleName = `texor-desktop-diagnostics-${new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '')}`;
  const bundleRoot = path.join(tempRoot, bundleName);
  const logsRoot = path.join(bundleRoot, 'logs');
  const archivePath = path.join(tempRoot, `${bundleName}.zip`);
  const manifest = {
    generatedAt: new Date().toISOString(),
    logDir: snapshot.logDir,
    displayLogDir: homeRelativeDisplayPath(snapshot.logDir),
    environment: snapshot.environment,
    logFiles: snapshot.logFiles.map((entry) => ({
      ...entry,
      displayPath: homeRelativeDisplayPath(entry.path),
    })),
  };
  const readme = [
    '# TEXOR Desktop Diagnostics',
    '',
    'This bundle contains desktop logs and a small runtime manifest.',
    '',
    'Included logs:',
    ...snapshot.logFiles.map((entry) => `- ${entry.channel}: ${entry.exists ? homeRelativeDisplayPath(entry.path) : 'missing at capture time'}`),
    '',
    'Use this bundle when reporting startup, renderer, preload, or embedded server failures.',
  ].join('\n');

  await fs.mkdir(logsRoot, { recursive: true });
  for (const entry of snapshot.logFiles) {
    if (!entry.exists) {
      continue;
    }
    await fs.copyFile(entry.path, path.join(logsRoot, path.basename(entry.path)));
  }
  await fs.writeFile(path.join(bundleRoot, 'desktop-diagnostics.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(bundleRoot, 'README.md'), readme, 'utf8');

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('zip', ['-qr', archivePath, bundleName], { cwd: tempRoot });

  return {
    archivePath,
    filename: `${bundleName}.zip`,
    cleanup: async () => {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
