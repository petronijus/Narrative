/**
 * present-video-rendition.spec.ts — a 4K video in present mode plays the
 * file the display needs (docs/plans/performance.md → P3,
 * renderer/videoRendition.ts, renderer/presentVideos.ts): the original where
 * the presentation shows more than 1080p, the video worker's 1080p rendition
 * (present.mp4) where it does not, and the other file once the display
 * changes — buffered off stage and switched only while the video is not on
 * the slide shown.
 *
 * Where the original does not play smoothly on this engine (its trial
 * playback missed frames), the rendition plays and nothing brings the
 * original back.
 *
 * The source: 2 s of 3840 × 2160 testsrc2, made with ffmpeg once per machine
 * (uploaded through tus: it is over the command API's body); the dev video worker copies it
 * as the playback file and encodes present.mp4 beside it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { presentVideoOps } from '@narrative/perf'
import { expect, test } from './fixtures/test'
import { tusUpload } from './perf/lib/presentDecks'
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

/** Frames decoded so far by the page's playing videos (`getVideoPlaybackQuality`). */
function decodedFrames(page: Page): Promise<number> {
  return page.evaluate(() =>
    [...document.querySelectorAll('video')]
      .filter((v) => !v.paused)
      .reduce((n, v) => n + v.getVideoPlaybackQuality().totalVideoFrames, 0),
  )
}

/**
 * The canvas shows the video moving: a picture of the slide, then pictures
 * every 400 ms until one differs (testsrc2 moves) — for up to 20 s, while
 * the playing video decodes frames. One pair 400 ms apart was not enough:
 * the deck's video loops 0–1.8 s by seeking back to its start, and under
 * load (15–70, the e2e browser at nice 19) a seek took seconds (readyState
 * 1, currentTime 0 across 15 s, 2026-11-01) with the canvas rightly showing
 * the last frame all that time — the video and the canvas went on in every
 * probe, the next picture differed within three. Returns the frames the
 * video decoded meanwhile too, so a canvas that stays still while the video
 * plays fails with the evidence.
 */
async function canvasMoves(page: Page): Promise<{ moved: boolean; decoded: number }> {
  const slide = page.getByTestId('slide-container')
  const first = await slide.screenshot()
  const before = await decodedFrames(page)
  const end = Date.now() + 20_000
  let moved = false
  while (!moved && Date.now() < end) {
    await page.waitForTimeout(400)
    moved = !(await slide.screenshot()).equals(first)
  }
  return { moved, decoded: (await decodedFrames(page)) - before }
}

/** Assert that the canvas follows the playing video (`canvasMoves`). */
async function expectCanvasMoves(page: Page, what: string): Promise<void> {
  const { moved, decoded } = await canvasMoves(page)
  expect(moved, `${what} (the video decoded ${decoded} frames meanwhile)`).toBe(true)
}

async function shows(page: Page, slideId: string): Promise<void> {
  await expect(page.getByTestId('slide-container')).toHaveAttribute('data-active-slide-id', slideId)
}

/**
 * A Retina laptop's window (the slide 1600 px wide at 2× shows 3200 device
 * px), with the 4K video deck seeded and present mode open and ready. The
 * trial playback that decides whether the original plays smoothly here
 * (renderer/videoPlaybackTrial.ts) is decided for the test (`trial`), so the
 * spec does not depend on this machine's GPU (`?perf=1` loads the harness
 * that reads it).
 */
async function presentation4k(
  browser: Browser,
  trial: 'smooth' | 'rough',
): Promise<{ context: BrowserContext; page: Page; slideIds: string[] }> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
  })
  await context.addInitScript((t) => {
    ;(window as unknown as { __narrative_perf_videoTrial?: string }).__narrative_perf_videoTrial = t
  }, trial)
  const page = await context.newPage()
  const deckId = await createDeck(context.request, `present 4k rendition ${trial} ${Date.now()}`)
  // ~8 MB: over the command API's 4 MB body, so through tus as the editor uploads.
  const assetId = await tusUpload(context, deckId, source4k(), 'video/mp4')
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
  await page.goto(`/deck/${deckId}/present?perf=1&slide=1`)
  await expect(page.getByTestId('slide-container')).toHaveAttribute('data-present-ready', 'true', {
    timeout: 120_000,
  })
  return { context, page, slideIds: deck.slides.map((s) => s.id) }
}

test('a 4K video plays the file the display needs, switched off stage', async ({ browser }) => {
  test.setTimeout(240_000)
  const { context, page, slideIds } = await presentation4k(browser, 'smooth')
  expect(await files(page)).toEqual(['playback.mp4'])
  // The window shrinks to 800 × 450 (0.83 device px per slide px): the
  // rendition is enough. The video is off stage, so it switches.
  await page.setViewportSize({ width: 800, height: 450 })
  await expect.poll(() => files(page), { timeout: 30_000 }).toEqual(['present.mp4'])

  // Its slide plays the rendition.
  await page.keyboard.press('ArrowRight')
  await shows(page, slideIds[1]!)
  await expect.poll(() => files(page, 'playing'), { timeout: 10_000 }).toEqual(['present.mp4'])
  await expectCanvasMoves(page, 'the canvas follows the playing rendition')

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
  await expectCanvasMoves(page, 'the canvas follows the playing original')
  await context.close()
})

test('a 4K original that does not play smoothly here is never played', async ({ browser }) => {
  test.setTimeout(240_000)
  // WebKit at 2× (2026-10-26): the original's trial missed frames.
  const { context, page, slideIds } = await presentation4k(browser, 'rough')
  expect(await files(page)).toEqual(['present.mp4'])
  await page.keyboard.press('ArrowRight')
  await shows(page, slideIds[1]!)
  await expect.poll(() => files(page, 'playing'), { timeout: 10_000 }).toEqual(['present.mp4'])
  await expectCanvasMoves(page, 'the canvas follows the playing rendition')
  // A display change does not bring the original back, on stage or off it.
  await page.setViewportSize({ width: 800, height: 450 })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.keyboard.press('ArrowRight')
  await shows(page, slideIds[2]!)
  await page.waitForTimeout(2000)
  expect(await files(page)).toEqual(['present.mp4'])
  await context.close()
})
