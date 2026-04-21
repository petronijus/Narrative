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
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
