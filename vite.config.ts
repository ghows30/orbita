import { defineConfig } from 'vite';

// In sviluppo Vite gira su :5173 e inoltra API/stream al server ORBITA su :7878
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7878',
      '/p/': 'http://127.0.0.1:7878',
      '/logo': 'http://127.0.0.1:7878',
    },
  },
  // chrome69: WebView delle Fire TV più vecchie (Fire OS 6); esbuild riscrive la sintassi moderna
  build: { target: ['es2019', 'chrome69'], sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: 'node', setupFiles: ['tests/setup.ts'] },
} as never);
