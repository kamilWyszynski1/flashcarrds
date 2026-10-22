import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pwaPlugin } from './plugins/pwa';

// The Rust server is the single origin in production (it serves `dist/` and
// `/api`). In development Vite proxies `/api` to it.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), pwaPlugin()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': { target: process.env.FISZKI_API ?? 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  build: { sourcemap: false, target: 'es2020' },
  // vitest
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as Parameters<typeof defineConfig>[0] & { test: unknown });
