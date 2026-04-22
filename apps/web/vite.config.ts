import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'node:child_process'

/**
 * Resolve a human-readable build version at Vite config load.
 *
 * Format: `v<major>.<minor>.<commit-count>+<sha>`
 *   - major/minor pulled from package.json (stable, hand-bumped for
 *     intentional releases)
 *   - commit-count = `git rev-list --count HEAD` — monotonically
 *     increases on every commit so the displayed version auto-bumps
 *     without a manual version-bump ritual
 *   - sha = first 7 chars of HEAD commit, so two builds at the same
 *     count still differ when reading it off the UI
 *
 * CI / Dockerfile builds without a `.git` directory fall back to the
 * package.json version with `+build` suffix.
 */
function resolveBuildVersion(): string {
  const pkgVersion: string = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- config-time IO
      return (require('./package.json') as { version?: string }).version ?? '0.0.0'
    } catch {
      return '0.0.0'
    }
  })()
  const [major = '0', minor = '0'] = pkgVersion.split('.')
  try {
    const count = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim()
    const sha = execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim()
    return `v${major}.${minor}.${count}+${sha}`
  } catch {
    return `v${pkgVersion}+build`
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // Load .env from the monorepo root so one .env feeds both apps/server
  // (via Node --env-file) and apps/web (via Vite). Keeps the dev experience
  // to a single file.
  envDir: path.resolve(__dirname, '../..'),
  define: {
    // Injektuje BUILD_VERSION do bundlu — used by the UI version chip and
    // Sentry release tracking. The resolver (above) pulls the commit count
    // + sha at Vite startup; every dev server restart refreshes the number.
    __BUILD_VERSION__: JSON.stringify(process.env['VITE_BUILD_VERSION'] ?? resolveBuildVersion()),
    __BUILD_MODE__: JSON.stringify(mode),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@narrative/animation': path.resolve(__dirname, '../../packages/animation/src/index.ts'),
      '@narrative/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@narrative/slide-model': path.resolve(__dirname, '../../packages/slide-model/src/index.ts'),
      // P1 visual foundation — shadcn/ui convention (components import via `@/lib/utils` etc.)
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/imgproxy': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/imgproxy/, ''),
      },
      // MinIO direct access for HLS manifests + segments. Same-origin via Vite
      // avoids CORS headaches and keeps hls.js happy with the server-returned
      // manifest URL (variant playlists and segments resolve relative to it).
      '/storage': {
        target: `http://localhost:${process.env['MINIO_API_PORT'] ?? '9100'}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/storage/, ''),
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
