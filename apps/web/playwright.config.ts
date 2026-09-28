import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E config for Narrative editor.
 *
 * Assumes backend services (docker compose: postgres, minio, imgproxy, media-redis,
 * video-worker) and the dev API server are already running. Playwright itself
 * starts Vite via `webServer`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
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
      use: {
        ...devices['Desktop Chrome'],
        // Allow CI / local envs that can't use bundled Playwright chromium (e.g.
        // Ubuntu 26.04 pre-release) to fall back to a system-installed Chrome.
        // A binary path is a launch option (`use.executablePath` is not one).
        ...(process.env.PLAYWRIGHT_CHROME_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE } }
          : process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === '1'
            ? { channel: 'chrome' }
            : {}),
      },
    },
  ],
})
