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

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  workers: WORKERS,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
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
      use: chrome,
    },
    {
      name: 'serial',
      grep: /@serial/,
      dependencies: ['chromium'],
      workers: 1,
      fullyParallel: false,
      use: chrome,
    },
  ],
})
