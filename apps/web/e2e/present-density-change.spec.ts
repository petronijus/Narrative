/**
 * present-density-change.spec.ts — present mode follows a change of the
 * display's density after it opened (the window moved to a screen of
 * another density): the slides are prepared again for the new density
 * while the old set presents, and the new set takes over without a blank
 * frame (present/densityHandover.ts, docs/plans/performance.md → F2).
 *
 * Chromium only (CDP): the presentation opens at devicePixelRatio 1, then
 * `Emulation.setDeviceMetricsOverride` makes the page 2× — the page sees
 * the change as a real display change does (`devicePixelRatio`, the
 * `resolution` media query, a resize; see `setScale`). Present mode's
 * canvas draws the region of ADR 0020 (its backing store is the viewport and
 * its margins at the ratio, `backingFor`), and the handover is the only owner
 * of its density (ADR 0020 → Present mode). Asserted:
 *   - the canvas ends up drawing at 2 device pixels per CSS pixel (its
 *     backing store the region's for the viewport at 2);
 *   - no work on stage: the texts on stage keep their rasters from the
 *     change to the swap, and from the swap on nothing is rasterised or
 *     uploaded — not while the presentation settles, not on the advances
 *     after it (present mode does no work after ready, ADR 0016);
 *   - no blank frame: every backbuffer reallocation of the present canvas is
 *     drawn in the same task (a resize clears it; a frame composited before
 *     the next draw would be empty), and every frame drawn from the change on
 *     shows the slide (the harness's frame capture, never mostly black);
 *   - the pixels after the swap are the 2× slide, sharp: they match a
 *     presentation opened at 2× from the start (texts rasterised at 2), edge
 *     energy included;
 *   - the advances afterwards show their slides whole on their first frames.
 *
 * And with texts where the device grid decides their pixels (fractional
 * positions, several sizes and alignments): the standby set's texts are
 * rasterised before the canvas switches, so they are placed on the grid the
 * canvas will have at the new density (CanvasInstance.preparePixelRatio,
 * runText/placement.ts → setProspectivePage), not left off it because the
 * canvas still drew at the old one when they were painted — the slide after
 * the swap is pixel for pixel the one a presentation opened at 2× shows.
 */

import type { BrowserContext, CDPSession, Page } from '@playwright/test'
import { PNG } from 'pngjs'
import type { CapturedFrame } from '../src/perf/harness'
import { backingFor } from '../src/renderer/canvasRegion'
import { expect, test } from './fixtures/test'
import { openPresentation, seedDeck, type PresentDeck } from './perf/lib/presentDecks'
import { applyOps, command, createDeck } from './perf/lib/seed'

const VIEWPORT = { width: 1600, height: 900 }

/**
 * Counts backbuffer reallocations of the present canvas that were not
 * followed by a draw call into it (not into a render texture) in the same
 * task (window.__densityBlank), and every reallocation
 * (window.__densityResizes). `window.__densityStageTexts()` lists the
 * rasters the texts on stage are drawn from (their textures' uids); once
 * `__densityArmed` holds a width, the first reallocation to it — the swap's,
 * in the task the new set takes over, before the slide is swapped — records
 * them and the perf counters in `__densityAtSwap`. (The resizes `setScale`
 * makes reallocate the canvas too, at the old density.)
 */
const BLANK_PROBE = `(() => {
  const w = window
  w.__densityBlank = 0
  w.__densityResizes = 0
  w.__densityArmed = 0
  w.__densityAtSwap = null
  w.__densityStageTexts = () => {
    const sg = w.__narrative_scene_graph
    if (sg === undefined) return null
    const app = sg.getApp()
    const uid = app.renderer.uid
    const out = []
    const walk = (c) => {
      if (c.anchor !== undefined && '_didTextUpdate' in c && c.visible) {
        const t = c._gpuData && c._gpuData[uid] && c._gpuData[uid].texture
        out.push(t ? String(t.uid) + '@' + String(c._resolution) : 'none')
      }
      for (const child of c.children) walk(child)
    }
    walk(app.stage)
    return out.sort()
  }
  let drawn = true
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const original = proto[name]
      if (typeof original !== 'function') continue
      proto[name] = function (...args) {
        if (this.canvas === w.__densityCanvas && this.getParameter(this.FRAMEBUFFER_BINDING) === null) drawn = true
        return original.apply(this, args)
      }
    }
  }
  const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')
  Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
    get() { return desc.get.call(this) },
    set(v) {
      const changed = desc.get.call(this) !== v
      desc.set.call(this, v)
      if (!changed || this !== w.__densityCanvas) return
      w.__densityResizes++
      if (w.__densityArmed === v && w.__densityAtSwap === null)
        w.__densityAtSwap = {
          counters: w.__narrative_perf_harness.counters(),
          stageTexts: w.__densityStageTexts(),
        }
      drawn = false
      // After the task that resized it: was the canvas drawn again in it?
      queueMicrotask(() => { if (!drawn) w.__densityBlank++ })
    },
    configurable: true,
  })
})()`

interface ProbeWindow {
  __densityBlank: number
  __densityResizes: number
  __densityCanvas?: HTMLCanvasElement
  __densityArmed: number
  __densityAtSwap: { counters: Record<string, number>; stageTexts: string[] | null } | null
  __densityStageTexts(): string[] | null
}

/** The work counters that must not move once the presentation is ready (ADR 0016). */
const WORK = ['text.raster.started', 'gl.texUpload'] as const

function workOf(c: Record<string, number>): Record<string, number> {
  return Object.fromEntries(WORK.map((k) => [k, c[k] ?? 0]))
}

/**
 * The size of the present canvas's backing store at `ratio`: the region's
 * for the viewport it lays out for (canvasRegion.ts → backingFor), read from
 * the region controller (dev builds expose it).
 */
async function backingAt(page: Page, ratio: number): Promise<{ width: number; height: number }> {
  const viewport = await page.evaluate(() => {
    const region = (
      window as unknown as {
        __narrative_canvas_region?: { debugState(): { viewport: DOMRect } }
      }
    ).__narrative_canvas_region
    if (region === undefined) throw new Error('no canvas region (a dev build exposes it)')
    const v = region.debugState().viewport
    return { width: v.width, height: v.height }
  })
  return backingFor(viewport, ratio)
}

async function presentCanvas(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="slide-container"] canvas')!
    ;(window as unknown as ProbeWindow).__densityCanvas = c
    return { width: c.width, height: c.height }
  })
}

/**
 * The slide as the page shows it, in device pixels — through CDP: under an
 * emulated density Playwright's own screenshot stays at the context's scale.
 */
async function slideShot(page: Page, cdp: CDPSession): Promise<PNG> {
  const box = (await page.locator('[data-testid="slide-container"]').boundingBox())!
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
  })
  return PNG.sync.read(Buffer.from(data, 'base64'))
}

/**
 * How two same-sized pictures differ: the pixels whose largest channel
 * difference exceeds `tolerance`, and the largest difference.
 */
function pixelDiff(a: PNG, b: PNG, tolerance = 2): { differing: number; max: number } {
  expect([a.width, a.height]).toEqual([b.width, b.height])
  let differing = 0
  let max = 0
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i + k]! - b.data[i + k]!))
    if (d > tolerance) differing++
    max = Math.max(max, d)
  }
  return { differing, max }
}

/**
 * A deck whose texts sit where the device grid decides their pixels: boxes at
 * fractional slide px (the presentation scales the slide too), sizes from 11
 * to 72 px, left / centred / right, one and several lines, regular and bold —
 * four slides, so the advances after the swap have slides to go to.
 */
async function seedGridDeck(context: BrowserContext): Promise<PresentDeck> {
  const id = await createDeck(context.request, `e2e density grid ${Date.now()}`)
  const sizes = [11, 13.5, 17, 23, 31, 48, 72]
  const aligns = ['left', 'center', 'right'] as const
  const ops: Array<{ command: string; input: unknown }> = []
  const perSlide: string[][] = []
  for (let s = 1; s < 4; s++) ops.push({ command: 'slide.add', input: {} })
  for (let s = 0; s < 4; s++) {
    const ids: string[] = []
    let y = 41.37 + s * 3.29
    for (const [i, size] of sizes.entries()) {
      const objectId = `g${s}-${i}`
      const lines = i % 3 === 1 ? 2 : 1
      const height = Math.ceil(size * 1.3 * lines) + 0.61
      ops.push({
        command: 'object.create',
        input: {
          slide: { index: s },
          id: objectId,
          object: {
            type: 'text',
            x: 63.41 + i * 17.13 + s * 0.37,
            y,
            width: 1400.77 - i * 31.3,
            height,
            text: {
              paragraphs: Array.from({ length: lines }, (_, l) => ({
                text: `Grid ${s + 1}.${i + 1}${l > 0 ? ' — second line, still on the grid' : ''}: the quick brown fox jumps over the lazy dog`,
              })),
            },
            fontSize: size,
            fontWeight: i % 2 === 0 ? 400 : 700,
            color: '#1b2a4a',
            align: aligns[i % 3],
            rotation: 0,
            opacity: 1,
          },
        },
      })
      ids.push(objectId)
      y += height + 9.43
    }
    perSlide.push(ids)
  }
  await applyOps(context.request, id, ops)
  const deck = await command<{ slides: Array<{ id: string }> }>(
    context.request,
    id,
    'query.deck',
    {},
  )
  return {
    kind: 'text',
    id,
    slideIds: deck.slides.map((x) => x.id),
    scene: { ops, perSlide } as unknown as PresentDeck['scene'],
  }
}

/** Mean absolute channel difference of two same-sized pictures. */
function meanDiff(a: PNG, b: PNG): number {
  expect([a.width, a.height]).toEqual([b.width, b.height])
  let sum = 0
  for (let i = 0; i < a.data.length; i += 4)
    for (let k = 0; k < 3; k++) sum += Math.abs(a.data[i + k]! - b.data[i + k]!)
  return sum / ((a.data.length / 4) * 3)
}

/** Edge energy: the summed absolute difference of horizontal neighbours (sharp text has more of it). */
function edgeEnergy(p: PNG): number {
  let e = 0
  for (let y = 0; y < p.height; y++)
    for (let x = 1; x < p.width; x++) {
      const i = (y * p.width + x) * 4
      e += Math.abs(p.data[i]! - p.data[i - 4]!)
    }
  return e
}

/** A frame that is mostly black: the canvas drawn empty (the page behind it is black). */
function mostlyBlack(f: CapturedFrame): boolean {
  let dark = 0
  const n = f.cells.length / 3
  for (let c = 0; c < n; c++)
    if (f.cells[c * 3]! < 16 && f.cells[c * 3 + 1]! < 16 && f.cells[c * 3 + 2]! < 16) dark++
  return dark > n / 2
}

/**
 * Make the page `deviceScaleFactor`×. Chromium applies an emulated density
 * at once (`devicePixelRatio`), but re-evaluates media queries and fires
 * `resize` only with the next viewport change (measured 2026-10-26: neither
 * fired for the density alone) — so the override goes through a viewport one
 * pixel wider and back, as a window moved to another screen is resized too.
 */
async function setScale(cdp: CDPSession, deviceScaleFactor: number): Promise<void> {
  for (const width of [VIEWPORT.width + 1, VIEWPORT.width])
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: VIEWPORT.height,
      deviceScaleFactor,
      mobile: false,
    })
}

test.describe('present mode follows a density change', () => {
  test.setTimeout(6 * 60_000)
  test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 })

  test('1× → 2× mid-presentation: re-prepared off stage, swapped with no blank frame, sharp', async ({
    browser,
    browserName,
    context,
    page,
  }) => {
    test.skip(browserName !== 'chromium', 'changes the density through CDP')
    const deck = await seedDeck(context, 'text', 'e2e density change')

    // The reference: a presentation opened at 2× from the start (the same
    // emulation, so both pictures come through the same path).
    const ref = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
    let reference: PNG
    try {
      const refPage = await ref.newPage()
      const refCdp = await ref.newCDPSession(refPage)
      await setScale(refCdp, 2)
      await openPresentation(refPage, deck)
      reference = await slideShot(refPage, refCdp)
    } finally {
      await ref.close()
    }

    await page.addInitScript(BLANK_PROBE)
    await openPresentation(page, deck)
    const at1 = await presentCanvas(page)
    const backing1 = await backingAt(page, 1)
    const backing2 = await backingAt(page, 2)
    expect(at1).toEqual(backing1)

    // The texts on stage as the change finds them.
    const atChange = await page.evaluate((swapWidth) => {
      const w = window as unknown as ProbeWindow
      w.__narrative_perf_harness!.startFrameCapture()
      w.__densityArmed = swapWidth
      return w.__densityStageTexts()
    }, backing2.width)
    expect(atChange?.length ?? 0, 'texts on stage').toBeGreaterThan(0)
    expect(atChange, 'every text on stage is drawn').not.toContain('none')
    const cdp = await page.context().newCDPSession(page)
    await setScale(cdp, 2)
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2)

    // The new set prepared, then swapped in: the canvas draws at 2.
    try {
      await expect
        .poll(async () => await presentCanvas(page), { timeout: 120_000 })
        .toEqual(backing2)
    } finally {
      const c = await page.evaluate(() => window.__narrative_perf_harness!.counters())
      console.log(
        'density change counters: ' +
          JSON.stringify(
            Object.fromEntries(
              Object.entries(c).filter(([k]) =>
                /present\.|text\.raster\.started|sg\.mount$/.test(k),
              ),
            ),
          ),
      )
    }
    const settled = await page.evaluate(() =>
      window.__narrative_perf_harness!.settle({ quietMs: 800, timeoutMs: 60_000 }),
    )
    expect(settled.ok, `did not settle after the swap: ${settled.reason}`).toBe(true)
    const frames = await page.evaluate(() => window.__narrative_perf_harness!.stopFrameCapture())
    const probe = await page.evaluate(() => {
      const w = window as unknown as ProbeWindow
      return {
        blank: w.__densityBlank,
        resizes: w.__densityResizes,
        atSwap: w.__densityAtSwap,
        settled: w.__narrative_perf_harness!.counters(),
      }
    })
    // Nothing on stage was rasterised again between the change and the swap
    // (the old set kept presenting, its texts at the old density) …
    expect(probe.atSwap, 'the swap reallocated the canvas').not.toBeNull()
    expect(probe.atSwap!.stageTexts, 'a text on stage rasterised before the swap').toEqual(atChange)
    // … and nothing at all from the swap on: the set that took over was whole.
    expect(workOf(probe.settled), 'work after the swap').toEqual(workOf(probe.atSwap!.counters))
    expect(probe.resizes, 'the canvas was reallocated for the new density').toBeGreaterThan(0)
    expect(probe.blank, 'a reallocated backbuffer composited before it was drawn').toBe(0)
    expect(frames.length, 'frames drawn across the change').toBeGreaterThan(0)
    for (const [i, f] of frames.entries())
      expect(mostlyBlack(f), `frame ${i} of ${frames.length} is empty`).toBe(false)

    // Sharp: the 2× slide as a presentation opened at 2× shows it.
    const shot2 = await slideShot(page, cdp)
    const toReference = meanDiff(shot2, reference)
    const energyRef = edgeEnergy(reference)
    const energyNow = edgeEnergy(shot2)
    console.log(
      `density change: mean diff to a fresh 2× presentation ${toReference.toFixed(2)}; ` +
        `edge energy ${(energyNow / energyRef).toFixed(3)} of the fresh 2× one; ` +
        `${probe.resizes} reallocation(s), ${frames.length} frames captured`,
    )
    expect(toReference, 'the swapped-in slide differs from a fresh 2× presentation').toBeLessThan(
      1.5,
    )
    expect(
      energyNow / energyRef,
      'the swapped-in slide is less sharp than a fresh 2× one',
    ).toBeGreaterThan(0.97)

    // Advances afterwards: the next slides from the new set, each whole on
    // its first frame, at the new density, and nothing rasterised or uploaded.
    const before = await page.evaluate(() => window.__narrative_perf_harness!.captureNow()!)
    for (const n of [1, 2, 3]) {
      await page.evaluate(() => {
        const h = window.__narrative_perf_harness!
        h.reset()
        h.startFrameCapture()
      })
      await page.keyboard.press('ArrowRight')
      await page.waitForFunction(
        (id) =>
          document
            .querySelector('[data-testid="slide-container"]')
            ?.getAttribute('data-active-slide-id') === id,
        deck.slideIds[n]!,
      )
      await page.evaluate(() => window.__narrative_perf_harness!.settle({ quietMs: 400 }))
      const after = await page.evaluate(() => window.__narrative_perf_harness!.stopFrameCapture())
      expect(after.length, `advance ${n}: frames`).toBeGreaterThan(0)
      expect(after[0]!.cols, `advance ${n}: drawn at the new density`).toBe(before.cols)
      for (const [i, f] of after.entries())
        expect(mostlyBlack(f), `advance ${n}: frame ${i} is empty`).toBe(false)
      const work = await page.evaluate(() => window.__narrative_perf_harness!.counters())
      expect(workOf(work), `advance ${n}: work after ready`).toEqual(workOf({}))
    }
  })
})

test.describe('present mode follows a density change — texts on the new device grid', () => {
  test.setTimeout(6 * 60_000)
  test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 })

  test('the standby set’s texts land where a presentation opened at 2× puts them, pixel for pixel', async ({
    browser,
    browserName,
    context,
    page,
  }) => {
    test.skip(browserName !== 'chromium', 'changes the density through CDP')
    const deck = await seedGridDeck(context)

    const ref = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
    let reference: PNG
    try {
      const refPage = await ref.newPage()
      const refCdp = await ref.newCDPSession(refPage)
      await setScale(refCdp, 2)
      await openPresentation(refPage, deck)
      reference = await slideShot(refPage, refCdp)
    } finally {
      await ref.close()
    }

    await openPresentation(page, deck)
    const backing2 = await backingAt(page, 2)
    const before = await page.evaluate(() => window.__narrative_perf_harness!.counters())
    const cdp = await page.context().newCDPSession(page)
    await setScale(cdp, 2)
    await expect.poll(async () => await presentCanvas(page), { timeout: 120_000 }).toEqual(backing2)
    const settled = await page.evaluate(() =>
      window.__narrative_perf_harness!.settle({ quietMs: 800, timeoutMs: 60_000 }),
    )
    expect(settled.ok, `did not settle after the swap: ${settled.reason}`).toBe(true)
    const counters = await page.evaluate(() => window.__narrative_perf_harness!.counters())
    const delta = (k: string): number => (counters[k] ?? 0) - (before[k] ?? 0)
    // Through the handover (not a fresh preparation on stage): a standby set
    // was prepared and swapped in.
    expect(delta('present.density.swap'), 'the standby set took over').toBe(1)

    const shot = await slideShot(page, cdp)
    const diff = pixelDiff(shot, reference)
    console.log(
      `density grid: ${diff.differing} of ${shot.width * shot.height} px differ from a fresh 2× ` +
        `presentation (max channel diff ${diff.max}); standby sets ${delta('present.density.standby')}, ` +
        `restarts ${delta('present.density.restart')}`,
    )
    expect(diff.differing, 'pixels that differ from a presentation opened at 2×').toBe(0)
  })
})
