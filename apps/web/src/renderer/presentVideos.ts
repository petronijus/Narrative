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
 * A video larger than 1080p plays its 1080p rendition when the presentation
 * shows no more pixels than it has (renderer/videoRendition.ts, P3): a
 * quarter of the decode and upload of a 4K original per frame. What the
 * presentation shows changes after the load — it opens in the editor's
 * window and goes fullscreen later, often on another display (the
 * projector), and the presenter view takes part of the window — so the
 * choice is made again when the display changes (`displayChanged`): a video
 * that now wants the other file gets a second element, buffered on its first
 * frame as the first was, and switches to it only while it is off stage
 * (`canSwitch`: not on the slide shown, nothing moving); its scenes are then
 * warmed again (`onSwitched`). Until then the first file plays on.
 *
 * Leaving a video's slide pauses the element and puts it back on its first
 * frame (`rewind`), as a new element would start there.
 */

import type { Slide, VideoObject } from '@narrative/shared'
import { attachLiveVideo, releaseLiveVideoElement } from './objectRenderers/videoRenderer.js'
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

export interface PresentVideoPoolOptions {
  /**
   * Device pixels per slide pixel the presentation shows now
   * (videoRendition.ts → presentDeviceScale); read whenever a file is
   * chosen. Default: the window's fit.
   */
  deviceScale?: () => number
  /**
   * Whether video `objectId` may switch files now: its slide is not on
   * stage and no transition or build moves. Default: always.
   */
  canSwitch?: (objectId: string) => boolean
  /** Video `objectId` plays its other file now: the scenes that show it are to be warmed again. */
  onSwitched?: (objectId: string) => void
}

interface Entry extends PresentVideo {
  /** The object as it was opened: its box and fit choose the file. */
  object: VideoObject
  /** The other file, being buffered or buffered and waiting for the video to leave the stage. */
  next: {
    kind: PlaybackChoice['kind']
    element: HTMLVideoElement | null
    cancelled: boolean
  } | null
}

/** A video that has not buffered within this long is kept as it is (it streams while it plays). */
const BUFFER_TIMEOUT_MS = 30_000
/** A display change is acted on once it has been quiet this long (a window resize is many). */
const DISPLAY_QUIET_MS = 400
/** How often a buffered switch looks again for its moment off stage. */
const SWITCH_RETRY_MS = 250

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

/** Stop an element and let go of its file, its decoder and the renderer's source of it. */
function discard(el: HTMLVideoElement): void {
  releaseLiveVideoElement(el)
  el.pause()
  el.removeAttribute('src')
  el.load()
  el.remove()
}

export class PresentVideoPool {
  private readonly videos = new Map<string, Entry>()
  private readonly host: HTMLDivElement
  private readonly deviceScale: () => number
  private readonly canSwitch: (objectId: string) => boolean
  private readonly onSwitched: (objectId: string) => void
  private displayTimer: ReturnType<typeof setTimeout> | null = null
  /** Switches whose second element is still buffering (`whenSwitched`). */
  private readonly buffering = new Set<Promise<unknown>>()
  private readonly unwatchDensity: () => void
  private destroyed = false

  constructor(opts: PresentVideoPoolOptions = {}) {
    this.deviceScale = opts.deviceScale ?? (() => presentStageScale())
    this.canSwitch = opts.canSwitch ?? (() => true)
    this.onSwitched = opts.onSwitched ?? (() => undefined)
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
    this.unwatchDensity = this.watchDensity()
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

  /**
   * What the presentation shows changed (its size on screen, the display's
   * density): once it has been quiet for a moment, every video whose file is
   * no longer the right one prepares the other (see the module comment).
   */
  displayChanged(): void {
    if (this.destroyed) return
    if (this.displayTimer !== null) clearTimeout(this.displayTimer)
    this.displayTimer = setTimeout(() => {
      this.displayTimer = null
      this.reconsider()
    }, DISPLAY_QUIET_MS)
  }

  /**
   * Resolves once no switch is buffering its file: a display change during
   * the load is prepared before the presentation starts (PresentLayout).
   * A display change still waiting out its quiet moment counts too.
   */
  async whenSwitched(): Promise<void> {
    while (!this.destroyed && (this.displayTimer !== null || this.buffering.size > 0)) {
      if (this.buffering.size > 0) await Promise.all([...this.buffering])
      else await new Promise((resolve) => setTimeout(resolve, DISPLAY_QUIET_MS))
    }
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
    if (this.displayTimer !== null) clearTimeout(this.displayTimer)
    this.unwatchDensity()
    for (const v of this.videos.values()) {
      this.dropNext(v)
      discard(v.element)
    }
    this.videos.clear()
    this.host.remove()
  }

  /** `displayChanged` when the display's density changes (the window moved to another screen). */
  private watchDensity(): () => void {
    if (typeof window.matchMedia !== 'function') return () => undefined
    let query: MediaQueryList | null = null
    const onChange = (): void => {
      watch()
      this.displayChanged()
    }
    const watch = (): void => {
      query?.removeEventListener('change', onChange)
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      query.addEventListener('change', onChange)
    }
    watch()
    return () => query?.removeEventListener('change', onChange)
  }

  /** Every video: the file it wants now, prepared when it is not the one it plays. */
  private reconsider(): void {
    if (this.destroyed) return
    const scale = this.deviceScale()
    for (const v of this.videos.values()) {
      const wanted = choosePlayback(v.info, v.object, scale)
      if (wanted === null || wanted.kind === v.kind) {
        // Back to the file it plays: a switch under way is not wanted any more.
        this.dropNext(v)
        continue
      }
      if (v.next?.kind === wanted.kind) continue
      this.dropNext(v)
      void this.prepareSwitch(v, wanted)
    }
  }

  private dropNext(v: Entry): void {
    if (v.next === null) return
    v.next.cancelled = true
    if (v.next.element !== null) discard(v.next.element)
    v.next = null
  }

  /** Buffer `wanted` for `v` on its first frame, then switch to it once the video is off stage. */
  private async prepareSwitch(v: Entry, wanted: PlaybackChoice): Promise<void> {
    const next: NonNullable<Entry['next']> = { kind: wanted.kind, element: null, cancelled: false }
    v.next = next
    const buffering = this.buffer(v.object, wanted.url, v.startAt).then(async (el) => {
      if (el !== null || next.cancelled || this.destroyed) return el
      // Not buffered: once more with freshly signed URLs (MEDIA-1: a talk
      // can outlast them), the info kept for the file it then plays.
      const info = await getDefaultVideoInfoResolver()({
        assetId: v.info.assetId,
        forceRefresh: true,
      }).catch(() => null)
      const again = info === null ? null : choosePlayback(info, v.object, this.deviceScale())
      if (info === null || again?.kind !== wanted.kind || next.cancelled || this.destroyed)
        return null
      v.info = info
      return this.buffer(v.object, again.url, v.startAt)
    })
    this.buffering.add(buffering)
    const el = await buffering.finally(() => this.buffering.delete(buffering))
    if (next.cancelled || this.destroyed || this.videos.get(v.objectId) !== v) {
      if (el !== null) discard(el)
      return
    }
    if (el === null) {
      // It did not buffer: the video keeps the file it plays.
      v.next = null
      return
    }
    next.element = el
    for (;;) {
      if (next.cancelled || this.destroyed) return
      if (this.canSwitch(v.objectId)) break
      await new Promise((resolve) => setTimeout(resolve, SWITCH_RETRY_MS))
    }
    v.next = null
    const old = v.element
    v.element = el
    v.kind = wanted.kind
    // Every scene of the video draws the new element (the old one's texture goes).
    attachLiveVideo(v.objectId, el)
    discard(old)
    this.onSwitched(v.objectId)
  }

  private async open(v: VideoObject): Promise<void> {
    const info = await trackRenderWork(getDefaultVideoInfoResolver()({ assetId: v.assetId }))
    if (this.destroyed || info.transcodeStatus !== 'done') return
    const chosen = choosePlayback(info, v, this.deviceScale())
    if (chosen === null) return
    const startAt = startOf(v)
    const el = await this.buffer(v, chosen.url, startAt, true)
    if (el === null) return
    if (this.destroyed) {
      discard(el)
      return
    }
    this.videos.set(v.id, {
      objectId: v.id,
      element: el,
      info,
      startAt,
      kind: chosen.kind,
      object: v,
      next: null,
    })
    // Every scene of this video — on stage and prepared — draws the live frame.
    attachLiveVideo(v.id, el)
  }

  /**
   * A new element of `v` playing `url`, buffered far enough to play through
   * and on its first frame, decoded. With `keepUnbuffered` an element that did
   * not buffer in time is kept anyway (it streams as it plays); else null.
   */
  private async buffer(
    v: VideoObject,
    url: string,
    startAt: number,
    keepUnbuffered = false,
  ): Promise<HTMLVideoElement | null> {
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
    // Its frames are uploaded to WebGL, which refuses a cross-origin video
    // that was not fetched with CORS (dev and perf serve storage from another
    // port; production's /storage is same-origin, where this changes nothing).
    // Set before `src`, or the first request goes out without it.
    el.crossOrigin = 'anonymous'
    this.host.appendChild(el)
    el.src = url
    el.load()
    const buffered = await once(el, 'canplaythrough', BUFFER_TIMEOUT_MS)
    if (!buffered && !keepUnbuffered) {
      discard(el)
      return null
    }
    if (startAt > 0 && Math.abs(el.currentTime - startAt) > 0.01) {
      el.currentTime = startAt
      await once(el, 'seeked', 5000)
    }
    return el
  }
}
