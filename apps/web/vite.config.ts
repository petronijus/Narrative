import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // Load .env from the monorepo root so one .env feeds both apps/server
  // (via Node --env-file) and apps/web (via Vite). Keeps the dev experience
  // to a single file.
  envDir: path.resolve(__dirname, '../..'),
  define: {
    // Injektuje BUILD_VERSION do bundlu — používá se Sentry release tracking.
    // V CI nastavit přes env VITE_BUILD_VERSION (např. git sha).

    __BUILD_VERSION__: JSON.stringify(
      process.env['VITE_BUILD_VERSION'] ?? (mode === 'production' ? 'prod-unknown' : 'dev'),
    ),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@narrative/animation': path.resolve(__dirname, '../../packages/animation/src/index.ts'),
      '@narrative/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@narrative/slide-model': path.resolve(__dirname, '../../packages/slide-model/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  // top-level await vyžaduje esnext target (Spike A nález: Pixi v8 app.init() je async)
  build: {
    target: 'esnext',
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/renderer/**'],
    },
  },
}))
