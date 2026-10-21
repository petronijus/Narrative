/**
 * e2e/perf/lib/tauriPage.ts — the perf benches in the Tauri window
 * (`just perf --shell tauri`, docs/plans/performance.md → W1): the desktop
 * prototype (apps/desktop-tauri, a debug build with the `perf-driver`
 * feature) loads the side's build, and this module drives it the way
 * Playwright drives a page.
 *
 *   - Scripts: the window's page connects to a WebSocket here
 *     (wsServer.ts) and evaluates what it is sent — `evaluate(fn, arg)` as in
 *     Playwright; the in-page harness is read through it unchanged.
 *   - Input: native — keys, the mouse and the wheel go to the app's stdin
 *     and become NSEvents sent through its window (src-tauri/src/perf_driver.rs),
 *     so they cross WebKit's UI process as a person's input does.
 *   - Seeding stays with Playwright: the spec's browser context posts the
 *     scene through the command API and its `request` is what
 *     `page.context()` hands back.
 *
 * `TauriPage` implements the part of Playwright's `Page` the perf specs use
 * (`evaluate`, `goto`, `url`, `waitForTimeout`, `mouse`, `keyboard`,
 * `locator`, `getByRole`, `context`); anything else throws, naming the call
 * (a Proxy), so a spec that needs more fails loudly rather than measuring
 * something else. Its `isTauri` tells the specs what it cannot do: a second
 * window, a fresh context per run, request events.
 *
 * macOS only for now (the native input is AppKit's).
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import { installReactPerfHook } from './reactHook'
import { startWsServer, type WsConnection, type WsServer } from './wsServer'

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))

/** The shell binary: PERF_TAURI_APP, else the debug build of apps/desktop-tauri. */
export function tauriAppPath(): string {
  const env = process.env['PERF_TAURI_APP']
  if (env !== undefined && env !== '') return env
  return path.join(REPO, 'apps/desktop-tauri/src-tauri/target/debug/narrative-desktop-tauri')
}

/** The system WebKit the window draws with (WKWebView is the OS's, not the app's). */
export function systemWebKitVersion(): string {
  try {
    const read = (plist: string, key: string): string =>
      execFileSync('defaults', ['read', plist, key], { encoding: 'utf8' }).trim()
    const webkit = read(
      '/System/Library/Frameworks/WebKit.framework/Resources/Info.plist',
      'CFBundleVersion',
    )
    const safari = read(
      '/Applications/Safari.app/Contents/Info.plist',
      'CFBundleShortVersionString',
    )
    return `${webkit} (Safari ${safari})`
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Keys: Playwright's names → macOS virtual key codes and AppKit characters
// ---------------------------------------------------------------------------

interface KeySpec {
  code: number
  /** What `characters` carries (AppKit's function-key characters for the arrows and friends). */
  chars: string
  /** Arrow and navigation keys come with these flags from a real keyboard. */
  extra?: Modifier[]
}

type Modifier = 'shift' | 'control' | 'alt' | 'meta' | 'function' | 'numericPad'

const MODIFIER_KEYS: Record<string, { code: number; flag: Modifier }> = {
  Shift: { code: 56, flag: 'shift' },
  Control: { code: 59, flag: 'control' },
  Alt: { code: 58, flag: 'alt' },
  Meta: { code: 55, flag: 'meta' },
}

const NAMED: Record<string, KeySpec> = {
  ArrowLeft: { code: 123, chars: '', extra: ['function', 'numericPad'] },
  ArrowRight: { code: 124, chars: '', extra: ['function', 'numericPad'] },
  ArrowDown: { code: 125, chars: '', extra: ['function', 'numericPad'] },
  ArrowUp: { code: 126, chars: '', extra: ['function', 'numericPad'] },
  Home: { code: 115, chars: '', extra: ['function'] },
  End: { code: 119, chars: '', extra: ['function'] },
  PageUp: { code: 116, chars: '', extra: ['function'] },
  PageDown: { code: 121, chars: '', extra: ['function'] },
  Delete: { code: 117, chars: '', extra: ['function'] },
  Backspace: { code: 51, chars: '\u007f' },
  Escape: { code: 53, chars: '\u001b' },
  Enter: { code: 36, chars: '\r' },
  Tab: { code: 48, chars: '\t' },
  ' ': { code: 49, chars: ' ' },
  Space: { code: 49, chars: ' ' },
}

/** The ANSI layout's key codes of the printable keys (unshifted character → code). */
const ANSI: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  '1': 18,
  '2': 19,
  '3': 20,
  '4': 21,
  '6': 22,
  '5': 23,
  '=': 24,
  '9': 25,
  '7': 26,
  '-': 27,
  '8': 28,
  '0': 29,
  ']': 30,
  o: 31,
  u: 32,
  '[': 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ';': 41,
  '\\': 42,
  ',': 43,
  '/': 44,
  n: 45,
  m: 46,
  '.': 47,
  '`': 50,
}
const SHIFTED: Record<string, string> = {
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
}

/** A printable character as a key: its code, and whether it needs Shift. */
function printable(ch: string): { code: number; shift: boolean; base: string } {
  if (ANSI[ch] !== undefined) return { code: ANSI[ch]!, shift: false, base: ch }
  const lower = ch.toLowerCase()
  if (lower !== ch && ANSI[lower] !== undefined)
    return { code: ANSI[lower]!, shift: true, base: lower }
  if (SHIFTED[ch] !== undefined)
    return { code: ANSI[SHIFTED[ch]!]!, shift: true, base: SHIFTED[ch]! }
  if (ch === ' ') return { code: 49, shift: false, base: ' ' }
  // Outside the layout (accents, symbols): the text arrives, the key code is a guess.
  return { code: 0, shift: false, base: ch }
}

/** Playwright's `ControlOrMeta` is Meta on macOS. */
function keyName(name: string): string {
  return name === 'ControlOrMeta' ? 'Meta' : name
}

/**
 * A function's source as an expression the page can evaluate. Transpilers
 * that keep names (esbuild, under tsx) wrap functions in `__name(…)`, which
 * the page does not have: the expression gives the function a no-op one in
 * its closure (Playwright's Babel transform adds none; either works).
 */
function pageSource(fn: (...args: never[]) => unknown): string {
  return `(() => { const __name = (f) => f; return (${fn.toString()}) })()`
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

class TauriApp {
  private nextId = 1
  /** Input and window commands waiting for the app's answer, by id. */
  private readonly acks = new Map<number, Pending>()
  private readonly scripts = new Map<number, Pending>()
  private page: WsConnection | null = null
  private pageHref = ''
  private readonly hellos: Array<(href: string) => void> = []
  /** Input commands waiting for their DOM event: its type, sent no earlier than `after` (epoch ms). */
  private readonly seenWaiters: Array<{ type: string; after: number; resolve: () => void }> = []
  private exited = false

  private constructor(
    private readonly child: ChildProcess,
    private readonly ws: WsServer,
    readonly origin: string,
  ) {}

  static async launch(o: {
    baseURL: string
    viewport: { width: number; height: number }
    initScripts: string[]
  }): Promise<TauriApp> {
    if (process.platform !== 'darwin')
      throw new Error('the Tauri perf driver takes native input on macOS only (perf_driver.rs)')
    const bin = tauriAppPath()
    if (!existsSync(bin))
      throw new Error(
        `no Tauri perf build at ${bin}: cargo build --features perf-driver in apps/desktop-tauri/src-tauri (or PERF_TAURI_APP)`,
      )
    const origin = new URL(o.baseURL).origin
    let app: TauriApp | null = null
    const ws = await startWsServer(origin, (c) => app?.attach(c))
    const dir = mkdtempSync(path.join(os.tmpdir(), 'narrative-tauri-perf-'))
    const files = o.initScripts.map((src, i) => {
      const f = path.join(dir, `init-${i}.js`)
      writeFileSync(f, src)
      return f
    })
    const child = spawn(bin, [`--server=${origin}`], {
      env: {
        ...process.env,
        NARRATIVE_PERF_DRIVER_PORT: String(ws.port),
        NARRATIVE_PERF_VIEWPORT: `${o.viewport.width}x${o.viewport.height}`,
        NARRATIVE_PERF_INIT_SCRIPTS: files.join(':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    app = new TauriApp(child, ws, origin)
    app.listen()
    // The window's first page (the server's root) says hello.
    await app.nextHello(60_000)
    return app
  }

  private listen(): void {
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      let msg: { id?: number; ok?: boolean; value?: unknown; error?: string }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        return
      }
      const p = msg.id === undefined ? undefined : this.acks.get(msg.id)
      if (p === undefined) return
      this.acks.delete(msg.id!)
      if (msg.ok === true) p.resolve(msg.value)
      else p.reject(new Error(`tauri: ${msg.error ?? 'failed'}`))
    })
    createInterface({ input: this.child.stderr! }).on('line', (line) => {
      if (process.env['PERF_VERBOSE'] === '1' || /error|panic/i.test(line))
        console.log(`PERF tauri ${line}`)
    })
    this.child.on('exit', (code) => {
      this.exited = true
      const err = new Error(`the Tauri app exited (${code})`)
      for (const p of [...this.acks.values(), ...this.scripts.values()]) p.reject(err)
      this.acks.clear()
      this.scripts.clear()
    })
  }

  private attach(c: WsConnection): void {
    c.onMessage((text) => {
      const msg = JSON.parse(text) as {
        seen?: string
        at?: number
        hello?: string
        id?: number
        ok?: boolean
        value?: unknown
        undefined?: boolean
        error?: string
      }
      if (msg.seen !== undefined) {
        const i = this.seenWaiters.findIndex(
          (w) => w.type === msg.seen && (msg.at ?? Infinity) >= w.after,
        )
        if (i >= 0) this.seenWaiters.splice(i, 1)[0]!.resolve()
        return
      }
      if (msg.hello !== undefined) {
        // A new document: the old one's scripts will never answer.
        const old = this.page
        this.page = c
        this.pageHref = msg.hello
        if (old !== null && old !== c) this.dropScripts('the page navigated')
        for (const h of this.hellos.splice(0)) h(msg.hello)
        return
      }
      const p = msg.id === undefined ? undefined : this.scripts.get(msg.id)
      if (p === undefined) return
      this.scripts.delete(msg.id!)
      if (msg.ok === true) p.resolve(msg.undefined === true ? undefined : msg.value)
      else p.reject(new Error(`in the Tauri page: ${msg.error ?? 'failed'}`))
    })
    c.onClose(() => {
      if (this.page === c) {
        this.page = null
        this.dropScripts('the page closed')
      }
    })
  }

  private dropScripts(why: string): void {
    for (const p of this.scripts.values()) p.reject(new Error(why))
    this.scripts.clear()
  }

  nextHello(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`the Tauri page did not connect within ${timeoutMs} ms`)),
        timeoutMs,
      )
      this.hellos.push((href) => {
        clearTimeout(t)
        resolve(href)
      })
    })
  }

  get href(): string {
    return this.pageHref
  }

  /**
   * One native input command, answered once the page has dispatched the DOM
   * event it makes (`domEvent`) — Playwright's input waits for dispatch too.
   * A page that never sees it (navigating, covered) costs a warning after 5 s
   * — 1 s for a move with no button: WebKit drops the first hover move after
   * a load (mouse tracking starts with it), and a lost hover changes nothing.
   */
  async input(cmd: Record<string, unknown>, domEvent: string): Promise<void> {
    const hover = cmd['op'] === 'mouse' && cmd['type'] === 'moved'
    // The event's own time is stamped in the app after this; 2 ms of slack
    // for the clocks (the page's epoch clock and Node's).
    const after = Date.now() - 2
    const seen = new Promise<boolean>((resolve) => {
      const waiter = { type: domEvent, after, resolve: () => resolve(true) }
      this.seenWaiters.push(waiter)
      setTimeout(
        () => {
          const i = this.seenWaiters.indexOf(waiter)
          if (i >= 0) {
            this.seenWaiters.splice(i, 1)
            resolve(false)
          }
        },
        hover ? 1000 : 5000,
      )
    })
    await this.command(cmd)
    if (!(await seen) && !hover)
      console.log(`PERF warn the Tauri page never saw the ${domEvent} of ${JSON.stringify(cmd)}`)
  }

  /** One native input or window command (perf_driver.rs `Command`). */
  command<T = unknown>(cmd: Record<string, unknown>): Promise<T> {
    if (this.exited) return Promise.reject(new Error('the Tauri app has exited'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.acks.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.child.stdin!.write(`${JSON.stringify({ id, ...cmd })}\n`)
    })
  }

  /** Evaluate in the current page (a function and its argument, or an expression). */
  async evaluate<R>(fn: string | ((arg: never) => unknown), arg?: unknown): Promise<R> {
    if (this.page === null) await this.nextHello(30_000)
    const page = this.page!
    const id = this.nextId++
    return new Promise<R>((resolve, reject) => {
      this.scripts.set(id, { resolve: resolve as (v: unknown) => void, reject })
      page.send(
        JSON.stringify({
          id,
          fn: typeof fn === 'function' ? pageSource(fn) : fn,
          isFunction: typeof fn === 'function',
          arg,
        }),
      )
    })
  }

  async quit(): Promise<void> {
    if (!this.exited) {
      await this.command({ op: 'quit' }).catch(() => undefined)
      this.child.stdin?.end()
      await new Promise<void>((r) => {
        if (this.exited) return r()
        const t = setTimeout(() => {
          this.child.kill()
          r()
        }, 5000)
        this.child.once('exit', () => {
          clearTimeout(t)
          r()
        })
      })
    }
    await this.ws.close()
  }
}

// ---------------------------------------------------------------------------
// The Page subset
// ---------------------------------------------------------------------------

type Box = { x: number; y: number; width: number; height: number }

/** How a locator finds its elements in the page (serialised into it). */
type Query =
  | { kind: 'css'; selector: string; index: number | null }
  | { kind: 'role'; role: string; name: string | null; index: number | null }

function resolveInPage(q: Query): Element[] {
  // Runs in the page: no closures over Node values.
  const visible = (e: Element): boolean => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  let all: Element[]
  if (q.kind === 'css') all = [...document.querySelectorAll(q.selector)]
  else {
    const implicit: Record<string, string> = {
      button: 'button, [role="button"], input[type="button"], input[type="submit"]',
      link: 'a[href], [role="link"]',
      textbox: 'input:not([type]), input[type="text"], textarea, [role="textbox"]',
      option: '[role="option"], option',
      region: '[role="region"], section[aria-label]',
    }
    const sel = implicit[q.role] ?? `[role="${q.role}"]`
    const nameOf = (e: Element): string =>
      (
        e.getAttribute('aria-label') ??
        (e.getAttribute('aria-labelledby') !== null
          ? document.getElementById(e.getAttribute('aria-labelledby')!)?.textContent
          : null) ??
        e.getAttribute('title') ??
        e.textContent ??
        ''
      )
        .trim()
        .toLowerCase()
    const want = q.name?.toLowerCase() ?? null
    all = [...document.querySelectorAll(sel)].filter(
      (e) => visible(e) && (want === null || nameOf(e).includes(want)),
    )
  }
  if (q.index === null) return all
  const one = all.at(q.index)
  return one === undefined ? [] : [one]
}

class TauriLocator {
  constructor(
    private readonly page: TauriPageImpl,
    private readonly query: Query,
  ) {}

  nth(i: number): TauriLocator {
    return new TauriLocator(this.page, { ...this.query, index: i })
  }
  first(): TauriLocator {
    return this.nth(0)
  }
  last(): TauriLocator {
    return this.nth(-1)
  }

  async boundingBox(): Promise<Box | null> {
    return this.page.app.evaluate<Box | null>(
      ((a: { q: Query; resolve: string }) => {
        const resolve = (0, eval)(a.resolve) as (q: Query) => Element[]
        const e = resolve(a.q)[0]
        if (e === undefined) return null
        const r = e.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }) as (arg: never) => unknown,
      { q: this.query, resolve: pageSource(resolveInPage) },
    )
  }

  /** The element's box once it is there and has a size (Playwright's actionability, in short). */
  private async box(timeoutMs = 30_000): Promise<Box> {
    const end = Date.now() + timeoutMs
    for (;;) {
      const b = await this.boundingBox()
      if (b !== null && b.width > 0 && b.height > 0) return b
      if (Date.now() > end) throw new Error(`no visible element for ${JSON.stringify(this.query)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  async isVisible(): Promise<boolean> {
    const b = await this.boundingBox()
    return b !== null && b.width > 0 && b.height > 0
  }

  async waitFor(opts: { timeout?: number } = {}): Promise<void> {
    await this.box(opts.timeout)
  }

  async click(opts: { clickCount?: number } = {}): Promise<void> {
    const b = await this.box()
    await this.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, opts)
  }

  async hover(): Promise<void> {
    const b = await this.box()
    await this.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  }

  async evaluateAll<R>(fn: (els: Element[]) => R): Promise<R> {
    return this.page.app.evaluate<R>(
      ((a: { q: Query; resolve: string; fn: string }) => {
        const resolve = (0, eval)(a.resolve) as (q: Query) => Element[]
        const f = (0, eval)(a.fn) as (els: Element[]) => unknown
        return f(resolve(a.q))
      }) as (arg: never) => unknown,
      { q: this.query, resolve: pageSource(resolveInPage), fn: pageSource(fn) },
    )
  }
}

class TauriMouse {
  private x = 0
  private y = 0
  private pressed = false

  constructor(private readonly page: TauriPageImpl) {}

  async move(x: number, y: number, opts: { steps?: number } = {}): Promise<void> {
    const steps = Math.max(1, opts.steps ?? 1)
    const fromX = this.x
    const fromY = this.y
    for (let i = 1; i <= steps; i++) {
      const px = fromX + ((x - fromX) * i) / steps
      const py = fromY + ((y - fromY) * i) / steps
      await this.page.app.input(
        {
          op: 'mouse',
          type: this.pressed ? 'dragged' : 'moved',
          x: px,
          y: py,
          modifiers: this.page.keyboard.modifiers(),
        },
        'pointermove',
      )
    }
    this.x = x
    this.y = y
  }

  async down(opts: { clickCount?: number } = {}): Promise<void> {
    this.pressed = true
    await this.page.app.input(
      {
        op: 'mouse',
        type: 'down',
        x: this.x,
        y: this.y,
        clickCount: opts.clickCount ?? 1,
        modifiers: this.page.keyboard.modifiers(),
      },
      'pointerdown',
    )
  }

  async up(opts: { clickCount?: number } = {}): Promise<void> {
    this.pressed = false
    await this.page.app.input(
      {
        op: 'mouse',
        type: 'up',
        x: this.x,
        y: this.y,
        clickCount: opts.clickCount ?? 1,
        modifiers: this.page.keyboard.modifiers(),
      },
      'pointerup',
    )
  }

  async click(x: number, y: number, opts: { clickCount?: number } = {}): Promise<void> {
    await this.move(x, y)
    const n = opts.clickCount ?? 1
    for (let i = 1; i <= n; i++) {
      await this.down({ clickCount: i })
      await this.up({ clickCount: i })
    }
  }

  async dblclick(x: number, y: number): Promise<void> {
    await this.click(x, y, { clickCount: 2 })
  }

  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this.page.app.input(
      {
        op: 'wheel',
        x: this.x,
        y: this.y,
        dx: deltaX,
        dy: deltaY,
        modifiers: this.page.keyboard.modifiers(),
      },
      'wheel',
    )
  }
}

class TauriKeyboard {
  private readonly held = new Set<Modifier>()

  constructor(private readonly page: TauriPageImpl) {}

  modifiers(): Modifier[] {
    return [...this.held]
  }

  async down(name: string): Promise<void> {
    const key = keyName(name)
    const mod = MODIFIER_KEYS[key]
    if (mod !== undefined) {
      this.held.add(mod.flag)
      await this.page.app.input(
        { op: 'flags', keyCode: mod.code, down: true, modifiers: this.modifiers() },
        'keydown',
      )
      return
    }
    await this.key('down', key)
  }

  async up(name: string): Promise<void> {
    const key = keyName(name)
    const mod = MODIFIER_KEYS[key]
    if (mod !== undefined) {
      this.held.delete(mod.flag)
      await this.page.app.input(
        { op: 'flags', keyCode: mod.code, down: false, modifiers: this.modifiers() },
        'keyup',
      )
      return
    }
    await this.key('up', key)
  }

  /** `press('Meta+ArrowDown')`: the modifiers down, the key down and up, the modifiers up. */
  async press(combo: string): Promise<void> {
    const parts = combo.split('+')
    // `+` itself as the key: 'Shift++'.
    const key = parts.at(-1) === '' ? '+' : parts.at(-1)!
    const mods = parts.slice(0, parts.at(-1) === '' ? -2 : -1)
    for (const m of mods) await this.down(m)
    const shift = this.printableNeedsShift(key)
    if (shift) await this.down('Shift')
    await this.key('down', keyName(key))
    await this.key('up', keyName(key))
    if (shift) await this.up('Shift')
    for (const m of [...mods].reverse()) await this.up(m)
  }

  async type(text: string): Promise<void> {
    for (const ch of text) await this.press(ch)
  }

  /** A printable character that needs Shift gets it for its own press (unless Shift is held). */
  private printableNeedsShift(key: string): boolean {
    return (
      NAMED[key] === undefined &&
      [...key].length === 1 &&
      printable(key).shift &&
      !this.held.has('shift')
    )
  }

  private async key(kind: 'down' | 'up', key: string): Promise<void> {
    const named = NAMED[key]
    if (named !== undefined) {
      await this.page.app.input(
        {
          op: 'key',
          type: kind,
          keyCode: named.code,
          characters: named.chars,
          modifiers: [...this.modifiers(), ...(named.extra ?? [])],
        },
        kind === 'down' ? 'keydown' : 'keyup',
      )
      return
    }
    if ([...key].length !== 1) throw new Error(`the Tauri keyboard does not know the key ${key}`)
    const p = printable(key)
    // With Command or Control held AppKit's characters are the unmodified key's.
    const mods = this.modifiers()
    await this.page.app.input(
      {
        op: 'key',
        type: kind,
        keyCode: p.code,
        characters: mods.includes('meta') || mods.includes('control') ? p.base : key,
        charactersIgnoringModifiers: p.base,
        modifiers: mods,
      },
      kind === 'down' ? 'keydown' : 'keyup',
    )
  }
}

class TauriPageImpl {
  readonly mouse: TauriMouse
  readonly keyboard: TauriKeyboard
  readonly isTauri = true

  constructor(
    readonly app: TauriApp,
    private readonly ctx: BrowserContext,
    private readonly baseURL: string,
  ) {
    this.mouse = new TauriMouse(this)
    this.keyboard = new TauriKeyboard(this)
  }

  evaluate<R, A>(fn: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    return this.app.evaluate<R>(fn as string | ((arg: never) => unknown), arg)
  }

  async goto(
    url: string,
    opts: { waitUntil?: 'commit' | 'load' | 'domcontentloaded' } = {},
  ): Promise<null> {
    const target = new URL(url, this.baseURL).toString()
    const hello = this.app.nextHello(60_000)
    await this.app.command({ op: 'navigate', url: target })
    await hello
    if (opts.waitUntil !== 'commit') {
      const state =
        opts.waitUntil === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete']
      await this.app.evaluate(
        ((s: string[]) =>
          new Promise<void>((resolve) => {
            const check = (): void => {
              if (s.includes(document.readyState)) resolve()
              else setTimeout(check, 20)
            }
            check()
          })) as (arg: never) => unknown,
        state,
      )
    }
    return null
  }

  url(): string {
    return this.app.href
  }

  waitForTimeout(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  locator(selector: string): TauriLocator {
    return new TauriLocator(this, { kind: 'css', selector, index: null })
  }

  getByRole(role: string, opts: { name?: string } = {}): TauriLocator {
    return new TauriLocator(this, { kind: 'role', role, name: opts.name ?? null, index: null })
  }

  context(): BrowserContext {
    return this.ctx
  }

  async close(): Promise<void> {
    await this.app.quit()
  }
}

/**
 * Open the Tauri window on `baseURL` and hand it over as a Page. The app
 * quits when the context closes or this process exits.
 */
export async function tauriPage(
  context: BrowserContext,
  o: {
    baseURL: string
    viewport: { width: number; height: number }
    deviceScale?: number
    /** More scripts to run before the page's own, after the React hook. */
    initScripts?: string[]
  },
): Promise<Page> {
  const app = await TauriApp.launch({
    baseURL: o.baseURL,
    viewport: o.viewport,
    initScripts: [`(${installReactPerfHook.toString()})();`, ...(o.initScripts ?? [])],
  })
  process.once('exit', () => void app.quit())
  context.once('close', () => void app.quit())
  await app.command({ op: 'focus' })
  await app.command({ op: 'resize', width: o.viewport.width, height: o.viewport.height })
  if (o.deviceScale !== undefined && o.deviceScale > 0)
    await app.command({ op: 'deviceScale', factor: o.deviceScale })
  const impl = new TauriPageImpl(app, context, o.baseURL)
  const page = new Proxy(impl, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver) as unknown
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      throw new Error(
        `page.${prop} is not available in the Tauri window (e2e/perf/lib/tauriPage.ts)`,
      )
    },
  })
  return page as unknown as Page
}

/** Whether `page` is the Tauri window (what it cannot do: a second window, a fresh context, request events). */
export function isTauriPage(page: Page): boolean {
  return (page as unknown as { isTauri?: boolean }).isTauri === true
}

/** The window's own numbers: AppKit's scale factor, the view's size. */
export function tauriWindowInfo(page: Page): Promise<Record<string, unknown>> {
  return (page as unknown as TauriPageImpl).app.command({ op: 'info' })
}
