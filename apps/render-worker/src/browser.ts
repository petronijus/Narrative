/**
 * browser.ts — one Chromium, started when a job needs it and quit when none
 * has for `idleMs` (docs/plans/a3-render-worker.md, "Memory": zero cost
 * between agent sessions, warm during one).
 *
 * Which Chromium: RENDER_CHROME_EXECUTABLE when it is set (that one only, no
 * fallback); else Playwright's headless shell (installed in the image); else,
 * when Playwright has no browser on this machine, a system Chrome or Chromium
 * (stable channels first) — on machines Playwright ships no build for
 * (Ubuntu 26.04, Arch) the worker runs in development with what the e2e suite
 * uses there.
 *
 * Isolation. The page renders content other people wrote (their text, fonts
 * and pictures), so a renderer bug must not become code running with the
 * worker's reach:
 *   - Chromium's sandbox is ON (`chromiumSandbox: true`; Playwright's default
 *     is off and passes --no-sandbox): renderers run in their own user and
 *     PID namespaces under Chromium's seccomp-bpf filter. In Docker that needs
 *     the container's seccomp profile to allow user namespaces
 *     (docker-compose.prod.yml);
 *   - with `requireSandbox` (production) the worker checks, after every
 *     launch, that renderers really are in another user namespace, and
 *     refuses to render otherwise;
 *   - Chromium gets a minimal environment — none of the worker's variables
 *     (the Redis URL among them) reach it;
 *   - the worker holds no storage credentials at all (it uploads through
 *     presigned URLs), and its container sees only Caddy and the media Redis.
 *
 * WebGL always goes through SwiftShader (software): the production VM has no
 * GPU, and forcing it everywhere keeps a render the same on every machine.
 * `--enable-unsafe-swiftshader` lets current Chrome fall back to it; it is
 * safe enough here only because of the sandbox above.
 */

import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { chromium, type Browser, type LaunchOptions } from 'playwright-core'

export interface BrowserHolderOptions {
  idleMs: number
  chromeExecutable: string | null
  /** Refuse to render unless the renderers are sandboxed (production). */
  requireSandbox: boolean
  log: (message: string) => void
}

const ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  // One renderer process: the worker renders one page at a time.
  '--renderer-process-limit=1',
  // Docker's /dev/shm is 64 MB by default; Chromium falls back to /tmp.
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--mute-audio',
]

/** All Chromium sees of the environment. */
const BROWSER_ENV = { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', TZ: 'UTC' }

export const SYSTEM_CHROMES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-beta',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

/**
 * Whether every renderer process of this machine runs in another user
 * namespace than the worker — Chromium's namespace sandbox. Linux only (reads
 * /proc); null where it cannot tell (no /proc, no renderer found).
 */
export function renderersSandboxed(procRoot = '/proc'): boolean | null {
  let own: string
  try {
    own = readlinkSync(`${procRoot}/self/ns/user`)
  } catch {
    return null
  }
  let renderers = 0
  for (const pid of readdirSync(procRoot).filter((p) => /^\d+$/.test(p))) {
    let cmdline: string
    try {
      cmdline = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8')
    } catch {
      continue
    }
    if (!cmdline.includes('--type=renderer')) continue
    renderers += 1
    if (cmdline.includes('--no-sandbox')) return false
    try {
      if (readlinkSync(`${procRoot}/${pid}/ns/user`) === own) return false
    } catch {
      // The process ended; nothing to judge.
    }
  }
  return renderers > 0 ? true : null
}

export class BrowserHolder {
  private browser: Promise<Browser> | null = null
  private active = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: BrowserHolderOptions) {}

  /**
   * Run `fn` with the browser, starting it if needed (a start this call
   * begins gives up after `launchTimeoutMs`); it quits `idleMs` after the
   * last use.
   */
  async use<T>(
    fn: (browser: Browser) => Promise<T>,
    opts?: { launchTimeoutMs?: number },
  ): Promise<T> {
    this.active += 1
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    try {
      return await fn(await this.get(opts?.launchTimeoutMs))
    } finally {
      this.active -= 1
      if (this.active === 0) {
        this.idleTimer = setTimeout(() => void this.close('idle'), this.opts.idleMs)
        this.idleTimer.unref()
      }
    }
  }

  async close(why: string): Promise<void> {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const pending = this.browser
    this.browser = null
    if (pending === null) return
    try {
      await (await pending).close()
      this.opts.log(`browser closed (${why})`)
    } catch {
      // It was gone already.
    }
  }

  private get(launchTimeoutMs?: number): Promise<Browser> {
    if (this.browser === null) {
      const launching = this.launch(launchTimeoutMs)
      this.browser = launching
      // A crashed or closed browser is replaced on the next use.
      launching.then(
        (browser) =>
          browser.on('disconnected', () => {
            if (this.browser === launching) this.browser = null
          }),
        () => {
          if (this.browser === launching) this.browser = null
        },
      )
    }
    return this.browser
  }

  private async launch(timeoutMs?: number): Promise<Browser> {
    const started = Date.now()
    const attempt = async (options: LaunchOptions, label: string): Promise<Browser> => {
      const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        env: BROWSER_ENV,
        args: ARGS,
        // Playwright's default is 180 s; a job's own deadline is far shorter.
        ...(timeoutMs !== undefined
          ? { timeout: Math.max(1, timeoutMs - (Date.now() - started)) }
          : {}),
        ...options,
      })
      try {
        await this.checkSandbox(browser)
      } catch (err) {
        await browser.close().catch(() => undefined)
        throw err
      }
      this.opts.log(`browser started: ${label} ${browser.version()} in ${Date.now() - started} ms`)
      return browser
    }
    if (this.opts.chromeExecutable !== null) {
      return attempt({ executablePath: this.opts.chromeExecutable }, this.opts.chromeExecutable)
    }
    try {
      return await attempt({}, 'Playwright headless shell')
    } catch (err) {
      // Only a missing Playwright browser falls back; a sandbox failure does not.
      if (!(err instanceof Error) || !/Executable doesn't exist/.test(err.message)) throw err
      const system = SYSTEM_CHROMES.find((path) => existsSync(path))
      if (system === undefined) throw err
      this.opts.log(`no Playwright browser on this machine; using ${system}`)
      return attempt({ executablePath: system }, system)
    }
  }

  /** With `requireSandbox`, a renderer must exist and run in another user namespace. */
  private async checkSandbox(browser: Browser): Promise<void> {
    if (!this.opts.requireSandbox) return
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto('about:blank')
      const sandboxed = renderersSandboxed()
      if (sandboxed !== true) {
        throw new Error(
          `Chromium's sandbox is not active (renderers sandboxed: ${String(sandboxed)}); refusing to render`,
        )
      }
    } finally {
      await context.close().catch(() => undefined)
    }
  }
}
