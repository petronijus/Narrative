/**
 * config.ts — the render worker's environment.
 *
 *   MEDIA_REDIS_URL (or REDIS_URL)  the media pipeline's Redis (BullMQ)
 *   RENDER_APP_ORIGIN               the origin the render page is opened on:
 *                                   production `https://<domain>` (the real
 *                                   origin, so the CSP, the signed media URLs
 *                                   and the cookies' scope are exactly a
 *                                   visitor's); development
 *                                   `http://localhost:5173` (Vite)
 *   RENDER_UPSTREAM                 where requests to that origin really go,
 *                                   when set: production `http://caddy`
 *                                   inside the compose network, so nothing
 *                                   travels out through Cloudflare and back
 *                                   (routing.ts); unset → straight to the
 *                                   origin (development)
 *   RENDER_IDLE_MS                  Chromium quits after this long without a
 *                                   job (default 60 s); a page kept for a
 *                                   render session closes after as long
 *   RENDER_WARM_PAGES               pages kept open between jobs, one per
 *                                   render session (default 1; 0 opens a
 *                                   page per job). Each costs memory beside
 *                                   the 1200 MB the container may use
 *   RENDER_CHROME_EXECUTABLE        a Chrome / Chromium binary to use instead
 *                                   of Playwright's headless shell (machines
 *                                   Playwright ships no build for)
 *   RENDER_REQUIRE_SANDBOX=1        refuse to render unless Chromium's
 *                                   sandbox is active (production; browser.ts)
 *
 * No storage credentials: the PNGs go up through presigned URLs in each job.
 */

export interface RenderWorkerConfig {
  redisUrl: string
  appOrigin: string
  upstream: string | null
  idleMs: number
  warmPages: number
  chromeExecutable: string | null
  requireSandbox: boolean
}

function originOf(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} is not a URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be http(s): ${value}`)
  }
  return url.origin
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RenderWorkerConfig {
  const redisUrl = env['MEDIA_REDIS_URL'] ?? env['REDIS_URL']
  if (!redisUrl) throw new Error('MEDIA_REDIS_URL (or REDIS_URL) is required')
  const idleMs = Number(env['RENDER_IDLE_MS'] ?? 60_000)
  if (!Number.isFinite(idleMs) || idleMs < 1_000) {
    throw new Error(`RENDER_IDLE_MS must be at least 1000: ${env['RENDER_IDLE_MS']}`)
  }
  const warmPages = Number(env['RENDER_WARM_PAGES'] ?? 1)
  if (!Number.isInteger(warmPages) || warmPages < 0 || warmPages > 4) {
    throw new Error(`RENDER_WARM_PAGES must be 0–4: ${env['RENDER_WARM_PAGES']}`)
  }
  return {
    redisUrl,
    appOrigin: originOf(env['RENDER_APP_ORIGIN'] ?? 'http://localhost:5173', 'RENDER_APP_ORIGIN'),
    upstream: env['RENDER_UPSTREAM'] ? originOf(env['RENDER_UPSTREAM'], 'RENDER_UPSTREAM') : null,
    idleMs,
    warmPages,
    chromeExecutable: env['RENDER_CHROME_EXECUTABLE'] || null,
    requireSandbox: env['RENDER_REQUIRE_SANDBOX'] === '1',
  }
}
