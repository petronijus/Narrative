/**
 * e2e/perf/lib/presentDecks.ts — the present-mode decks (packages/perf
 * scenes.ts → present*Ops), seeded through the command API, and opening a
 * presentation until it is ready. Shared by the present benches
 * (present.spec.ts) and the visual spec that proves every advance shows its
 * slide whole (e2e/present-smooth.spec.ts).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import type { PresentScene } from '@narrative/perf'
import {
  presentBuildOps,
  presentPhotoOps,
  presentTextOps,
  presentTransitionOps,
  presentVideoOps,
} from '@narrative/perf'
import { presentPhotoFiles, presentVideoFile } from '@narrative/perf/node'
import { expect } from '../../fixtures/test'
import { API_BASE, applyOps, command, photoFiles, uploadPhotos } from './seed'

const BLOCK_FONT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'block-font.ttf',
)
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

export type DeckKind = 'text' | 'photo' | 'transitions' | 'builds' | 'video'

export interface PresentDeck {
  kind: DeckKind
  id: string
  slideIds: string[]
  scene: PresentScene
  /** Clicks each slide's onClick builds take (builds deck). */
  clicks?: number[]
}

async function folderCommand<T>(
  context: BrowserContext,
  target: Record<string, string>,
  name: string,
  input: unknown,
): Promise<T> {
  const res = await context.request.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target, command: name, input },
    timeout: 120_000,
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${name}: ${body.error?.message ?? res.status()}`).toBe(true)
  return body.result
}

async function newDeck(context: BrowserContext, title: string, folderId?: string): Promise<string> {
  const res = await context.request.post(`${API_BASE}/decks`, {
    data: { title, ...(folderId !== undefined ? { folderId } : {}) },
  })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  return ((await res.json()) as { id: string }).id
}

async function slideIdsOf(context: BrowserContext, deckId: string): Promise<string[]> {
  const deck = await command<{ slides: Array<{ id: string }> }>(
    context.request,
    deckId,
    'query.deck',
    {},
  )
  return deck.slides.map((s) => s.id)
}

export async function seedDeck(
  context: BrowserContext,
  kind: DeckKind,
  label: string,
): Promise<PresentDeck> {
  const title = `perf present ${kind} (${label})`
  if (kind === 'text') {
    const folder = await folderCommand<{ id: string }>(context, {}, 'folder.create', {
      name: `${title} ${Date.now()}`,
    })
    const { family } = await folderCommand<{ family: string }>(
      context,
      { folderId: folder.id },
      'folder.fonts.upload',
      { file: { base64: readFileSync(BLOCK_FONT).toString('base64'), filename: 'block-font.ttf' } },
    )
    const id = await newDeck(context, title, folder.id)
    const scene = presentTextOps(12, family)
    await applyOps(context.request, id, scene.ops)
    return { kind, id, slideIds: await slideIdsOf(context, id), scene }
  }
  const id = await newDeck(context, title)
  if (kind === 'photo') {
    const assets = await uploadPhotos(context.request, id, presentPhotoFiles())
    const scene = presentPhotoOps(12, assets)
    await applyOps(context.request, id, scene.ops)
    const slideIds = await slideIdsOf(context, id)
    // Slide 1 links to slide 9 and slide 9 back to slide 1 (present.jump.link).
    for (const [from, to] of [
      [0, 8],
      [8, 0],
    ] as const)
      await command(context.request, id, 'object.update', {
        slide: { index: from },
        object: `q${from}-link`,
        patch: { hyperlink: { kind: 'slide', slideId: slideIds[to]! } },
      })
    return { kind, id, slideIds, scene }
  }
  if (kind === 'transitions' || kind === 'builds') {
    const assets = await uploadPhotos(context.request, id, photoFiles())
    const scene = kind === 'transitions' ? presentTransitionOps(assets) : presentBuildOps(assets)
    await applyOps(context.request, id, scene.ops)
    return {
      kind,
      id,
      slideIds: await slideIdsOf(context, id),
      scene,
      ...('clicks' in scene ? { clicks: scene.clicks } : {}),
    }
  }
  // video
  const file = presentVideoFile(10)
  const up = await command<{ assetId: string }>(context.request, id, 'media.upload', {
    file: { base64: readFileSync(file).toString('base64'), filename: 'present-video.mp4' },
  })
  await expect
    .poll(
      async () =>
        (
          await command<{ transcodeStatus: string | null }>(context.request, id, 'media.status', {
            assetId: up.assetId,
          })
        ).transcodeStatus,
      { timeout: 300_000, intervals: [1000], message: 'the video was not transcoded' },
    )
    .toBe('done')
  const scene = presentVideoOps(up.assetId)
  await applyOps(context.request, id, scene.ops)
  return { kind, id, slideIds: await slideIdsOf(context, id), scene }
}

/** Open the presentation at its first slide and wait until it is ready; ms from navigation. */
export async function openPresentation(page: Page, deck: PresentDeck): Promise<number> {
  await page.goto(`/deck/${deck.id}/present?perf=1&slide=1`, { waitUntil: 'commit' })
  return page.evaluate(
    async ({ first, ids, quietMs }) => {
      const until = (cond: () => boolean, timeoutMs: number): Promise<void> =>
        new Promise((resolve, reject) => {
          const end = performance.now() + timeoutMs
          const tick = (): void => {
            if (cond()) return resolve()
            if (performance.now() > end) return reject(new Error('presentation not ready'))
            requestAnimationFrame(tick)
          }
          tick()
        })
      await until(() => {
        const h = window.__narrative_perf_harness
        const el = document.querySelector('[data-testid="slide-container"]')
        if (h === undefined || el === null) return false
        if (el.getAttribute('data-active-slide-id') !== first) return false
        // Builds that prepare before they show say so; older builds only have the overlay.
        if (el.getAttribute('data-present-ready') === 'false') return false
        if (document.querySelector('[role="status"][aria-label="Preparing presentation"]'))
          return false
        const have = new Set(h.mountedIds())
        return ids.every((i) => have.has(i))
      }, 300_000)
      const h = window.__narrative_perf_harness!
      const r = await h.settle({ quietMs, timeoutMs: 120_000 })
      if (!r.ok) throw new Error(`the first slide did not settle: ${r.reason}`)
      return performance.now() - quietMs
    },
    { first: deck.slideIds[0]!, ids: deck.scene.perSlide[0]!, quietMs: 800 },
  )
}

/** Click a point of the slide (slide px) on screen. */
export async function clickSlide(page: Page, at: { x: number; y: number }): Promise<void> {
  const box = (await page.locator('[data-testid="slide-container"]').boundingBox())!
  const k = box.width / 1920
  await page.mouse.click(box.x + at.x * k, box.y + at.y * k)
}
