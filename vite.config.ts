import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 4173,
    watch: {
      ignored: ['**/.texor-data/**', '**/dist-server/**', '**/vscode-extension/dist/**'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:4174',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
});
