import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
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

/**
 * Emit `/version.json` holding the same string that gets compiled into the
 * bundle as `__BUILD_VERSION__`. The client-side version guard
 * (`state/versionGuard.ts`) compares the two: a running bundle older than the
 * served version means the document came from a stale HTTP cache, and the
 * guard reloads to catch up. Written as an asset so it lands next to
 * index.html and inherits its `no-cache` header from Caddy.
 */
function emitVersionJson(version: string): PluginOption {
  return {
    name: 'narrative-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version }) + '\n',
      })
    },
  }
}

/**
 * Resolved once and shared by the `__BUILD_VERSION__` define and the
 * `version.json` asset. They MUST agree: the version guard treats any
 * difference as "this document is stale" and reloads.
 */
const BUILD_VERSION = process.env['VITE_BUILD_VERSION'] ?? resolveBuildVersion()

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
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
    __BUILD_MODE__: JSON.stringify(mode),
  },
  plugins: [tailwindcss(), react(), emitVersionJson(BUILD_VERSION)],
  resolve: {
    alias: {
      '@narrative/animation': path.resolve(__dirname, '../../packages/animation/src/index.ts'),
      '@narrative/commands': path.resolve(__dirname, '../../packages/commands/src/index.ts'),
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
      // MinIO direct access for the progressive playback MP4 + poster/thumb.
      // Same-origin via Vite avoids CORS headaches; MinIO honours HTTP
      // byte-range requests so a plain <video src> can seek through the proxy.
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
    // Emit sourcemaps for Sentry uploads but strip the sourceMappingURL comment
    // from the shipped JS so maps aren't fetched by browsers / scrapers. Sentry
    // CLI (or release plugin) reads dist/**/*.map directly during deploy.
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        // Vendor splitting: Pixi, GSAP, Tiptap+ProseMirror, Yjs, Radix,
        // Sentry, React all into their own chunks so the initial download is
        // smaller and a change to any one of them doesn't bust the app cache
        // for the others. Rollup will still hoist common deps out into a
        // shared chunk where appropriate.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          // Pixi core + filters — large WebGL renderer
          if (/[\\/]node_modules[\\/](pixi\.js|pixi-filters|@pixi)[\\/]/.test(id)) {
            return 'vendor-pixi'
          }
          // GSAP animation engine
          if (/[\\/]node_modules[\\/]gsap[\\/]/.test(id)) {
            return 'vendor-gsap'
          }
          // Tiptap + the ProseMirror packages it pulls in transitively
          if (/[\\/]node_modules[\\/](@tiptap|prosemirror-)/.test(id)) {
            return 'vendor-tiptap'
          }
          // Yjs + Hocuspocus provider + y-prosemirror binding — CRDT layer
          if (
            /[\\/]node_modules[\\/](yjs|y-prosemirror|@hocuspocus|y-protocols|lib0)[\\/]/.test(id)
          ) {
            return 'vendor-yjs'
          }
          // Radix primitives — many small packages, group as one
          if (/[\\/]node_modules[\\/]@radix-ui[\\/]/.test(id)) {
            return 'vendor-radix'
          }
          // Sentry browser SDK
          if (/[\\/]node_modules[\\/]@sentry[\\/]/.test(id)) {
            return 'vendor-sentry'
          }
          // React + router — kept together so React's many internal chunks
          // don't fragment into N tiny files.
          if (
            /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
              id,
            )
          ) {
            return 'vendor-react'
          }
          // Everything else from node_modules → shared "vendor" chunk.
          return 'vendor'
        },
      },
    },
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
