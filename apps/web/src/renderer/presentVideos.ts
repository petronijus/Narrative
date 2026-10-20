/**
 * renderer/presentVideos.ts — the videos of a presentation, buffered before
 * it starts (docs/plans/performance.md → D, P3; ADR 0016).
 *
 * In the editor a video slide creates its `<video>` when it is shown and
 * shows the poster until the element can play, then swaps the live frames
 * in. In present mode that was a load on the advance — a request, a decoder
 * started, the poster replaced by the first frame a moment later. Here every
 * video object of the deck gets its element when the presentation is
 * prepared: its playback file requested with `preload="auto"`, buffered until
 * the element can play through, moved to its first frame (the poster frame,
 * else the trim start) and decoded there, then handed to the video renderer
 * (`attachLiveVideo`), so every scene of that slide — the prepared one off
 * stage included — draws the live frame from the start. The slide's
 * EditorVideoPreview (present mode) plays and pauses that element; it never
 * loads one of its own.
 *
 * The file is not copied into memory: the production CSP allows media from
 * the origin only (`media-src 'self'`, ADR 0007), so a blob URL would be
 * refused. The element's own buffer is what is ready ahead; the browser keeps
 * reading the file as it plays.
 *
 * A video larger than 1080p plays its 1080p rendition when the screen shows
 * no more pixels than it has (renderer/videoRendition.ts, P3): a quarter of
 * the decode and upload of a 4K original per frame.
 *
 * Leaving a video's slide pauses the element and puts it back on its first
 * frame (`rewind`), as a new element would start there.
 */

import type { Slide, VideoObject } from '@narrative/shared'
import { attachLiveVideo } from './objectRenderers/videoRenderer.js'
import { getDefaultVideoInfoResolver, type VideoInfoResult } from './videoInfo.js'
import { trackRenderWork } from './renderWork.js'
import { choosePlayback, presentStageScale, type PlaybackChoice } from './videoRendition.js'

/** One buffered video: its element and the info it was opened with. */
export interface PresentVideo {
  objectId: string
  element: HTMLVideoElement
  info: VideoInfoResult
  /** The first frame the element shows: the poster frame, else the trim start (s). */
  startAt: number
  /** Which file it plays (the 1080p rendition or the original). */
  kind: PlaybackChoice['kind']
}

/** A video that has not buffered within this long is kept as it is (it streams while it plays). */
const BUFFER_TIMEOUT_MS = 30_000

function startOf(v: VideoObject): number {
  const trimStart = Math.max(0, v.trimStart ?? 0)
  const posterTime = v.posterTime ?? 0
  return posterTime > 0 ? Math.max(trimStart, posterTime) : trimStart
}

function once(el: HTMLVideoElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      el.removeEventListener(event, on)
      el.removeEventListener('error', fail)
      resolve(false)
    }, timeoutMs)
    const on = (): void => {
      clearTimeout(timer)
      el.removeEventListener('error', fail)
      resolve(true)
    }
    const fail = (): void => {
      clearTimeout(timer)
      el.removeEventListener(event, on)
      resolve(false)
    }
    el.addEventListener(event, on, { once: true })
    el.addEventListener('error', fail, { once: true })
  })
}

export class PresentVideoPool {
  private readonly videos = new Map<string, PresentVideo>()
  private readonly host: HTMLDivElement
  private destroyed = false

  constructor() {
    // The elements live in the document (some engines decode a detached
    // element lazily), out of sight and out of the way.
    this.host = document.createElement('div')
    this.host.setAttribute('aria-hidden', 'true')
    Object.assign(this.host.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      opacity: '0',
      pointerEvents: 'none',
    })
    document.body.appendChild(this.host)
  }

  /** The video objects of `slides`, deck order. */
  static videosOf(slides: readonly Slide[]): VideoObject[] {
    const out: VideoObject[] = []
    for (const s of slides)
      for (const o of s.objects)
        if (o.type === 'video' && (o as VideoObject).assetId !== '') out.push(o as VideoObject)
    return out
  }

  /**
   * Buffer every video of `videos` (several at once); resolves when each is
   * ready on its first frame, failed, or timed out. A video already buffered
   * is kept. `onProgress` after each one.
   */
  async prepare(
    videos: readonly VideoObject[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    let done = 0
    await Promise.all(
      videos.map(async (v) => {
        try {
          if (!this.videos.has(v.id)) await this.open(v)
        } catch (err) {
          console.warn('[presentVideos] could not buffer a video', v.id, err)
        } finally {
          done++
          onProgress?.(done, videos.length)
        }
      }),
    )
  }

  /** The buffered video of an object, or null. */
  get(objectId: string): PresentVideo | null {
    return this.videos.get(objectId) ?? null
  }

  /** Pause the video and put it back on its first frame (its slide left the stage). */
  rewind(objectId: string): Promise<void> {
    const v = this.videos.get(objectId)
    if (v === undefined) return Promise.resolve()
    v.element.pause()
    if (Math.abs(v.element.currentTime - v.startAt) < 0.01) return Promise.resolve()
    v.element.currentTime = v.startAt
    return once(v.element, 'seeked', 5000).then(() => undefined)
  }

  /** The playback URL expired (MEDIA-1): open it again with a fresh one, keeping the position. */
  async refresh(objectId: string): Promise<void> {
    const v = this.videos.get(objectId)
    if (v === undefined) return
    const info = await getDefaultVideoInfoResolver()({
      assetId: v.info.assetId,
      forceRefresh: true,
    })
    // The same file as before, freshly signed.
    const url = v.kind === 'present' ? (info.presentPlayback?.url ?? null) : info.playbackUrl
    if (url === null) return
    const at = v.element.currentTime
    const playing = !v.element.paused
    v.info = info
    v.element.src = url
    v.element.load()
    if (await once(v.element, 'loadedmetadata', BUFFER_TIMEOUT_MS)) {
      v.element.currentTime = at
      if (playing) void v.element.play().catch(() => undefined)
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const v of this.videos.values()) {
      v.element.pause()
      v.element.removeAttribute('src')
      v.element.load()
    }
    this.videos.clear()
    this.host.remove()
  }

  private async open(v: VideoObject): Promise<void> {
    const info = await trackRenderWork(getDefaultVideoInfoResolver()({ assetId: v.assetId }))
    if (this.destroyed || info.transcodeStatus !== 'done') return
    const chosen = choosePlayback(info, v, presentStageScale())
    if (chosen === null) return
    const el = document.createElement('video')
    // As EditorVideoPreview's own element: muted unless the object says
    // otherwise, inline, no autoplay (the slide starts it), its loop.
    el.muted = v.muted ?? true
    el.playsInline = true
    el.autoplay = false
    el.loop = v.loop ?? false
    el.preload = 'auto'
    el.setAttribute('aria-hidden', 'true')
    el.volume = Math.max(0, Math.min(1, v.volume ?? 1))
    this.host.appendChild(el)
    el.src = chosen.url
    el.load()
    const startAt = startOf(v)
    // Buffered far enough to play through, then on its first frame, decoded.
    await once(el, 'canplaythrough', BUFFER_TIMEOUT_MS)
    if (startAt > 0 && Math.abs(el.currentTime - startAt) > 0.01) {
      el.currentTime = startAt
      await once(el, 'seeked', 5000)
    }
    if (this.destroyed) return
    this.videos.set(v.id, { objectId: v.id, element: el, info, startAt, kind: chosen.kind })
    // Every scene of this video — on stage and prepared — draws the live frame.
    attachLiveVideo(v.id, el)
  }
}
