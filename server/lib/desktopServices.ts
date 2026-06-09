import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopLogDir, readDesktopDiagnosticsSnapshot } from './desktopDiagnostics.js';
import {
  DesktopBootstrap,
  DesktopPreparedTarget,
  ProjectExecutionTarget,
  SSHHostProfile,
  VSCodeImportBundle,
  VSCodeImportedKeybinding,
  WorkspaceCommandResult,
  WorkspaceFileContent,
  WorkspaceFileNode,
} from '../types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_FILE_TREE_LIMIT = 400;
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.texor-data', 'dist', 'dist-server']);

function isDesktopShell(): boolean {
  return process.env.TEXOR_DESKTOP === '1';
}

function vscodeUserConfigDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User');
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeImportedKeybindings(value: unknown): VSCodeImportedKeybinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.command !== 'string' || typeof record.key !== 'string') {
      return [];
    }
    return [{
      command: record.command,
      key: record.key,
      when: typeof record.when === 'string' ? record.when : undefined,
    }];
  });
}

export async function importVSCodeUserConfig(): Promise<VSCodeImportBundle | null> {
  const userDir = vscodeUserConfigDir();
  const settingsPath = path.join(userDir, 'settings.json');
  const keybindingsPath = path.join(userDir, 'keybindings.json');
  const settings = await readJsonFile<Record<string, unknown>>(settingsPath, {});
  const keybindings = normalizeImportedKeybindings(await readJsonFile<unknown[]>(keybindingsPath, []));
  if (!Object.keys(settings).length && keybindings.length === 0) {
    return null;
  }
  return {
    source: userDir,
    importedAt: new Date().toISOString(),
    settings,
    keybindings,
    colorTheme: typeof settings['workbench.colorTheme'] === 'string' ? settings['workbench.colorTheme'] : undefined,
    iconTheme: typeof settings['workbench.iconTheme'] === 'string' ? settings['workbench.iconTheme'] : undefined,
  };
}

export async function desktopBootstrap(
  serverUrl?: string,
  metadata?: {
    windowSessionKey?: string;
  },
): Promise<DesktopBootstrap> {
  const notes: string[] = [];
  if (isDesktopShell() && !serverUrl) {
    notes.push('Embedded desktop server URL is unavailable.');
  }
  const snapshot = isDesktopShell() ? await readDesktopDiagnosticsSnapshot() : null;
  const logPath = process.env.TEXOR_DESKTOP_LOG_PATH || (isDesktopShell() ? path.join(appDataDirForPlatform(), 'TEXOR', 'logs', 'desktop-main.log') : undefined);
  return {
    isDesktop: isDesktopShell(),
    platform: process.platform,
    serverUrl,
    windowSessionKey: metadata?.windowSessionKey,
    importedConfig: isDesktopShell() ? await importVSCodeUserConfig() : null,
    diagnostics: {
      logDir: isDesktopShell() ? desktopLogDir() : undefined,
      logPath,
      bundlePath: isDesktopShell() ? '/api/desktop/diagnostics/bundle' : undefined,
      bundleAvailable: isDesktopShell(),
      logChannels: snapshot?.logFiles,
      startupStatus: isDesktopShell() && !serverUrl ? 'degraded' : 'ready',
      notes: notes.length ? notes : undefined,
    },
  };
}

function appDataDirForPlatform(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return path.join(os.homedir(), '.config');
}

function parseSshBlock(alias: string, lines: string[]): SSHHostProfile {
  const profile: SSHHostProfile = { alias };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(' ').trim();
    const normalized = key.toLowerCase();
    if (normalized === 'hostname') {
      profile.hostname = value;
    } else if (normalized === 'user') {
      profile.user = value;
    } else if (normalized === 'port') {
      const parsed = Number(value);
      profile.port = Number.isFinite(parsed) ? parsed : undefined;
    } else if (normalized === 'identityfile') {
      profile.identityFile = value.replace(/^~/, os.homedir());
    }
  }
  return profile;
}

export async function listSSHHosts(): Promise<SSHHostProfile[]> {
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  const raw = await fs.readFile(sshConfigPath, 'utf8').catch(() => '');
  if (!raw.trim()) {
    return [];
  }

  const hosts: SSHHostProfile[] = [];
  let currentAliases: string[] = [];
  let currentLines: string[] = [];
  const flush = () => {
    if (!currentAliases.length) {
      currentLines = [];
      return;
    }
    for (const alias of currentAliases) {
      if (alias.includes('*') || alias.includes('?')) {
        continue;
      }
      hosts.push(parseSshBlock(alias, currentLines));
    }
    currentAliases = [];
    currentLines = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^host\s+/i.test(trimmed)) {
      flush();
      currentAliases = trimmed.replace(/^host\s+/i, '').split(/\s+/).filter(Boolean);
      continue;
    }
    currentLines.push(line);
  }
  flush();

  return hosts.filter((entry) => entry.alias !== '*');
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function sanitizeAlias(alias: string): string {
  return alias.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export async function prepareExecutionTarget(target: ProjectExecutionTarget): Promise<DesktopPreparedTarget> {
  if (target.kind === 'local') {
    const rootPath = path.resolve(target.rootPath);
    const stat = await fs.stat(rootPath).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`本地项目路径不存在或不是目录: ${rootPath}`);
    }
    return {
      target: { kind: 'local', rootPath },
      effectiveRootPath: rootPath,
      displayLabel: rootPath,
    };
  }

  const mirrorRoot = target.mirrorRoot || path.join(os.homedir(), '.texor-remote', sanitizeAlias(target.hostAlias));
  await ensureDirectory(mirrorRoot);
  const normalizedTarget: Extract<ProjectExecutionTarget, { kind: 'ssh' }> = {
    ...target,
    mirrorRoot,
  };
  const existsCheck = await execFileAsync('ssh', [target.hostAlias, `test -d ${shellQuote(target.remoteRoot)}`]).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
  void existsCheck;
  await syncRemoteTarget(normalizedTarget);
  return {
    target: normalizedTarget,
    effectiveRootPath: mirrorRoot,
    displayLabel: `${target.hostAlias}:${target.remoteRoot}`,
    syncedAt: new Date().toISOString(),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function localPathForTarget(target: ProjectExecutionTarget): string {
  return target.kind === 'local' ? path.resolve(target.rootPath) : path.resolve(target.mirrorRoot || path.join(os.homedir(), '.texor-remote', sanitizeAlias(target.hostAlias)));
}

async function syncRemoteTarget(target: Extract<ProjectExecutionTarget, { kind: 'ssh' }>): Promise<string> {
  const mirrorRoot = localPathForTarget(target);
  await ensureDirectory(mirrorRoot);
  const remoteSource = `${target.hostAlias}:${target.remoteRoot.replace(/\/+$/, '')}/`;
  await execFileAsync('rsync', ['-az', '--delete', remoteSource, `${mirrorRoot}/`]);
  return mirrorRoot;
}

async function syncTargetIfNeeded(target: ProjectExecutionTarget): Promise<string> {
  if (target.kind === 'local') {
    return localPathForTarget(target);
  }
  return syncRemoteTarget(target);
}

export async function listWorkspaceFiles(target: ProjectExecutionTarget, relativePath = '.'): Promise<WorkspaceFileNode[]> {
  const rootPath = await syncTargetIfNeeded(target);
  const startPath = path.resolve(rootPath, relativePath);
  const discovered: WorkspaceFileNode[] = [];
  const stack: Array<{ current: string; depth: number }> = [{ current: startPath, depth: 0 }];
  while (stack.length > 0 && discovered.length < DEFAULT_FILE_TREE_LIMIT) {
    const next = stack.pop() as { current: string; depth: number };
    const entries = await fs.readdir(next.current, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(next.current, entry.name);
      const relative = path.relative(rootPath, fullPath) || entry.name;
      discovered.push({
        path: relative,
        name: entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file',
        depth: next.depth,
      });
      if (entry.isDirectory() && discovered.length < DEFAULT_FILE_TREE_LIMIT) {
        stack.push({ current: fullPath, depth: next.depth + 1 });
      }
    }
  }
  return discovered;
}

export async function readWorkspaceFile(target: ProjectExecutionTarget, relativePath: string): Promise<WorkspaceFileContent> {
  const rootPath = await syncTargetIfNeeded(target);
  const resolved = path.resolve(rootPath, relativePath);
  const content = await fs.readFile(resolved, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > DEFAULT_MAX_FILE_BYTES) {
    throw new Error(`文件过大，暂不支持直接打开: ${relativePath}`);
  }
  return {
    path: relativePath,
    content,
  };
}

export async function writeWorkspaceFile(target: ProjectExecutionTarget, relativePath: string, content: string): Promise<WorkspaceFileContent> {
  const rootPath = await syncTargetIfNeeded(target);
  const resolved = path.resolve(rootPath, relativePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, 'utf8');
  if (target.kind === 'ssh') {
    const remoteFile = `${target.hostAlias}:${target.remoteRoot.replace(/\/+$/, '')}/${relativePath.replace(/\\/g, '/')}`;
    await execFileAsync('rsync', ['-az', resolved, remoteFile]);
  }
  return {
    path: relativePath,
    content,
  };
}

function remoteCwdForTarget(target: Extract<ProjectExecutionTarget, { kind: 'ssh' }>, cwd?: string): string {
  if (!cwd?.trim()) {
    return target.remoteRoot;
  }
  const mirrorRoot = localPathForTarget(target);
  const resolvedCwd = path.resolve(cwd);
  if (resolvedCwd === mirrorRoot) {
    return target.remoteRoot;
  }
  if (resolvedCwd.startsWith(`${mirrorRoot}${path.sep}`)) {
    const relative = path.relative(mirrorRoot, resolvedCwd).split(path.sep).join('/');
    return `${target.remoteRoot.replace(/\/+$/, '')}/${relative}`.replace(/\/{2,}/g, '/');
  }
  return target.remoteRoot;
}

export async function runWorkspaceCommand(
  target: ProjectExecutionTarget,
  command: string,
  cwd?: string,
): Promise<WorkspaceCommandResult> {
  const effectiveCwd = cwd?.trim() || localPathForTarget(target);
  try {
    if (target.kind === 'ssh') {
      const remoteCwd = remoteCwdForTarget(target, effectiveCwd);
      const remoteCommand = `cd ${shellQuote(remoteCwd)} && bash -lc ${shellQuote(command)}`;
      const { stdout, stderr } = await execFileAsync('ssh', [target.hostAlias, remoteCommand], {
        cwd: os.homedir(),
      });
      return {
        ok: true,
        command,
        cwd: remoteCwd,
        stdout,
        stderr,
        exitCode: 0,
      };
    }
    const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], { cwd: effectiveCwd });
    return {
      ok: true,
      command,
      cwd: effectiveCwd,
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      command,
      cwd: target.kind === 'ssh' ? remoteCwdForTarget(target, effectiveCwd) : effectiveCwd,
      stdout: failure.stdout || '',
      stderr: failure.stderr || (error instanceof Error ? error.message : String(error)),
      exitCode: typeof failure.code === 'number' ? failure.code : null,
    };
  }
}
