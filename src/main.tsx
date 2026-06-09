import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

function logRendererDiagnostic(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
  void window.texorDesktop?.logDiagnostic?.({
    stream: 'desktop-renderer',
    level,
    message,
  });
}

window.addEventListener('error', (event) => {
  logRendererDiagnostic('ERROR', `window error | ${event.message} | ${event.filename}:${event.lineno}:${event.colno}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason);
  logRendererDiagnostic('ERROR', `unhandled rejection | ${reason}`);
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

window.setTimeout(() => {
  logRendererDiagnostic('INFO', 'renderer ready handshake sent');
  window.texorDesktop?.notifyReady?.();
}, 0);
