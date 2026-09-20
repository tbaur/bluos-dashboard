import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    // Fixed project port (not Vite's 5173 default)
    port: 8765,
    strictPort: true,
    proxy: {
      '/api': {
        // Follows BSD_PORT so a non-default API port still works under `make run`.
        target: `http://127.0.0.1:${process.env.BSD_PORT ?? '8000'}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    // One jsdom import per worker; each file still gets a fresh window.
    pool: 'vmThreads',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts', 'src/version.ts'],
      thresholds: {
        lines: 72,
        functions: 70,
        statements: 72,
        branches: 62,
        // The store holds the optimistic-update and hold-window logic, which is
        // where the subtle races live. Gate it on its own so a global average
        // cannot hide a regression here.
        'src/store/fleetStore.ts': {
          lines: 52,
          functions: 55,
          statements: 52,
          branches: 46,
        },
      },
    },
  },
});
