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

/**
 * `vite build --mode profiling` (docs/plans/perf-harness.md → Decisions): a
 * production build whose React records render timings (`react-dom/profiling`)
 * and whose functions keep their names, so the perf harness's per-component
 * render counts and a CPU profile read like the source. `just perf --mode
 * profiling` builds it with NODE_ENV=production into its own outDir.
 */
const PROFILING_MODE = 'profiling'

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
      ...(mode === PROFILING_MODE ? { 'react-dom/client': 'react-dom/profiling' } : {}),
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
  // `vite preview` of a production build (`just perf --mode prod|profiling`,
  // `just lighthouse`): the routes of production's Caddyfile in front of the
  // dev backend — the build is made with VITE_API_URL=/api and
  // VITE_HOCUSPOCUS_URL=/ws, as production's is, so the page talks to its own
  // origin on any port and needs no CORS entry.
  preview: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
        headers: { 'X-Forwarded-Prefix': '/api' },
      },
      '/ws': {
        target: 'ws://localhost:3002',
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ws/, ''),
      },
      '/imgproxy': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/imgproxy/, ''),
      },
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
        ...(mode === PROFILING_MODE ? { keepNames: true } : {}),
        // Vendor splitting: Pixi, GSAP, Tiptap+ProseMirror, Yjs, Radix,
        // Sentry, React all into their own chunks so the initial download is
        // smaller and a change to any one of them doesn't bust the app cache
        // for the others.
        //
        // A group also takes the dependencies of what it captures (Rolldown's
        // includeDependenciesRecursively), so the order is the priority:
        // libraries other vendors build on (Yjs, React) are captured first,
        // or the group of whoever imports them swallows them — under the
        // old manualChunks function `@tiptap/y-tiptap` pulled yjs and lib0
        // into vendor-tiptap (~86 kB raw), 12.8 kB gz over its budget.
        codeSplitting: {
          groups: [
            // Yjs + Hocuspocus provider + y-prosemirror binding — CRDT layer
            {
              name: 'vendor-yjs',
              test: /[\\/]node_modules[\\/](yjs|y-prosemirror|@hocuspocus|y-protocols|lib0)[\\/]/,
              priority: 70,
            },
            // React + router — kept together so React's many internal chunks
            // don't fragment into N tiny files.
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
              priority: 60,
            },
            // Pixi core + filters — large WebGL renderer
            {
              name: 'vendor-pixi',
              test: /[\\/]node_modules[\\/](pixi\.js|pixi-filters|@pixi)[\\/]/,
              priority: 50,
            },
            // GSAP animation engine
            { name: 'vendor-gsap', test: /[\\/]node_modules[\\/]gsap[\\/]/, priority: 40 },
            // Tiptap + the ProseMirror packages it pulls in transitively
            {
              name: 'vendor-tiptap',
              test: /[\\/]node_modules[\\/](@tiptap|prosemirror-)/,
              priority: 30,
            },
            // Radix primitives — many small packages, group as one
            { name: 'vendor-radix', test: /[\\/]node_modules[\\/]@radix-ui[\\/]/, priority: 20 },
            // Sentry browser SDK
            { name: 'vendor-sentry', test: /[\\/]node_modules[\\/]@sentry[\\/]/, priority: 10 },
            // Everything else from node_modules → shared "vendor" chunk.
            { name: 'vendor', test: /[\\/]node_modules[\\/]/, priority: 0 },
          ],
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
