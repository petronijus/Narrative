/**
 * e2e/fixtures/desktop.ts
 *
 * Playwright fixtures for the desktop shell (apps/desktop, ADR 0014),
 * driven through Playwright's Electron support. Used by the `electron`
 * project's `desktop-*.spec.ts`; the `desktop-build` project bundles the
 * shell first (desktop.setup.ts).
 *
 * - On Linux every worker runs its own Xvfb, so the shell's windows never
 *   appear on the developer's monitors and no real compositor (Hyprland)
 *   is touched. Without Xvfb the specs fail with the install hint — they
 *   never skip. On macOS the windows show briefly.
 * - Every test gets a fresh profile (`NARRATIVE_DESKTOP_USER_DATA`), which
 *   also keeps the shell from registering `narrative-dev://` for real.
 * - `shell.openExternal` is replaced in the main process: the system browser
 *   never opens, and the URLs are recorded for the spec.
 * - `stubServer` serves a minimal Narrative-shaped origin on a random
 *   loopback port, which the shell accepts as a custom server.
 */

import { _electron, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(here, '../../../..')
export const desktopDir = path.join(repoRoot, 'apps/desktop')
const electronBinary = createRequire(path.join(desktopDir, 'package.json'))('electron') as string

/** A request the stub server saw. */
export interface StubRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

export type StubHandler = (req: StubRequest, res: ServerResponse) => boolean | Promise<boolean>

/** The page the stub serves for every path it does not handle itself. */
export const STUB_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Stub Narrative</title></head>
<body><h1>stub</h1><a id="external" href="https://example.com/away">away</a></body></html>`

export interface StubServer {
  origin: string
  requests: StubRequest[]
}

export interface DesktopShell {
  app: ElectronApplication
  window: Page
  /** URLs the shell handed to the system browser. */
  opened(): Promise<string[]>
}

interface WorkerFixtures {
  xvfbDisplay: string | null
}

interface TestFixtures {
  /** A stub server; pass handlers for the paths a spec needs. */
  stubServer: (handler?: StubHandler) => Promise<StubServer>
  /** Start the shell against `server` (an origin, `dev` or `prod`). */
  launchShell: (server: string, extraArgs?: string[]) => Promise<DesktopShell>
}

function startXvfb(): Promise<{ display: string; process: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const xvfb = spawn(
      'Xvfb',
      ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      },
    )
    xvfb.once('error', () =>
      reject(
        new Error(
          'Xvfb is missing: the desktop specs run the shell on a virtual display. ' +
            'Install it (Arch: pacman -S xorg-server-xvfb; Ubuntu: apt install xvfb).',
        ),
      ),
    )
    let out = ''
    xvfb.stdio[3]!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const match = /^(\d+)\n/.exec(out)
      if (match) resolve({ display: `:${match[1]}`, process: xvfb })
    })
  })
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  xvfbDisplay: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      if (process.platform !== 'linux') {
        await provide(null)
        return
      }
      const xvfb = await startXvfb()
      await provide(xvfb.display)
      xvfb.process.kill()
    },
    { scope: 'worker' },
  ],

  // eslint-disable-next-line no-empty-pattern
  stubServer: async ({}, provide) => {
    const servers: Array<ReturnType<typeof createServer>> = []
    await provide(async (handler) => {
      const requests: StubRequest[] = []
      const server = createServer((req, res) => {
        let body = ''
        req.on('data', (c: Buffer) => (body += c.toString()))
        req.on('end', async () => {
          const seen: StubRequest = {
            method: req.method ?? 'GET',
            url: req.url ?? '/',
            headers: req.headers,
            body,
          }
          requests.push(seen)
          if (handler && (await handler(seen, res))) return
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(STUB_PAGE)
        })
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      return { origin: `http://127.0.0.1:${port}`, requests }
    })
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  },

  launchShell: async ({ xvfbDisplay }, provide) => {
    const apps: ElectronApplication[] = []
    const profiles: string[] = []
    await provide(async (server, extraArgs = []) => {
      const profile = mkdtempSync(path.join(tmpdir(), 'narrative-desktop-e2e-'))
      profiles.push(profile)
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== 'WAYLAND_DISPLAY' && k !== 'HYPRLAND_INSTANCE_SIGNATURE')
          env[k] = v
      }
      if (xvfbDisplay !== null) {
        env['DISPLAY'] = xvfbDisplay
        env['XDG_SESSION_TYPE'] = 'x11'
        env['ELECTRON_OZONE_PLATFORM_HINT'] = 'x11'
      }
      env['NARRATIVE_DESKTOP_USER_DATA'] = profile
      const app = await _electron.launch({
        executablePath: electronBinary,
        args: [desktopDir, `--server=${server}`, ...extraArgs],
        cwd: repoRoot,
        // Otherwise Playwright adds --no-sandbox on Linux; the shell must run sandboxed.
        chromiumSandbox: true,
        env,
      })
      apps.push(app)
      await app.evaluate(({ shell }) => {
        const opened: string[] = []
        ;(globalThis as unknown as { __opened: string[] }).__opened = opened
        shell.openExternal = async (url: string) => {
          opened.push(url)
        }
      })
      const window = await app.firstWindow()
      return {
        app,
        window,
        opened: () =>
          app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened),
      }
    })
    for (const app of apps) await app.close().catch(() => undefined)
    for (const profile of profiles) rmSync(profile, { recursive: true, force: true })
  },
})

export { expect } from '@playwright/test'
