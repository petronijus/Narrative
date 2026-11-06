/**
 * e2e/perf/lib/tauriDrive.ts — the Tauri window, for a person and an agent at
 * once (macOS). `just desktop-tauri` runs `serve`: the app in an ordinary window
 * (a person moves, hides and clicks it as any other) with the perf harness's
 * driver behind a socket, and `just tauri <command>` sends it one command.
 * Native input from the driver reaches the page as the person's does. While the
 * window is covered WebKit reports the page hidden and stops painting it: input
 * and scripts still arrive, but `focus` first when the result must be drawn.
 *
 * The socket lives in the user's private temp directory, mode 0600.
 */

import { execFile } from 'node:child_process'
import { chmodSync, existsSync, rmSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { sharedTauriPage } from './tauriPage'

const SOCKET = path.join(os.tmpdir(), 'narrative-tauri-drive.sock')
const BASE_URL = 'http://localhost:5173'

const HELP = `just tauri <command>
  status                  the page's URL and the window's numbers
  goto <path|url>         navigate
  click <x> <y>           click at a point of the page (CSS px)
  dblclick <x> <y>
  drag <x1> <y1> <x2> <y2>
  click-css <selector>    click an element
  click-role <role> [name]
  wheel <x> <y> <dx> <dy>
  type <text>             type into what has focus
  press <combo>           e.g. Meta+z
  eval <expression>       evaluate in the page, print the JSON answer
  shot [file.png]         capture this window, even when covered; print the path
  focus                   bring the window forward; a covered page does not paint
  resize <width> <height>
  quit                    close the app`

type Handler = (args: string[]) => Promise<unknown>

function numbers(args: string[], n: number): number[] {
  const out = args.slice(0, n).map(Number)
  if (out.length !== n || out.some((v) => !Number.isFinite(v)))
    throw new Error(`expected ${n} numbers, got: ${args.join(' ')}`)
  return out
}

async function serve(): Promise<void> {
  if (await answers()) throw new Error('a window is already being driven (`just tauri status`)')
  rmSync(SOCKET, { force: true })
  const { page, command, onExit } = await sharedTauriPage(BASE_URL)

  const handlers: Record<string, Handler> = {
    status: async () => ({
      url: await page.evaluate('location.href'),
      visibility: await page.evaluate('document.visibilityState'),
      window: await command({ op: 'info' }),
    }),
    goto: async ([url]) => {
      if (url === undefined) throw new Error('goto <path|url>')
      await page.goto(url)
      return page.evaluate('location.href')
    },
    click: async (a) => {
      const [x, y] = numbers(a, 2) as [number, number]
      await page.mouse.click(x, y)
    },
    dblclick: async (a) => {
      const [x, y] = numbers(a, 2) as [number, number]
      await page.mouse.dblclick(x, y)
    },
    drag: async (a) => {
      const [x1, y1, x2, y2] = numbers(a, 4) as [number, number, number, number]
      await page.mouse.move(x1, y1)
      await page.mouse.down()
      await page.mouse.move(x2, y2, { steps: 12 })
      await page.mouse.up()
    },
    'click-css': async ([selector]) => {
      if (selector === undefined) throw new Error('click-css <selector>')
      await page.locator(selector).first().click()
    },
    'click-role': async ([role, ...name]) => {
      if (role === undefined) throw new Error('click-role <role> [name]')
      const opts = name.length > 0 ? { name: name.join(' ') } : {}
      await page.getByRole(role, opts).first().click()
    },
    wheel: async (a) => {
      const [x, y, dx, dy] = numbers(a, 4) as [number, number, number, number]
      await page.mouse.move(x, y)
      await page.mouse.wheel(dx, dy)
    },
    type: async (a) => page.keyboard.type(a.join(' ')),
    press: async ([combo]) => {
      if (combo === undefined) throw new Error('press <combo>')
      await page.keyboard.press(combo)
    },
    eval: async (a) => page.evaluate(a.join(' ')),
    shot: async ([file]) => {
      const out = path.resolve(file ?? path.join(os.tmpdir(), `narrative-tauri-${Date.now()}.png`))
      const { windowNumber } = await command<{ windowNumber: number }>({ op: 'info' })
      await promisify(execFile)('screencapture', ['-x', '-o', `-l${windowNumber}`, out])
      return out
    },
    focus: async () => command({ op: 'focus' }),
    resize: async (a) => {
      const [width, height] = numbers(a, 2) as [number, number]
      return command({ op: 'resize', width, height })
    },
    quit: async () => command({ op: 'quit' }),
  }

  const server = createServer((socket) => {
    createInterface({ input: socket }).once('line', (line) => {
      void (async () => {
        try {
          const { name, args } = JSON.parse(line) as { name: string; args: string[] }
          const handler = handlers[name]
          if (handler === undefined) throw new Error(`unknown command: ${name}\n${HELP}`)
          const value = await handler(args)
          socket.end(`${JSON.stringify({ ok: true, value })}\n`)
        } catch (err) {
          socket.end(`${JSON.stringify({ ok: false, error: String(err) })}\n`)
        }
      })()
    })
    socket.on('error', () => undefined)
  })
  server.listen(SOCKET, () => {
    chmodSync(SOCKET, 0o600)
    console.log(`[tauri] the window is yours and drivable: just tauri help`)
  })
  const finish = (): void => {
    rmSync(SOCKET, { force: true })
    process.exit(0)
  }
  onExit(finish)
  // The window stays with the person when this process goes (perf_driver.rs).
  process.once('SIGINT', finish)
  process.once('SIGTERM', finish)
}

/** Whether a server answers on the socket. */
function answers(): Promise<boolean> {
  if (!existsSync(SOCKET)) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = connect(SOCKET)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function send(name: string, args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET)
    socket.once('error', () =>
      reject(new Error('no window is being driven: start it with `just desktop-tauri`')),
    )
    socket.write(`${JSON.stringify({ name, args })}\n`)
    createInterface({ input: socket }).once('line', (line) => {
      const msg = JSON.parse(line) as { ok: boolean; value?: unknown; error?: string }
      if (msg.ok) resolve(msg.value)
      else reject(new Error(msg.error))
    })
  })
}

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2)
  if (name === undefined || name === 'help') return console.log(HELP)
  if (name === 'serve') return serve()
  const value = await send(name, args)
  if (value !== undefined && value !== null)
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
