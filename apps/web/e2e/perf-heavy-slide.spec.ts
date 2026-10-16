/**
 * perf-heavy-slide.spec.ts — what a crowded slide costs while dragging,
 * zooming and typing. Opt-in (`PERF_PROBE=1`), measures rather than asserts.
 *
 *   PERF_PROBE=1 PERF_PHOTOS=<dir with *.jpg> PERF_OUT=<result.json> \
 *     just e2e e2e/perf-heavy-slide.spec.ts
 *
 * The slide is seeded with PERF_TEXTS texts (default 120), PERF_IMAGES
 * picture objects (40, cycling through the photos of PERF_PHOTOS) and
 * PERF_RECTS rectangles (60). Per gesture it reports, next to the frame
 * times of perf-zoom-drag.spec.ts, numbers that do not depend on the GPU
 * the browser happens to have (headless Chromium on a CI box draws with
 * SwiftShader, so frame times alone say more about the CPU than the scene):
 *
 *   - GL: draw calls, stencil toggles, mipmap generations, texture uploads
 *     per gesture (the WebGL context is wrapped before the page loads);
 *   - CPU: main-thread script / layout / style time (CDP Performance) and the
 *     self time of the hottest functions, grouped into Pixi, React, Yjs and
 *     the app's own code (CDP Profiler);
 *   - input: the slowest events (PerformanceEventTiming) and long tasks.
 *
 * `[no-mask]` rows repeat a gesture with every Pixi mask taken off the scene
 * (the clip masks of text and images), to put a price on them.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type CDPSession, type Page } from './fixtures/test'
import { provisionDeckWithText } from './fixtures/provisionDeck'

test.skip(process.env['PERF_PROBE'] !== '1', 'opt-in: PERF_PROBE=1')

// Playwright's tracing snapshots the DOM at every mouse and key action
// (`trace: 'retain-on-failure'` in the config), which is a forced layout and a
// serialisation of the whole page per pointer move: it showed up as most of the
// "native" time of the first runs. A probe must not be probed.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

// PERF_GPU=1: draw with the machine's GPU (Vulkan through ANGLE) instead of
// the software rasteriser headless Chromium falls back to — the numbers of a
// scene say little when every draw is paid for by the CPU.
const GPU_ARGS = [
  '--use-angle=vulkan',
  '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--disable-vulkan-surface',
]
const executablePath = process.env['PLAYWRIGHT_CHROME_EXECUTABLE']
if (process.env['PERF_GPU'] === '1') {
  test.use({
    launchOptions: {
      args: GPU_ARGS,
      ...(executablePath !== undefined && executablePath !== '' ? { executablePath } : {}),
    },
  })
}

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'
const N_TEXTS = Number(process.env['PERF_TEXTS'] ?? 120)
const N_IMAGES = Number(process.env['PERF_IMAGES'] ?? 40)
const N_RECTS = Number(process.env['PERF_RECTS'] ?? 60)
const OUT = process.env['PERF_OUT'] ?? path.join(os.tmpdir(), 'perf-heavy-slide.json')
const SLIDE_W = 1920

/** JPEGs to upload: PERF_PHOTOS, or six generated into the temp dir. */
function photoFiles(): string[] {
  let dir = process.env['PERF_PHOTOS']
  if (dir === undefined || dir === '') {
    dir = path.join(os.tmpdir(), 'perf-photos')
    mkdirSync(dir, { recursive: true })
    for (let i = 1; i <= 6; i++) {
      const file = path.join(dir, `photo${i}.jpg`)
      if (!existsSync(file)) {
        execFileSync('magick', [
          ...['-size', '3200x2133', 'plasma:fractal', '-attenuate', '0.6', '+noise', 'Gaussian'],
          ...['-quality', '82', file],
        ])
      }
    }
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => path.join(dir, f))
}

// ---------------------------------------------------------------------------
// Instrumentation installed before the page's own scripts run.
// ---------------------------------------------------------------------------

const INIT_SCRIPT = (opts: { react: boolean }): void => {
  type Counters = Record<string, number>
  const w = window as unknown as {
    __gl: Counters
    __long: Array<{ s: number; d: number }>
    __events: Array<{ name: string; dur: number }>
    __glRenderer: string
  }
  w.__gl = {
    draw: 0,
    stencilToggle: 0,
    stencilClear: 0,
    mipmap: 0,
    texUpload: 0,
    texUploadPx: 0,
    bufferData: 0,
    readPixels: 0,
    fbBind: 0,
  }
  w.__long = []
  w.__events = []

  // React render accounting: a minimal DevTools hook turns on React's profiling
  // mode and reports every commit; the components that did work in it are
  // counted by name. Costs a little itself (PERF_REACT=1 only).
  const wr = window as unknown as {
    __react: { commits: number; ms: number; byName: Record<string, { n: number; ms: number }> }
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown
  }
  wr.__react = { commits: 0, ms: 0, byName: {} }
  if (opts.react) {
    interface Fiber {
      tag: number
      type: {
        displayName?: string
        name?: string
        render?: { displayName?: string; name?: string }
      } | null
      flags: number
      alternate: Fiber | null
      _debugOwner?: Fiber | null
      child: Fiber | null
      sibling: Fiber | null
      actualDuration?: number
    }
    const PERFORMED_WORK = 1
    const FUNCTION_LIKE = new Set([0, 1, 11, 14, 15])
    const nameOf = (f: Fiber): string =>
      f.type?.displayName ??
      f.type?.name ??
      f.type?.render?.displayName ??
      f.type?.render?.name ??
      '(anon)'
    wr.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
        wr.__react.commits++
        wr.__react.ms += root.current.actualDuration ?? 0
        const record = (f: Fiber): void => {
          if ((f.flags & PERFORMED_WORK) === 0 || !FUNCTION_LIKE.has(f.tag)) return
          let childMs = 0
          for (let c = f.child; c !== null; c = c.sibling) childMs += c.actualDuration ?? 0
          const own = nameOf(f)
          const owner = f._debugOwner != null ? nameOf(f._debugOwner) : ''
          const key =
            own === '' || own === '(anon)' || own.length <= 2 ? `${own || '(anon)'} <${owner}` : own
          const e = (wr.__react.byName[key] ??= { n: 0, ms: 0 })
          e.n++
          e.ms += Math.max(0, (f.actualDuration ?? 0) - childMs)
        }
        // A subtree React bailed out of keeps its old fibers, flags and all:
        // only descend where the child list changed (as DevTools does).
        const mounted = (f: Fiber): void => {
          record(f)
          for (let c = f.child; c !== null; c = c.sibling) mounted(c)
        }
        const updated = (next: Fiber, prev: Fiber): void => {
          record(next)
          if (next.child === prev.child) return
          for (let c = next.child; c !== null; c = c.sibling) {
            if (c.alternate !== null) updated(c, c.alternate)
            else mounted(c)
          }
        }
        const rootFiber = root.current
        if (rootFiber.alternate !== null) updated(rootFiber, rootFiber.alternate)
        else mounted(rootFiber)
      },
    }
  }

  const proto = WebGL2RenderingContext.prototype as unknown as Record<string, unknown>
  const wrap = (name: string, fn: (args: unknown[]) => void): void => {
    const orig = proto[name] as (...a: unknown[]) => unknown
    proto[name] = function (this: unknown, ...args: unknown[]) {
      fn(args)
      return orig.apply(this, args)
    }
  }
  for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    wrap(n, () => void w.__gl['draw']!++)
  }
  const STENCIL_TEST = 0x0b90
  const STENCIL_BUFFER_BIT = 0x400
  wrap('enable', (a) => {
    if (a[0] === STENCIL_TEST) w.__gl['stencilToggle']!++
  })
  wrap('disable', (a) => {
    if (a[0] === STENCIL_TEST) w.__gl['stencilToggle']!++
  })
  wrap('clear', (a) => {
    if (((a[0] as number) & STENCIL_BUFFER_BIT) !== 0) w.__gl['stencilClear']!++
  })
  wrap('generateMipmap', () => void w.__gl['mipmap']!++)
  const upload = (a: unknown[]): void => {
    w.__gl['texUpload']!++
    // texImage2D(target, level, internalformat, width, height, …) has the size at 3/4.
    const width = a[3]
    const height = a[4]
    if (typeof width === 'number' && typeof height === 'number')
      w.__gl['texUploadPx']! += width * height
  }
  wrap('texImage2D', upload)
  wrap('texSubImage2D', (a) => {
    w.__gl['texUpload']!++
    const width = a[4]
    const height = a[5]
    if (typeof width === 'number' && typeof height === 'number')
      w.__gl['texUploadPx']! += width * height
  })
  wrap('bufferData', () => void w.__gl['bufferData']!++)
  wrap('readPixels', () => void w.__gl['readPixels']!++)
  wrap('bindFramebuffer', () => void w.__gl['fbBind']!++)

  const getParameter = proto['getParameter'] as (p: number) => unknown
  const ext = proto['getExtension'] as (n: string) => { UNMASKED_RENDERER_WEBGL: number } | null
  proto['getParameter'] = function (this: unknown, p: number) {
    const v = getParameter.call(this, p)
    return v
  }
  w.__glRenderer = ''
  const probeRenderer = (): void => {
    try {
      const c = document.createElement('canvas')
      const gl = c.getContext('webgl2')
      const e = gl && ext.call(gl, 'WEBGL_debug_renderer_info')
      if (gl && e) w.__glRenderer = String(getParameter.call(gl, e.UNMASKED_RENDERER_WEBGL))
    } catch {
      /* none */
    }
  }
  probeRenderer()

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__long.push({ s: e.startTime, d: e.duration })
  }).observe({ type: 'longtask', buffered: true })
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__events.push({ name: e.name, dur: e.duration })
  }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit)
}

// ---------------------------------------------------------------------------
// Measuring one gesture.
// ---------------------------------------------------------------------------

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}
interface CpuProfile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
}

function category(url: string, name: string): string {
  if (name === '(idle)') return 'idle'
  if (name === '(garbage collector)') return 'gc'
  if (name === '(program)') return 'program'
  if (url === '') return 'native'
  if (/pixi/i.test(url)) return 'pixi'
  if (/react/i.test(url)) return 'react'
  if (/yjs|lib0|y-protocols|hocuspocus/i.test(url)) return 'yjs'
  if (/tiptap|prosemirror/i.test(url)) return 'tiptap'
  if (/\/src\/|@narrative|packages\//.test(url)) return 'app'
  return 'other'
}

function summariseProfile(profile: CpuProfile): {
  byCategory: Record<string, number>
  top: Array<{ fn: string; ms: number; cat: string }>
} {
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map<number, number>()
  profile.samples.forEach((id, i) => {
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0))
  })
  const byCategory: Record<string, number> = {}
  const byFn = new Map<string, { ms: number; cat: string }>()
  for (const [id, us] of self) {
    const node = nodeById.get(id)
    if (node === undefined) continue
    const { functionName, url, lineNumber } = node.callFrame
    const cat = category(url, functionName)
    const ms = us / 1000
    byCategory[cat] = (byCategory[cat] ?? 0) + ms
    if (cat === 'idle') continue
    const file = url.split('/').pop()?.split('?')[0] ?? ''
    const key = `${functionName || '(anon)'} ${file}:${lineNumber + 1}`
    const prev = byFn.get(key)
    byFn.set(key, { ms: (prev?.ms ?? 0) + ms, cat })
  }
  const top = [...byFn.entries()]
    .map(([fn, v]) => ({ fn, ms: v.ms, cat: v.cat }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 14)
  return { byCategory, top }
}

interface Window {
  frames: number
  fps: number
  p50: number
  p90: number
  max: number
  over50: number
  longTasks: { n: number; maxMs: number; totalMs: number }
}

interface Row {
  name: string
  /** While the input runs (pointer moves, wheel, keys). */
  active: Window
  /** After the last input: the work the gesture leaves behind (rasters, thumbnails). */
  tail: Window
  gl: Record<string, number>
  glActive: Record<string, number>
  cpu: Record<string, number>
  slowEvents: Array<{ name: string; dur: number }>
  /** The editor canvas's own `renderer.render` calls (the thumbnails have a renderer of their own). */
  pixi: { renders: number; ms: number; maxMs: number }
  /** How many times the whole scene's text was told to rasterise again (a resolution change after a zoom). */
  textRefreshes: number
  react: {
    commits: number
    ms: number
    top: Array<{ name: string; n: number; ms: number }>
    topMs: Array<{ name: string; n: number; ms: number }>
  }
  /** How far the gesture's subject moved, where it moves objects (-1: not applicable). */
  moved: number
  profile: {
    byCategory: Record<string, number>
    top: Array<{ fn: string; ms: number; cat: string }>
  }
  wallMs: number
}

const rows: Row[] = []
let lastMoved = -1

function windowStats(
  frames: Array<{ t: number; d: number }>,
  long: Array<{ s: number; d: number }>,
  from: number,
  to: number,
): Window {
  const fs = frames.filter((f) => f.t >= from && f.t < to).map((f) => f.d)
  const sorted = [...fs].sort((a, b) => a - b)
  const at = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  const ls = long.filter((l) => l.s >= from && l.s < to)
  return {
    frames: fs.length,
    fps: to > from ? (fs.length / (to - from)) * 1000 : 0,
    p50: at(0.5),
    p90: at(0.9),
    max: at(1),
    over50: fs.filter((f) => f > 50).length,
    longTasks: {
      n: ls.length,
      maxMs: Math.max(0, ...ls.map((l) => l.d)),
      totalMs: ls.reduce((a, l) => a + l.d, 0),
    },
  }
}

async function measure(
  page: Page,
  cdp: CDPSession,
  name: string,
  gesture: (endOfInput: () => Promise<void>) => Promise<void>,
): Promise<Row | null> {
  const only = process.env['PERF_ONLY']
  if (only !== undefined && only !== '' && !only.split(',').some((o) => name.includes(o)))
    return null
  // Quiet first: the previous gesture's rasters and thumbnails must not leak in.
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    const w = window as unknown as {
      __gl: Record<string, number>
      __long: unknown[]
      __events: unknown[]
      __frames: Array<{ t: number; d: number }>
      __probing: boolean
    }
    for (const k of Object.keys(w.__gl)) w.__gl[k] = 0
    w.__long.length = 0
    w.__events.length = 0
    w.__frames = []
    w.__probing = true
    const wx = window as unknown as {
      __pixiRender?: { renders: number; ms: number; maxMs: number }
      __react?: { commits: number; ms: number; byName: Record<string, unknown> }
    }
    wx.__pixiRender = { renders: 0, ms: 0, maxMs: 0 }
    ;(window as unknown as { __textRefreshes: number }).__textRefreshes = 0
    if (wx.__react) {
      wx.__react.commits = 0
      wx.__react.ms = 0
      wx.__react.byName = {}
    }
    let last = performance.now()
    const tick = (now: number): void => {
      w.__frames.push({ t: now, d: now - last })
      last = now
      if (w.__probing) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const metric = async (): Promise<Record<string, number>> => {
    const { metrics } = await cdp.send('Performance.getMetrics')
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
  }
  const before = await metric()
  const startT = await page.evaluate(() => performance.now())
  await cdp.send('Profiler.start')
  const t0 = Date.now()
  lastMoved = -1
  let markT = -1
  let glActive: Record<string, number> = {}
  await gesture(async () => {
    const m = await page.evaluate(() => ({
      t: performance.now(),
      gl: { ...(window as unknown as { __gl: Record<string, number> }).__gl },
    }))
    markT = m.t
    glActive = m.gl
  })
  const wallMs = Date.now() - t0
  const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: CpuProfile }
  const after = await metric()

  const snap = await page.evaluate(() => {
    const w = window as unknown as {
      __gl: Record<string, number>
      __long: Array<{ s: number; d: number }>
      __events: Array<{ name: string; dur: number }>
      __frames: Array<{ t: number; d: number }>
      __probing: boolean
      __pixiRender: { renders: number; ms: number; maxMs: number }
      __react: { commits: number; ms: number; byName: Record<string, { n: number; ms: number }> }
    }
    w.__probing = false
    return {
      textRefreshes: (window as unknown as { __textRefreshes: number }).__textRefreshes,
      pixi: { ...w.__pixiRender },
      react: {
        commits: w.__react.commits,
        ms: w.__react.ms,
        top: Object.entries(w.__react.byName)
          .map(([name, v]) => ({ name, n: v.n, ms: v.ms }))
          .sort((a, b) => b.n - a.n)
          .slice(0, 12),
        topMs: Object.entries(w.__react.byName)
          .map(([name, v]) => ({ name, n: v.n, ms: v.ms }))
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 14),
      },
      endT: performance.now(),
      gl: { ...w.__gl },
      long: [...w.__long],
      events: [...w.__events],
      frames: w.__frames.slice(1),
    }
  })
  if (markT < 0) {
    markT = snap.endT
    glActive = snap.gl
  }
  const delta = (k: string): number => ((after[k] ?? 0) - (before[k] ?? 0)) * 1000
  const row: Row = {
    name,
    active: windowStats(snap.frames, snap.long, startT, markT),
    tail: windowStats(snap.frames, snap.long, markT, snap.endT),
    gl: snap.gl,
    glActive,
    cpu: {
      scriptMs: delta('ScriptDuration'),
      layoutMs: delta('LayoutDuration'),
      styleMs: delta('RecalcStyleDuration'),
      taskMs: delta('TaskDuration'),
      layouts: (after['LayoutCount'] ?? 0) - (before['LayoutCount'] ?? 0),
      styleRecalcs: (after['RecalcStyleCount'] ?? 0) - (before['RecalcStyleCount'] ?? 0),
      heapMB: (after['JSHeapUsedSize'] ?? 0) / 1048576,
    },
    slowEvents: [...snap.events].sort((a, b) => b.dur - a.dur).slice(0, 5),
    pixi: snap.pixi,
    textRefreshes: snap.textRefreshes,
    react: snap.react,
    moved: lastMoved,
    profile: summariseProfile(profile),
    wallMs,
  }
  rows.push(row)
  const f = (n: number): string => n.toFixed(0)
  const w = (x: Window): string =>
    `${f(x.fps)}fps p90=${f(x.p90)} max=${f(x.max)} >50=${x.over50} long=${x.longTasks.n}x/${f(x.longTasks.maxMs)}ms`
  console.log(
    `PERF ${name.padEnd(24)} active[${w(row.active)}] tail[${w(row.tail)}] ` +
      `| pixi ${row.pixi.renders}x ${f(row.pixi.ms)}ms (max ${f(row.pixi.maxMs)}) refresh=${row.textRefreshes} react ${row.react.commits} commits ${f(row.react.ms)}ms moved=${f(row.moved)}px ` +
      `| draw=${glActive['draw']}+${(row.gl['draw'] ?? 0) - (glActive['draw'] ?? 0)} ` +
      `mip=${row.gl['mipmap']} up=${row.gl['texUpload']} read=${row.gl['readPixels']} ` +
      `| script=${f(row.cpu['scriptMs']!)} layout=${f(row.cpu['layoutMs']!)} style=${f(row.cpu['styleMs']!)} task=${f(row.cpu['taskMs']!)}ms wall=${f(wallMs)}ms`,
  )
  return row
}

// ---------------------------------------------------------------------------
// The slide.
// ---------------------------------------------------------------------------

const WORDS = (
  'Narrative quarterly revenue growth market segment customer retention roadmap launch ' +
  'insight strategy brand audience campaign pipeline forecast delivery milestone risk'
).split(' ')

function sentence(seed: number, words: number): string {
  let s = ''
  for (let i = 0; i < words; i++) s += (i ? ' ' : '') + WORDS[(seed * 7 + i * 3) % WORDS.length]
  return s
}

async function uploadPhotos(page: Page, deckId: string, files: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const file of files) {
    const res = await page.request.post(`${API_BASE}/commands`, {
      headers: { Origin: WEB_ORIGIN },
      data: {
        target: { deckId },
        command: 'media.upload',
        input: {
          file: { base64: readFileSync(file).toString('base64'), filename: path.basename(file) },
        },
      },
    })
    const body = (await res.json()) as {
      ok: boolean
      result: { assetId: string }
      error?: { message: string }
    }
    expect(body.ok, `media.upload: ${body.error?.message}`).toBe(true)
    ids.push(body.result.assetId)
  }
  return ids
}

async function artboardScale(page: Page): Promise<{ x: number; y: number; k: number }> {
  const box = (await page.locator('.artboard').boundingBox())!
  return { x: box.x, y: box.y, k: box.width / SLIDE_W }
}

test('a crowded slide: drag, zoom, type', { tag: '@serial' }, async ({ page }) => {
  test.setTimeout(15 * 60_000)
  await page.addInitScript(INIT_SCRIPT, { react: process.env['PERF_REACT'] === '1' })
  await page.setViewportSize({ width: 1800, height: 1100 })

  const deck = await provisionDeckWithText(page, {
    title: 'perf heavy slide',
    objectId: 'perf-seed',
    text: 'seed',
    x: 10,
    y: 10,
    width: 100,
    height: 40,
  })
  const assetIds = await uploadPhotos(page, deck.deckId, photoFiles())

  // Seed in one go: texts, then rectangles and pictures, then the three
  // probes last so they sit on top and a click at their centre hits them.
  await page.evaluate(
    ({ nT, nI, nR, assets, words }) => {
      const api = window.__narrative_test_api!
      const sent = (seed: number, n: number): string => {
        let s = ''
        for (let i = 0; i < n; i++) s += (i ? ' ' : '') + words[(seed * 7 + i * 3) % words.length]
        return s
      }
      const rnd = (i: number, m: number): number => ((i * 2654435761) >>> 0) % m
      for (let i = 0; i < nR; i++) {
        api.addRect({
          id: `rect-${i}`,
          x: rnd(i + 1, 1700),
          y: rnd(i + 5, 900),
          w: 120 + rnd(i + 9, 260),
          h: 80 + rnd(i + 13, 200),
          fill: 0x223344 + rnd(i, 0x777777),
        })
      }
      for (let i = 0; i < nI; i++) {
        api.addImage({
          id: `img-${i}`,
          assetId: assets[i % assets.length]!,
          x: rnd(i + 21, 1500),
          y: rnd(i + 25, 800),
          w: 260 + rnd(i + 29, 240),
          h: 180 + rnd(i + 33, 160),
        })
      }
      for (let i = 0; i < nT; i++) {
        const lines = 1 + (i % 4)
        api.addText({
          id: `text-${i}`,
          x: rnd(i + 41, 1600),
          y: rnd(i + 45, 950),
          w: 240 + rnd(i + 49, 320),
          h: 40 * lines,
          fontSize: 16 + rnd(i + 53, 5) * 6,
          text: Array.from({ length: lines }, (_, l) => sent(i + l, 3 + ((i + l) % 4))).join('\n'),
        })
      }
      // Probes, topmost, in an area of their own: a rectangle, a text, a picture.
      api.addRect({ id: 'probe-rect', x: 1300, y: 420, w: 220, h: 160, fill: 0xcc3366 })
      api.addText({
        id: 'probe-text',
        x: 300,
        y: 420,
        w: 520,
        h: 120,
        fontSize: 40,
        text: 'Probe text box for typing and dragging',
      })
      api.addImage({ id: 'probe-img', assetId: assets[0]!, x: 860, y: 420, w: 360, h: 240 })
    },
    { nT: N_TEXTS, nI: N_IMAGES, nR: N_RECTS, assets: assetIds, words: WORDS },
  )

  const expected = N_TEXTS + N_IMAGES + N_RECTS + 4
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.sceneGraphIds().length), {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(expected)
  // First rasters and the picture downloads.
  await page.waitForTimeout(8000)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('Profiler.enable')

  await page.evaluate(() => {
    const app = (
      window as unknown as {
        __narrative_perf: { app: { renderer: { render: (...a: unknown[]) => unknown } } }
      }
    ).__narrative_perf.app
    const orig = app.renderer.render.bind(app.renderer)
    app.renderer.render = (...args: unknown[]) => {
      const t = performance.now()
      try {
        return orig(...args)
      } finally {
        const d = performance.now() - t
        const r = (
          window as unknown as { __pixiRender: { renders: number; ms: number; maxMs: number } }
        ).__pixiRender
        r.renders++
        r.ms += d
        r.maxMs = Math.max(r.maxMs, d)
      }
    }
  })

  await page.evaluate(() => {
    const sg = window.__narrative_scene_graph as unknown as {
      forceTextResolutionRefresh: () => void
    }
    const orig = sg.forceTextResolutionRefresh.bind(sg)
    sg.forceTextResolutionRefresh = () => {
      ;(window as unknown as { __textRefreshes: number }).__textRefreshes++
      orig()
    }
  })

  const info = await page.evaluate(() => ({
    renderer: (window as unknown as { __glRenderer: string }).__glRenderer,
    objects: window.__narrative_test_api!.sceneGraphIds().length,
    dpr: window.devicePixelRatio,
  }))
  console.log(
    'PERF scene',
    JSON.stringify({ ...info, texts: N_TEXTS, images: N_IMAGES, rects: N_RECTS }),
  )

  const centre = async (id: string): Promise<{ x: number; y: number }> => {
    const o = await page.evaluate(
      (i) =>
        window.__narrative_test_api!.getObject(i) as {
          x: number
          y: number
          width: number
          height: number
        },
      id,
    )
    const a = await artboardScale(page)
    return { x: a.x + (o.x + o.width / 2) * a.k, y: a.y + (o.y + o.height / 2) * a.k }
  }

  const dragProbe =
    (id: string, steps: number, selection?: string[]) =>
    async (endOfInput: () => Promise<void>): Promise<void> => {
      const ids = selection ?? [id]
      const home = await page.evaluate(
        (list) =>
          list.map((i) => {
            const o = window.__narrative_test_api!.getObject(i) as { x: number; y: number }
            return { id: i, x: o.x, y: o.y }
          }),
        ids,
      )
      await page.evaluate((list) => window.__narrative_test_api!.setSelection(list), ids)
      const c = await centre(id)
      await page.mouse.move(c.x, c.y)
      await page.mouse.down()
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(c.x + i * 5, c.y + Math.sin(i / 6) * 50)
        await page.waitForTimeout(8)
      }
      await page.mouse.up()
      lastMoved = await page.evaluate(
        ([i, hx, hy]) => {
          const o = window.__narrative_test_api!.getObject(i as string) as { x: number; y: number }
          return Math.hypot(o.x - (hx as number), o.y - (hy as number))
        },
        [id, home[0]!.x, home[0]!.y] as const,
      )
      await endOfInput()
      // What the drag leaves behind: the sidebar thumbnail, rasters.
      await page.waitForTimeout(3000)
      // Put everything back so every run starts from the same place.
      await page.evaluate((list) => {
        for (const o of list) window.__narrative_test_api!.updateObject(o.id, { x: o.x, y: o.y })
      }, home)
    }

  const zoomGesture = async (endOfInput: () => Promise<void>): Promise<void> => {
    const a = await artboardScale(page)
    await page.mouse.move(a.x + 900 * a.k, a.y + 540 * a.k)
    await page.keyboard.down('ControlOrMeta')
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, i < 20 ? -50 : 50)
      await page.waitForTimeout(25)
    }
    await page.keyboard.up('ControlOrMeta')
    await endOfInput()
    // The settle: the resolution commit after 150 ms and the text re-rasters behind it.
    await page.waitForTimeout(4000)
  }

  const typeGesture = async (endOfInput: () => Promise<void>): Promise<void> => {
    const c = await centre('probe-text')
    await page.mouse.dblclick(c.x, c.y)
    await page.waitForTimeout(600)
    for (const ch of 'The quick brown fox jumps over the lazy dog and keeps typing') {
      await page.keyboard.type(ch)
      await page.waitForTimeout(35)
    }
    await endOfInput()
    await page.keyboard.press('Escape')
    // The thumbnail debounce (500 ms) and the render behind it.
    await page.waitForTimeout(3500)
  }

  // One small edit and nothing else: all that follows is the sidebar thumbnail.
  const nudgeGesture = async (endOfInput: () => Promise<void>): Promise<void> => {
    await page.evaluate(() => window.__narrative_test_api!.updateObject('probe-rect', { x: 1301 }))
    await endOfInput()
    await page.waitForTimeout(4000)
    await page.evaluate(() => window.__narrative_test_api!.updateObject('probe-rect', { x: 1300 }))
  }

  const crowd = ['probe-rect', ...Array.from({ length: 19 }, (_, i) => `text-${i}`)]
  await measure(page, cdp, 'idle', async (end) => {
    await page.waitForTimeout(3000)
    await end()
  })
  await measure(page, cdp, 'edit-nudge (thumbnail)', nudgeGesture)
  await measure(page, cdp, 'drag-rect', dragProbe('probe-rect', 90))
  await measure(page, cdp, 'drag-text', dragProbe('probe-text', 90))
  await measure(page, cdp, 'drag-image', dragProbe('probe-img', 90))
  await measure(page, cdp, 'drag-20-selected', dragProbe('probe-rect', 90, crowd))
  await measure(page, cdp, 'zoom-wheel+settle', zoomGesture)
  await measure(page, cdp, 'type-60-chars', typeGesture)

  // The same again with every mask off the scene — from the same view as before.
  await page.keyboard.press('ControlOrMeta+0')
  await page.waitForTimeout(1500)
  const stripped = await page.evaluate(() => {
    const sg = window.__narrative_scene_graph as unknown as {
      getRoot: () => { children: unknown[] }
    }
    let n = 0
    const walk = (c: { mask?: { visible: boolean } | null; children?: unknown[] }): void => {
      if (c.mask) {
        c.mask.visible = false
        c.mask = null
        n++
      }
      for (const ch of c.children ?? []) walk(ch as never)
    }
    walk(sg.getRoot() as never)
    return n
  })
  console.log('PERF masks removed for the [no-mask] rows:', stripped)
  await measure(page, cdp, 'drag-rect [no-mask]', dragProbe('probe-rect', 90))
  await measure(page, cdp, 'drag-20 [no-mask]', dragProbe('probe-rect', 90, crowd))
  await measure(page, cdp, 'zoom [no-mask]', zoomGesture)

  writeFileSync(
    OUT,
    JSON.stringify({ info, config: { N_TEXTS, N_IMAGES, N_RECTS }, rows }, null, 2),
  )
  console.log('PERF results written to', OUT)
  expect(rows.length).toBeGreaterThan(0)
})
