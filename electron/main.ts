import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DesktopBootstrap, ProjectExecutionTarget, SSHHostProfile, VSCodeImportBundle } from '../src/types.js';
import { appendDesktopChannelLog } from '../server/lib/desktopDiagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_READY_TIMEOUT_MS = 12000;
const SERVER_HEALTH_TIMEOUT_MS = 5000;

type RuntimeMode = 'ts-dev' | 'built-local' | 'packaged';

interface StartupCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface DesktopRuntimePaths {
  mode: RuntimeMode;
  appRoot: string;
  dataDir: string;
  logPath: string;
  preloadPath: string;
  rendererUrl: string;
  rendererEntryPath?: string;
  serverModulePath: string;
  desktopServicesModulePath: string;
  usesDevServer: boolean;
}

interface DesktopApiModule {
  desktopBootstrap: (serverUrl?: string, metadata?: { windowSessionKey?: string }) => Promise<DesktopBootstrap>;
  importVSCodeUserConfig: () => Promise<VSCodeImportBundle | null>;
  listSSHHosts: () => Promise<SSHHostProfile[]>;
  prepareExecutionTarget: (target: ProjectExecutionTarget) => Promise<unknown>;
}

interface ServerModule {
  startTexorServer: (port?: number) => Promise<unknown>;
}

interface StartupFailureState {
  title: string;
  error: unknown;
  checks: StartupCheck[];
}

let currentServerUrl = '';
let desktopApi: DesktopApiModule | null = null;
let texorServer: ServerModule | null = null;
let cachedRuntimePaths: DesktopRuntimePaths | null = null;
let startupFailure: StartupFailureState | null = null;
const windowSessionKeyByWindowId = new Map<number, string>();

function isDesktopTsDev(): boolean {
  return process.env.TEXOR_DESKTOP_DEV === '1';
}

function runtimeMode(): RuntimeMode {
  if (app.isPackaged) {
    return 'packaged';
  }
  if (isDesktopTsDev()) {
    return 'ts-dev';
  }
  return 'built-local';
}

function localRepoRoot(): string {
  return runtimeMode() === 'ts-dev' ? path.resolve(__dirname, '..') : path.resolve(__dirname, '..', '..');
}

function packagedAppRoot(): string {
  return path.join(process.resourcesPath, 'app');
}

function resolveRuntimePaths(): DesktopRuntimePaths {
  if (cachedRuntimePaths) {
    return cachedRuntimePaths;
  }

  const mode = runtimeMode();
  const appRoot = mode === 'packaged' ? packagedAppRoot() : localRepoRoot();
  const usesDevServer = mode === 'ts-dev';
  const userDataDir = app.getPath('userData');
  const logPath = path.join(userDataDir, 'logs', 'desktop-main.log');

  const runtime: DesktopRuntimePaths =
    mode === 'packaged'
      ? {
          mode,
          appRoot,
          dataDir: path.join(userDataDir, 'data'),
          logPath,
          preloadPath: path.join(appRoot, 'dist-electron', 'electron', 'preload.js'),
          rendererUrl: pathToFileURL(path.join(appRoot, 'dist', 'index.html')).toString(),
          rendererEntryPath: path.join(appRoot, 'dist', 'index.html'),
          serverModulePath: path.join(appRoot, 'dist-server', 'index.js'),
          desktopServicesModulePath: path.join(appRoot, 'dist-server', 'lib', 'desktopServices.js'),
          usesDevServer,
        }
      : mode === 'built-local'
        ? {
            mode,
            appRoot,
            dataDir: path.join(appRoot, '.texor-data'),
            logPath,
            preloadPath: path.join(appRoot, 'dist-electron', 'electron', 'preload.js'),
            rendererUrl: pathToFileURL(path.join(appRoot, 'dist', 'index.html')).toString(),
            rendererEntryPath: path.join(appRoot, 'dist', 'index.html'),
            serverModulePath: path.join(appRoot, 'dist-electron', 'server', 'index.js'),
            desktopServicesModulePath: path.join(appRoot, 'dist-electron', 'server', 'lib', 'desktopServices.js'),
            usesDevServer,
          }
        : {
            mode,
            appRoot,
            dataDir: path.join(appRoot, '.texor-data'),
            logPath,
            preloadPath: path.join(appRoot, 'dist-electron', 'electron', 'preload.js'),
            rendererUrl: process.env.TEXOR_RENDERER_URL || 'http://127.0.0.1:4173',
            serverModulePath: path.join(appRoot, 'server', 'index.ts'),
            desktopServicesModulePath: path.join(appRoot, 'server', 'lib', 'desktopServices.ts'),
            usesDevServer,
          };

  cachedRuntimePaths = runtime;
  return runtime;
}

function configureDesktopEnv(runtime: DesktopRuntimePaths): void {
  process.env.TEXOR_DESKTOP = '1';
  process.env.TEXOR_APP_ROOT = runtime.appRoot;
  process.env.TEXOR_DATA_DIR = runtime.dataDir;
  process.env.TEXOR_DESKTOP_LOG_PATH = runtime.logPath;
  if (currentServerUrl) {
    process.env.TEXOR_SERVER_URL = currentServerUrl;
  }
}

function logTargetPath(): string {
  if (cachedRuntimePaths) {
    return cachedRuntimePaths.logPath;
  }
  try {
    return path.join(app.getPath('userData'), 'logs', 'desktop-main.log');
  } catch {
    return path.resolve(process.cwd(), '.texor-data', 'desktop-main.log');
  }
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function ensureWindowSessionKey(win: BrowserWindow): string {
  const existing = windowSessionKeyByWindowId.get(win.id);
  if (existing) {
    return existing;
  }
  const generated = crypto.randomUUID();
  windowSessionKeyByWindowId.set(win.id, generated);
  return generated;
}

async function appendDesktopLog(level: 'INFO' | 'ERROR', message: string): Promise<void> {
  try {
    await appendDesktopChannelLog('desktop-main', level, message);
  } catch {
    // Avoid masking the original startup failure.
  }
}

async function logDesktopInfo(message: string): Promise<void> {
  await appendDesktopLog('INFO', message);
}

async function logDesktopError(error: unknown): Promise<void> {
  await appendDesktopLog('ERROR', serializeError(error));
}

async function logDesktopRendererChannel(
  channel: 'desktop-preload' | 'desktop-renderer',
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
): Promise<void> {
  try {
    await appendDesktopChannelLog(channel, level, message);
  } catch {
    // Avoid crashing if diagnostics logging fails.
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isExternalRef(ref: string): boolean {
  return /^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:');
}

async function rendererAssetChecks(indexPath: string): Promise<StartupCheck[]> {
  const checks: StartupCheck[] = [];
  const html = await fs.readFile(indexPath, 'utf8');
  const refs = [
    ...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"'#?]+)[^"']*["']/gi),
  ]
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);

  for (const ref of refs) {
    if (isExternalRef(ref)) {
      continue;
    }
    if (ref.startsWith('/')) {
      checks.push({
        name: `Renderer asset ${ref}`,
        ok: false,
        detail: 'Packaged renderer assets must stay relative under file://.',
      });
      continue;
    }
    const resolved = path.resolve(path.dirname(indexPath), ref);
    checks.push({
      name: `Renderer asset ${ref}`,
      ok: await pathExists(resolved),
      detail: resolved,
    });
  }

  if (refs.length === 0) {
    checks.push({
      name: 'Renderer asset references',
      ok: false,
      detail: 'No script or stylesheet references were found in dist/index.html.',
    });
  }

  return checks;
}

async function runStartupChecks(runtime: DesktopRuntimePaths): Promise<StartupCheck[]> {
  const checks: StartupCheck[] = [
    {
      name: 'Electron preload',
      ok: await pathExists(runtime.preloadPath),
      detail: runtime.preloadPath,
    },
    {
      name: 'Embedded server entry',
      ok: await pathExists(runtime.serverModulePath),
      detail: runtime.serverModulePath,
    },
    {
      name: 'Desktop services entry',
      ok: await pathExists(runtime.desktopServicesModulePath),
      detail: runtime.desktopServicesModulePath,
    },
  ];

  if (runtime.usesDevServer) {
    checks.push({
      name: 'Renderer mode',
      ok: true,
      detail: `Using development renderer URL ${runtime.rendererUrl}`,
    });
    return checks;
  }

  if (!runtime.rendererEntryPath) {
    checks.push({
      name: 'Renderer entry',
      ok: false,
      detail: 'No renderer entry path was resolved for desktop mode.',
    });
    return checks;
  }

  const rendererExists = await pathExists(runtime.rendererEntryPath);
  checks.push({
    name: 'Renderer entry',
    ok: rendererExists,
    detail: runtime.rendererEntryPath,
  });

  if (rendererExists) {
    checks.push(...(await rendererAssetChecks(runtime.rendererEntryPath)));
  }

  return checks;
}

function buildStartupError(checks: StartupCheck[]): Error {
  const failed = checks.filter((check) => !check.ok);
  const summary = failed.map((check) => `${check.name}: ${check.detail}`).join(' | ');
  return new Error(`Desktop startup self-check failed. ${summary}`);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function importRuntimeModule<T>(modulePath: string): Promise<T> {
  return (await import(pathToFileURL(modulePath).toString())) as T;
}

async function ensureDesktopServer(runtime: DesktopRuntimePaths): Promise<void> {
  if (currentServerUrl) {
    return;
  }

  configureDesktopEnv(runtime);
  const port = Number(process.env.PORT || 4174);
  await logDesktopInfo(`Booting TEXOR desktop in ${runtime.mode} mode.`);

  if (!desktopApi || !texorServer) {
    desktopApi = await importRuntimeModule<DesktopApiModule>(runtime.desktopServicesModulePath);
    texorServer = await importRuntimeModule<ServerModule>(runtime.serverModulePath);
  }

  if (!texorServer) {
    throw new Error('TEXOR desktop server module failed to load.');
  }

  currentServerUrl = `http://127.0.0.1:${port}`;
  process.env.TEXOR_SERVER_URL = currentServerUrl;
  await texorServer.startTexorServer(port);
  await verifyDesktopServerHealth();
  await logDesktopInfo(`Embedded server is healthy at ${currentServerUrl}.`);
}

async function verifyDesktopServerHealth(): Promise<void> {
  if (!currentServerUrl) {
    throw new Error('Desktop server URL is unavailable.');
  }
  const response = await fetchWithTimeout(`${currentServerUrl}/api/health`, SERVER_HEALTH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Desktop server health check failed with HTTP ${response.status}.`);
  }
}

function renderDiagnosticsHtml(state: StartupFailureState): string {
  const checks = state.checks.length
    ? state.checks
        .map(
          (check) =>
            `<tr><td>${escapeHtml(check.name)}</td><td class="${check.ok ? 'ok' : 'bad'}">${check.ok ? 'OK' : 'FAIL'}</td><td>${escapeHtml(check.detail)}</td></tr>`,
        )
        .join('')
    : '<tr><td>Startup</td><td class="bad">FAIL</td><td>No startup checks were recorded.</td></tr>';

  const runtime = cachedRuntimePaths;
  const details = [
    runtime ? `Mode: ${runtime.mode}` : null,
    currentServerUrl ? `Server URL: ${currentServerUrl}` : null,
    `Log file: ${logTargetPath()}`,
    runtime?.rendererEntryPath ? `Renderer entry: ${runtime.rendererEntryPath}` : null,
    runtime ? `Preload: ${runtime.preloadPath}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>TEXOR Startup Diagnostics</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f5f7fb;
        color: #122033;
      }
      body {
        margin: 0;
        padding: 28px;
        background:
          radial-gradient(circle at top right, rgba(251, 191, 36, 0.18), transparent 35%),
          linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
      }
      .card {
        max-width: 920px;
        margin: 0 auto;
        padding: 28px 30px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.14);
      }
      .eyebrow {
        display: inline-flex;
        gap: 10px;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        background: #e0e7ff;
        color: #4338ca;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      h1 {
        margin: 18px 0 10px;
        font-size: 28px;
      }
      p {
        margin: 0 0 16px;
        line-height: 1.6;
        color: #334155;
      }
      pre {
        margin: 0;
        padding: 14px 16px;
        border-radius: 12px;
        background: #0f172a;
        color: #e2e8f0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 12px;
        line-height: 1.5;
      }
      table {
        width: 100%;
        margin-top: 18px;
        border-collapse: collapse;
      }
      th, td {
        padding: 11px 12px;
        border-bottom: 1px solid #e2e8f0;
        text-align: left;
        vertical-align: top;
        font-size: 13px;
      }
      th {
        color: #475569;
        font-weight: 700;
      }
      .ok {
        color: #047857;
        font-weight: 700;
      }
      .bad {
        color: #b91c1c;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="eyebrow"><span>TEXOR</span><span>Startup Diagnostics</span></div>
      <h1>${escapeHtml(state.title)}</h1>
      <p>${escapeHtml(readableStartupMessage(state.error))}</p>
      <pre>${escapeHtml(details)}</pre>
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>${checks}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

function readableStartupMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function createDiagnosticsWindow(state: StartupFailureState): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 840,
    minHeight: 640,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderDiagnosticsHtml(state))}`);
  return win;
}

async function waitForRendererReady(win: BrowserWindow): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Renderer did not signal readiness within ${RENDERER_READY_TIMEOUT_MS}ms.`));
    }, RENDERER_READY_TIMEOUT_MS);

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      ipcMain.off('texor:renderer-ready', onRendererReady);
      win.webContents.off('did-fail-load', onDidFailLoad);
      win.off('closed', onClosed);
    };

    const onRendererReady = (event: Electron.IpcMainEvent) => {
      if (event.sender.id !== win.webContents.id) {
        return;
      }
      cleanup();
      resolve();
    };

    const onDidFailLoad = (_event: Electron.Event, errorCode: number, errorDescription: string, validatedUrl: string, isMainFrame: boolean) => {
      if (!isMainFrame) {
        return;
      }
      cleanup();
      reject(new Error(`Renderer failed to load ${validatedUrl}: [${errorCode}] ${errorDescription}`));
    };

    const onClosed = () => {
      cleanup();
      reject(new Error('Renderer window closed before startup completed.'));
    };

    ipcMain.on('texor:renderer-ready', onRendererReady);
    win.webContents.on('did-fail-load', onDidFailLoad);
    win.on('closed', onClosed);
  });
}

async function createWorkspaceWindow(paperId?: string): Promise<BrowserWindow> {
  const runtime = resolveRuntimePaths();
  const bootstrapSessionKey = crypto.randomUUID();
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#eef1f5',
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [
        ...(currentServerUrl ? [`--texor-server-url=${currentServerUrl}`] : []),
        `--texor-desktop-log-path=${runtime.logPath}`,
        `--texor-window-session-key=${bootstrapSessionKey}`,
      ],
    },
  });
  windowSessionKeyByWindowId.set(win.id, bootstrapSessionKey);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  const sessionKey = ensureWindowSessionKey(win);
  const url = new URL(runtime.rendererUrl);
  if (paperId) {
    url.searchParams.set('paperId', paperId);
  }
  url.searchParams.set('windowSessionKey', sessionKey);

  await logDesktopInfo(`Loading renderer at ${url.toString()}.`);
  await logDesktopInfo(`Window ${win.id} using window session ${sessionKey}.`);
  await win.loadURL(url.toString());
  await waitForRendererReady(win);
  await logDesktopInfo(`Renderer is ready for window ${win.id}.`);
  win.on('closed', () => {
    windowSessionKeyByWindowId.delete(win.id);
  });
  return win;
}

async function bootWorkspaceWindow(paperId?: string): Promise<BrowserWindow> {
  const runtime = resolveRuntimePaths();
  configureDesktopEnv(runtime);
  const checks = await runStartupChecks(runtime);
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw Object.assign(buildStartupError(checks), { startupChecks: checks });
  }
  await ensureDesktopServer(runtime);
  startupFailure = null;
  return createWorkspaceWindow(paperId);
}

function startupChecksFromError(error: unknown): StartupCheck[] {
  if (error && typeof error === 'object' && 'startupChecks' in error) {
    const checks = (error as { startupChecks?: StartupCheck[] }).startupChecks;
    if (Array.isArray(checks)) {
      return checks;
    }
  }
  return [];
}

async function showStartupFailure(title: string, error: unknown, checks: StartupCheck[] = []): Promise<BrowserWindow> {
  startupFailure = { title, error, checks };
  await logDesktopError(error);
  await logDesktopInfo(`Diagnostics available at ${logTargetPath()}.`);
  return createDiagnosticsWindow(startupFailure);
}

async function openWindowOrDiagnostics(paperId?: string): Promise<BrowserWindow> {
  try {
    return await bootWorkspaceWindow(paperId);
  } catch (error) {
    return showStartupFailure('TEXOR could not finish desktop startup.', error, startupChecksFromError(error));
  }
}

app.whenReady().then(async () => {
  try {
    await openWindowOrDiagnostics();

    ipcMain.handle('texor:desktop-bootstrap', async (event: IpcMainInvokeEvent) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return desktopApi?.desktopBootstrap(currentServerUrl, {
        windowSessionKey: win ? ensureWindowSessionKey(win) : undefined,
      });
    });
    ipcMain.handle('texor:import-vscode-config', async () => desktopApi?.importVSCodeUserConfig());
    ipcMain.handle('texor:list-ssh-hosts', async () => desktopApi?.listSSHHosts());
    ipcMain.handle('texor:prepare-project-target', async (_event: IpcMainInvokeEvent, target: ProjectExecutionTarget) => desktopApi?.prepareExecutionTarget(target));
    ipcMain.handle(
      'texor:diagnostic-log',
      async (
        _event: IpcMainInvokeEvent,
        payload: { stream?: 'desktop-preload' | 'desktop-renderer'; level?: 'INFO' | 'WARN' | 'ERROR'; message?: string },
      ) => {
        if (!payload.stream || !payload.message?.trim()) {
          return false;
        }
        await logDesktopRendererChannel(payload.stream, payload.level || 'INFO', payload.message.trim());
        return true;
      },
    );
    ipcMain.handle('texor:open-window', async (_event: IpcMainInvokeEvent, paperId?: string) => {
      const win = await openWindowOrDiagnostics(paperId);
      return win.id;
    });

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (startupFailure) {
          await createDiagnosticsWindow(startupFailure);
          return;
        }
        await openWindowOrDiagnostics();
      }
    });
  } catch (error) {
    await showStartupFailure('TEXOR hit an unexpected desktop startup failure.', error);
  }
});

app.on('render-process-gone', async (_event, _webContents, details) => {
  await logDesktopError(new Error(`renderer-process-gone: ${details.reason}`));
});

app.on('child-process-gone', async (_event, details) => {
  await logDesktopError(new Error(`child-process-gone: ${details.type}:${details.reason}`));
});

process.on('uncaughtException', (error) => {
  void logDesktopError(error);
});

process.on('unhandledRejection', (reason) => {
  void logDesktopError(reason);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
