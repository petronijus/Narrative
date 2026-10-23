import os from 'node:os'
import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E config for Narrative editor.
 *
 * Assumes backend services (docker compose: postgres, minio, imgproxy, media-redis,
 * video-worker), the dev API server and Vite are already running (`just dev`).
 *
 * Parallelism: every spec runs alongside others, as the same `dev-user`,
 * against one server and one database — so a spec seeds its own folders,
 * decks, components and tokens through the API, finds them by the ids it got
 * back (never by position in, or the length of, a user-wide list such as all
 * folders, decks, tokens, connections or Drafts), and gives what it creates a
 * unique name. Tests in a file run in parallel too (`fullyParallel`): no test
 * may rely on another having run first. A spec that genuinely cannot share the
 * machine — it measures CPU or frame timing, or changes user-wide state
 * another spec reads — carries the `@serial` tag (`test.describe('…',
 * { tag: '@serial' }, …)`) and runs in the `serial` project, one test at a
 * time, after the parallel project has finished. `PW_WORKERS` (or
 * `--workers`) overrides the worker count.
 *
 * The default is a worker per four hardware threads: each worker is a
 * Chromium with a WebGL canvas, and the dev server and Postgres share the
 * machine. 6 on the 24-thread Linux desktop (the measured optimum,
 * docs/plans/dev-speed.md); 3 on the 12-thread MacBook, where 6 workers ran
 * the suite at a load of 60 and timed out half of it (2026-10-07).
 */
const PW_WORKERS = process.env['PW_WORKERS']
const WORKERS =
  PW_WORKERS === undefined || PW_WORKERS === ''
    ? Math.max(1, Math.floor(os.availableParallelism() / 4))
    : /%$/.test(PW_WORKERS)
      ? PW_WORKERS
      : Number(PW_WORKERS)

const chrome = {
  ...devices['Desktop Chrome'],
  // Allow CI / local envs that can't use bundled Playwright chromium (e.g.
  // Ubuntu 26.04 pre-release) to fall back to a system-installed Chrome.
  // A binary path is a launch option (`use.executablePath` is not one).
  ...(process.env.PLAYWRIGHT_CHROME_EXECUTABLE
    ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE } }
    : process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === '1'
      ? { channel: 'chrome' }
      : {}),
}

/**
 * The origin the specs open. The Vite dev server by default; `just perf
 * --mode prod|profiling` points it at a `vite preview` of a production build
 * on a free port (the preview reuses the dev server's proxies, so the build
 * talks to the same dev backend), and `just perf-compare` at each side's.
 */
const BASE_URL = process.env['PW_BASE_URL'] || 'http://localhost:5173'

const DESKTOP = [/desktop-.*\.spec\.ts$/, /desktop\.setup\.ts$/]

/**
 * One retry in the browser projects — for a network change only. A network
 * change under the browser (a tethered phone re-attaching) makes Chrome
 * abort every request in flight, localhost included, and fails whatever
 * test was loading something. The `test` of e2e/fixtures/test.ts lets a
 * retry run only when the failed attempt coincided with one (and labels it
 * `network-change`); any other failure's retry stops at once, so the test
 * still fails in the report — `retries` is a global knob, the fixture is
 * what makes it targeted. The Electron specs use their own `test` and the
 * perf scenarios their own discard-and-rerun (packages/perf/README.md → Run
 * validity): neither retries.
 */
const NETWORK_CHANGE_RETRIES = 1

/**
 * The layer I perf scenarios (e2e/perf/, docs/plans/perf-harness.md) run in
 * projects of their own, one at a time, and only when `just perf` asks
 * (PERF_RUN=1; they skip otherwise).
 */
const PERF = /[\\/]e2e[\\/]perf[\\/]/
const PERF_SPECS = /[\\/]e2e[\\/]perf[\\/][^\\/]+\.spec\.ts$/

const webkit = {
  ...devices['Desktop Safari'],
  // The Chromium run is at 1×; compare the engines, not the
  // screens (Safari's profile emulates a 2× Retina display).
  deviceScaleFactor: 1,
  // Safari's user agent names a Mac, so the editor would take ⌘
  // as Mod while Playwright's ControlOrMeta sends Ctrl on a
  // Linux host. Off a Mac, WebKit says where it really runs.
  ...(os.platform() === 'darwin'
    ? {}
    : {
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
      }),
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  workers: WORKERS,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Video recording requires Playwright's bundled ffmpeg. On unsupported OS
    // versions (e.g. Ubuntu 26.04) set PLAYWRIGHT_NO_VIDEO=1 to skip it.
    video: process.env.PLAYWRIGHT_NO_VIDEO === '1' ? 'off' : 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      grepInvert: /@serial/,
      testIgnore: [...DESKTOP, PERF],
      retries: NETWORK_CHANGE_RETRIES,
      use: chrome,
    },
    {
      name: 'serial',
      grep: /@serial/,
      testIgnore: [...DESKTOP, PERF],
      dependencies: ['chromium'],
      workers: 1,
      fullyParallel: false,
      retries: NETWORK_CHANGE_RETRIES,
      use: chrome,
    },
    // The desktop shell (ADR 0015; e2e/fixtures/desktop.ts): bundled once,
    // then driven through Playwright's Electron support, each worker on its
    // own Xvfb. Specs that load the editor need the dev stack like the rest.
    { name: 'desktop-build', testMatch: /desktop\.setup\.ts$/ },
    {
      name: 'electron',
      testMatch: /desktop-.*\.spec\.ts$/,
      dependencies: ['desktop-build'],
    },
    // Perf scenarios: alone on the machine (they time frames), no tracing or
    // video (Playwright's per-action DOM snapshots are a forced layout each).
    {
      name: 'perf',
      testMatch: PERF_SPECS,
      workers: 1,
      fullyParallel: false,
      use: { ...chrome, trace: 'off', video: 'off', screenshot: 'off' },
    },
    // The editor in WebKit — the engine of Safari and of a macOS WKWebView,
    // which a Tauri shell would use. Opt-in (`just e2e-webkit`): the editor is
    // built for Chromium, and this measures how far WebKit is from it.
    ...(process.env['PW_WEBKIT'] === '1'
      ? [
          {
            name: 'webkit',
            grepInvert: /@serial/,
            // The desktop shell's own specs drive Electron, not a browser engine.
            testIgnore: [...DESKTOP, PERF],
            retries: NETWORK_CHANGE_RETRIES,
            use: webkit,
          },
          {
            name: 'perf-webkit',
            testMatch: PERF_SPECS,
            workers: 1,
            fullyParallel: false,
            use: {
              ...webkit,
              trace: 'off' as const,
              video: 'off' as const,
              screenshot: 'off' as const,
            },
          },
        ]
      : []),
  ],
})
