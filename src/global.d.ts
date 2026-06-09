/// <reference types="vite/client" />

declare module 'diff' {
  export interface Change {
    added?: boolean;
    removed?: boolean;
    value: string;
    count?: number;
  }

  export function diffWordsWithSpace(oldText: string, newText: string): Change[];
}

interface Window {
  texorDesktop?: {
    bootstrap(): Promise<import('./types').DesktopBootstrap>;
    importVSCodeConfig(): Promise<import('./types').VSCodeImportBundle | null>;
    listSSHHosts(): Promise<import('./types').SSHHostProfile[]>;
    prepareProjectTarget(target: import('./types').ProjectExecutionTarget): Promise<import('./types').DesktopPreparedTarget>;
    openWindow(paperId?: string): Promise<number>;
    logDiagnostic?(payload: { stream: 'desktop-preload' | 'desktop-renderer'; level?: 'INFO' | 'WARN' | 'ERROR'; message: string }): Promise<boolean>;
    notifyReady?(): void;
    windowSessionKey?: string;
  };
  __TEXOR_SERVER_URL__?: string;
  __TEXOR_DESKTOP_LOG_PATH__?: string;
}
