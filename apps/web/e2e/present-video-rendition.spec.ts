/**
 * present-video-rendition.spec.ts — a 4K video in present mode plays the
 * file the display needs (docs/plans/performance.md → P3,
 * renderer/videoRendition.ts, renderer/presentVideos.ts): the original where
 * the presentation shows more than 1080p, the video worker's 1080p rendition
 * (present.mp4) where it does not, and the other file once the display
 * changes — buffered off stage and switched only while the video is not on
 * the slide shown.
 *
 * The source: 2 s of 3840 × 2160 testsrc2, made with ffmpeg once per machine
 * (small enough for the command API's body); the dev video worker copies it
 * as the playback file and encodes present.mp4 beside it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { presentVideoOps } from '@narrative/perf'
import { expect, test } from './fixtures/test'
import { applyOps, command, createDeck } from './perf/lib/seed'

function source4k(): string {
  const dir = path.join(tmpdir(), 'narrative-e2e')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'testsrc2-2160p-2s.mp4')
  if (!existsSync(file)) {
    const partial = `${file}.partial.mp4`
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=2'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '32'],
      ...['-movflags', '+faststart', '-y', partial],
    ])
    renameSync(partial, file)
  }
  return file
}

/** The file each buffered video element of the page plays, by name (playback.mp4 / present.mp4). */
function files(page: Page, which: 'all' | 'playing' = 'all'): Promise<string[]> {
  return page.evaluate(
    (which) =>
      [...document.querySelectorAll('video')]
        .filter((v) => which === 'all' || !v.paused)
        .map((v) => new URL(v.currentSrc || v.src).pathname.split('/').at(-1) ?? '')
        .sort(),
    which,
  )
}

/** The canvas shows the video moving: two pictures of the slide a moment apart differ (testsrc2 moves). */
async function canvasMoves(page: Page): Promise<boolean> {
  const slide = page.getByTestId('slide-container')
  const a = await slide.screenshot()
  await page.waitForTimeout(400)
  const b = await slide.screenshot()
  return !a.equals(b)
}

async function shows(page: Page, slideId: string): Promise<void> {
  await expect(page.getByTestId('slide-container')).toHaveAttribute('data-active-slide-id', slideId)
}

test('a 4K video plays the file the display needs, switched off stage', async ({ browser }) => {
  test.setTimeout(240_000)
  // A Retina laptop's window: the slide 1600 px wide at 2× shows 3200 device px.
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const deckId = await createDeck(context.request, `present 4k rendition ${Date.now()}`)
  const { assetId } = await command<{ assetId: string }>(context.request, deckId, 'media.upload', {
    file: { base64: readFileSync(source4k()).toString('base64'), filename: '4k.mp4' },
  })
  await expect
    .poll(
      async () => {
        const s = await command<{ transcodeStatus: string | null; presentPlayback: unknown }>(
          context.request,
          deckId,
          'media.status',
          { assetId },
        )
        return s.transcodeStatus === 'done' && s.presentPlayback !== null
      },
      { timeout: 180_000, intervals: [1000], message: 'no 1080p rendition' },
    )
    .toBe(true)
  // Looped, so it is still playing whenever the spec looks.
  await applyOps(
    context.request,
    deckId,
    presentVideoOps(assetId, { loop: { trimStart: 0, trimEnd: 1.8 } }).ops,
  )
  const deck = await command<{ slides: Array<{ id: string }> }>(
    context.request,
    deckId,
    'query.deck',
    {},
  )
  const slideIds = deck.slides.map((s) => s.id)

  await page.goto(`/deck/${deckId}/present?slide=1`)
  await expect(page.getByTestId('slide-container')).toHaveAttribute('data-present-ready', 'true', {
    timeout: 120_000,
  })
  expect(await files(page)).toEqual(['playback.mp4'])

  // The window shrinks to 800 × 450 (0.83 device px per slide px): the
  // rendition is enough. The video is off stage, so it switches.
  await page.setViewportSize({ width: 800, height: 450 })
  await expect.poll(() => files(page), { timeout: 30_000 }).toEqual(['present.mp4'])

  // Its slide plays the rendition.
  await page.keyboard.press('ArrowRight')
  await shows(page, slideIds[1]!)
  await expect.poll(() => files(page, 'playing'), { timeout: 10_000 }).toEqual(['present.mp4'])
  expect(await canvasMoves(page), 'the canvas follows the playing rendition').toBe(true)

  // Large again while the video is on stage: the original is buffered, but
  // the playing video keeps its file…
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect.poll(() => files(page), { timeout: 30_000 }).toEqual(['playback.mp4', 'present.mp4'])
  expect(await files(page, 'playing')).toEqual(['present.mp4'])

  // …and switches once its slide has left the stage.
  await page.keyboard.press('ArrowRight')
  await shows(page, slideIds[2]!)
  await expect.poll(() => files(page), { timeout: 30_000 }).toEqual(['playback.mp4'])

  // Back on its slide, the original plays.
  await page.keyboard.press('ArrowLeft')
  await shows(page, slideIds[1]!)
  await expect.poll(() => files(page, 'playing'), { timeout: 10_000 }).toEqual(['playback.mp4'])
  expect(await canvasMoves(page), 'the canvas follows the playing original').toBe(true)
  await context.close()
})
