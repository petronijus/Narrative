/**
 * e2e/perf/lib/presentDecks.ts — the present-mode decks (packages/perf
 * scenes.ts → present*Ops), seeded through the command API, and opening a
 * presentation until it is ready. Shared by the present benches
 * (present.spec.ts) and the visual spec that proves every advance shows its
 * slide whole (e2e/present-smooth.spec.ts).
 */

import { readFileSync, statSync } from 'node:fs'
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
import { presentPhotoFiles, presentVideo4kFile, presentVideoFile } from '@narrative/perf/node'
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

export type DeckKind =
  'text' | 'photo' | 'transitions' | 'builds' | 'video' | 'video4k' | 'videoLoop'

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

/**
 * Upload `file` into the deck through tus, as the editor does
 * (state/useMediaUpload.tsx: 5 MB chunks, the metadata in Upload-Metadata);
 * the media asset's id. For files over the command API's 4 MB body
 * (`media.upload` takes base64 in JSON).
 */
async function tusUpload(
  context: BrowserContext,
  deckId: string,
  file: string,
  mime: string,
): Promise<string> {
  const size = statSync(file).size
  const b64 = (v: string): string => Buffer.from(v).toString('base64')
  const filename = file.split('/').at(-1)!
  const created = await context.request.post(`${API_BASE}/api/uploads`, {
    headers: {
      Origin: WEB_ORIGIN,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Metadata': `deckId ${b64(deckId)},filename ${b64(filename)},filetype ${b64(mime)}`,
    },
  })
  expect(created.status(), `tus create: ${await created.text()}`).toBe(201)
  // A relative Location (media/tus.ts → buildPublicUploadUrl).
  const location = new URL(created.headers()['location']!, `${API_BASE}/`).toString()
  const bytes = readFileSync(file)
  const CHUNK = 5 * 1024 * 1024
  let assetId: string | null = null
  for (let offset = 0; offset < size; offset += CHUNK) {
    const res = await context.request.patch(location, {
      headers: {
        Origin: WEB_ORIGIN,
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      data: bytes.subarray(offset, Math.min(size, offset + CHUNK)),
      timeout: 120_000,
    })
    expect(res.ok(), `tus patch at ${offset}: ${res.status()} ${await res.text()}`).toBe(true)
    assetId = res.headers()['x-narrative-asset-id'] ?? assetId
  }
  expect(assetId, 'the finished upload named no asset').not.toBeNull()
  return assetId!
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
  // video: 1080p through the command API; 4K (P3) too large for its body, through tus
  const fourK = kind === 'video4k' || kind === 'videoLoop'
  const up = fourK
    ? { assetId: await tusUpload(context, id, presentVideo4kFile(10), 'video/mp4') }
    : await command<{ assetId: string }>(context.request, id, 'media.upload', {
        file: {
          base64: readFileSync(presentVideoFile(10)).toString('base64'),
          filename: 'present-video.mp4',
        },
      })
  // A 4K source's 1080p rendition is its own ffmpeg run after `done`
  // (apps/video-worker → present.mp4): waited for too.
  await expect
    .poll(
      async () => {
        const s = await command<{ transcodeStatus: string | null; presentPlayback: unknown }>(
          context.request,
          id,
          'media.status',
          { assetId: up.assetId },
        )
        return fourK && s.transcodeStatus === 'done' && s.presentPlayback === null
          ? 'done, no rendition yet'
          : s.transcodeStatus
      },
      { timeout: 300_000, intervals: [1000], message: 'the video was not transcoded' },
    )
    .toBe('done')
  // videoLoop: present.video.loop's range (packages/perf catalog → presentVideoLoop).
  const scene = presentVideoOps(
    up.assetId,
    kind === 'videoLoop' ? { loop: { trimStart: 4.5, trimEnd: 7 } } : {},
  )
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
