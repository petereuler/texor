import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBootstrap, ProjectExecutionTarget, SSHHostProfile, VSCodeImportBundle } from '../src/types.js';

const desktopLogPath = process.argv.find((arg) => arg.startsWith('--texor-desktop-log-path='))?.slice('--texor-desktop-log-path='.length);
const windowSessionKey = process.argv.find((arg) => arg.startsWith('--texor-window-session-key='))?.slice('--texor-window-session-key='.length);

const api = {
  bootstrap: (): Promise<DesktopBootstrap> => ipcRenderer.invoke('texor:desktop-bootstrap'),
  importVSCodeConfig: (): Promise<VSCodeImportBundle | null> => ipcRenderer.invoke('texor:import-vscode-config'),
  listSSHHosts: (): Promise<SSHHostProfile[]> => ipcRenderer.invoke('texor:list-ssh-hosts'),
  prepareProjectTarget: (target: ProjectExecutionTarget) => ipcRenderer.invoke('texor:prepare-project-target', target),
  openWindow: (paperId?: string): Promise<number> => ipcRenderer.invoke('texor:open-window', paperId),
  logDiagnostic: (payload: { stream: 'desktop-preload' | 'desktop-renderer'; level?: 'INFO' | 'WARN' | 'ERROR'; message: string }): Promise<boolean> =>
    ipcRenderer.invoke('texor:diagnostic-log', payload),
  notifyReady: (): void => {
    ipcRenderer.send('texor:renderer-ready');
  },
  windowSessionKey,
};

contextBridge.exposeInMainWorld('texorDesktop', api);
contextBridge.exposeInMainWorld('__TEXOR_SERVER_URL__', process.argv.find((arg) => arg.startsWith('--texor-server-url='))?.slice('--texor-server-url='.length));
contextBridge.exposeInMainWorld('__TEXOR_DESKTOP_LOG_PATH__', desktopLogPath);

void ipcRenderer.invoke('texor:diagnostic-log', {
  stream: 'desktop-preload',
  level: 'INFO',
  message: `preload initialized | server=${process.argv.find((arg) => arg.startsWith('--texor-server-url='))?.slice('--texor-server-url='.length) || 'n/a'} | windowSession=${windowSessionKey || 'n/a'}`,
});
