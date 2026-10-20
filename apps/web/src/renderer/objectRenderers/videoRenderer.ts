/**
 * renderer/objectRenderers/videoRenderer.ts
 *
 * Object renderer for type 'video'.
 *
 * Responsibilities:
 * - mount(): Creates Container + placeholder. Fetches video-info endpoint to determine
 *   transcode status. Renders appropriate state:
 *     - pending/processing: gray placeholder with "Processing..." text.
 *     - done: poster Sprite (cover/contain fit) + centered play icon overlay.
 *     - failed: red "Failed" placeholder.
 * - applyPatch(): Handles x/y/rotation/opacity/width/height/assetId/fit patches.
 *   assetId change triggers a full re-resolve.
 * - destroy(): Releases acquired poster texture, clears polling timer, sets aborted flag.
 * - thumbnailMount(): Async loads thumbnailUrl (400×225 jpg from ffmpeg pipeline)
 *   so sidebar shows the actual first-frame preview.
 *
 * Polling:
 * - If transcode status is pending/processing on mount, a 5s interval re-checks until
 *   status becomes done or failed, or the object is destroyed.
 * - Trade-off: polling in the renderer is simple but not architecturally ideal.
 *   A cleaner approach would be for editor-ui to push a Yjs update on transcode completion,
 *   triggering a re-render without renderer-side polling. Deferred to a follow-up milestone.
 *
 * Fit modes: same semantics as imageRenderer — 'cover' (default) | 'contain'.
 *
 * Async safety:
 * - An `aborted` flag (Symbol-tagged on Container) is set in destroy().
 * - All async continuations check this flag before doing work.
 */

import { Container, Graphics, Sprite, Text, Texture, VideoSource } from 'pixi.js'
import type { VideoObject } from '@narrative/shared'
import { getDefaultVideoInfoResolver } from '../videoInfo.js'
import { getDefaultImageUrlResolver } from '../imageUrl.js'
import { getDefaultResourceManager } from '../ResourceManager.js'
import { applyFit, applyCoverMask } from '../mediaFit.js'
import { setThumbnailReady } from '../thumbnailReady.js'
import { markRenderDirty } from '../RenderScheduler.js'
import { applyFlip } from './applyFlip.js'
import { applyFilterEffects, destroyFilterEffects, patchFilterEffects } from '../filterEffects.js'

// ---------------------------------------------------------------------------
// Symbol tags for internal state on Container instances
// ---------------------------------------------------------------------------

const SPRITE_TAG = Symbol('vidSprite')
const PLACEHOLDER_TAG = Symbol('vidPlaceholder')
const MASK_TAG = Symbol('vidMask')
const SPRITE_WRAP_TAG = Symbol('vidSpriteWrap')
const PLAY_ICON_TAG = Symbol('vidPlayIcon')
const ABORTED_TAG = Symbol('vidAborted')
const ACQUIRED_URL_TAG = Symbol('vidAcquiredUrl')
/**
 * Monotonic load-generation counter. Bumped by every `startLoad` so a
 * poster/video-info load still in flight from a prior asset can detect
 * it has been superseded and bail before clobbering tags / leaking its
 * texture / tearing down the newer load's sprite. See `isStale`.
 */
const LOAD_GEN_TAG = Symbol('vidLoadGen')
const POLL_TIMER_TAG = Symbol('vidPollTimer')
const LATEST_DATA_TAG = Symbol('vidLatestData')
const LIVE_VIDEO_TAG = Symbol('vidLive')
/**
 * Texture created by `thumbnailMount` via `Texture.from(img)`. Like the
 * image renderer, thumbnails bypass the shared ResourceManager, so this
 * texture is owned solely by the thumbnail and `Sprite.destroy()` won't free
 * it. Tagged so `destroy()` can release it and its GPU source.
 */
const THUMB_TEXTURE_TAG = Symbol('vidThumbTexture')

/**
 * Per-deck registry mapping object id → set of mounted Containers so the
 * EditorVideoPreview can hand its hidden <video> element to the renderer
 * once HLS has loaded. The renderer then builds a Pixi VideoSource sprite
 * that lives inside the scene graph — Y.Array layer order naturally
 * applies (no DOM-overlay-on-top-of-canvas problem).
 *
 * Why a Set, not a single ref: at any moment more than one Pixi context
 * may have a container for the same video object id mounted at the same
 * time — most commonly during the brief overlap when navigating from
 * editor to present mode (the present canvas mounts its scene graph
 * before the editor's unmounts), but also for future split-view layouts
 * or component-master previews. A Map<id, Container> would silently
 * overwrite earlier entries in those cases and `attachLiveVideo` would
 * route the videoEl to whichever scene graph won the race. With a Set we
 * broadcast to every live container.
 */
const containerRegistry = new Map<string, Set<Container>>()

interface LiveVideoState {
  videoEl: HTMLVideoElement
  source: VideoSource
  texture: Texture
  sprite: Sprite
  spriteWrap: Container
  fit: 'cover' | 'contain'
  rvfcId: number | null
}

function setLatestData(node: Container, data: VideoObject): void {
  asAny(node)[LATEST_DATA_TAG] = data
}
function getLatestData(node: Container): VideoObject | undefined {
  return asAny(node)[LATEST_DATA_TAG] as VideoObject | undefined
}
function getLive(node: Container): LiveVideoState | undefined {
  return asAny(node)[LIVE_VIDEO_TAG] as LiveVideoState | undefined
}
function setLive(node: Container, state: LiveVideoState | undefined): void {
  asAny(node)[LIVE_VIDEO_TAG] = state
}

/**
 * Buffer for video elements that arrive before the container is mounted
 * (or while the scene graph is rebuilding). On mount, we drain any
 * matching entry and attach.
 */
const pendingVideoEls = new Map<string, HTMLVideoElement>()

/**
 * Public entry point: hand the renderer a hidden <video> element to use
 * as the live frame source for `id`. Replaces the static poster sprite
 * with a Pixi VideoSource sprite so the video is part of the Pixi scene
 * graph (and respects Y.Array layer order — that's the whole point).
 *
 * Safe to call before the renderer has mounted the container; the call
 * is buffered and applied on next mount.
 */
export function attachLiveVideo(id: string, videoEl: HTMLVideoElement): void {
  const set = containerRegistry.get(id)
  if (set === undefined || set.size === 0) {
    pendingVideoEls.set(id, videoEl)
    return
  }
  // Snapshot before iteration — attachLiveVideoToContainer may mutate the
  // container's tree but should never mutate this registry directly.
  for (const container of [...set]) {
    attachLiveVideoToContainer(container, videoEl)
  }
}

export function detachLiveVideo(id: string): void {
  pendingVideoEls.delete(id)
  const set = containerRegistry.get(id)
  if (set === undefined) return
  for (const container of [...set]) {
    teardownLiveVideo(container)
    // Restore the poster path: re-run startLoad so the static sprite returns.
    const data = getLatestData(container)
    if (data !== undefined) startLoad(container, data)
  }
}

function attachLiveVideoToContainer(container: Container, videoEl: HTMLVideoElement): void {
  if (container.destroyed) return
  const existing = getLive(container)
  if (existing !== undefined && existing.videoEl === videoEl) return
  if (existing !== undefined) teardownLiveVideo(container)

  const data = getLatestData(container)
  if (data === undefined) return
  const fit: 'cover' | 'contain' = data.fit ?? 'contain'
  const box = { w: data.width, h: data.height }

  // Drop the placeholder + poster + play icon — the live video covers them.
  const ph = getPlaceholder(container)
  if (ph !== undefined && !ph.destroyed) ph.visible = false
  releasePosterTexture(container)
  teardownSpriteWrap(container)
  removePlayIcon(container)

  // autoLoad defaults to true → VideoSource registers its play / pause /
  // seeked listeners, which is what drives the per-frame texture upload
  // flag. Without that, our markRenderDirty calls would render with a
  // stale texture. autoPlay false so VideoSource doesn't try to start
  // playback (the editor controls that).
  const source = new VideoSource({ resource: videoEl, autoPlay: false })
  const texture = new Texture({ source })
  const sprite = new Sprite(texture)

  const spriteWrap = new Container()
  spriteWrap.addChild(sprite)
  if (fit === 'cover') {
    const mask = applyCoverMask(spriteWrap, undefined, box)
    setMask(container, mask)
  }
  container.addChild(spriteWrap)
  setSpriteWrap(container, spriteWrap)
  setSprite(container, sprite)

  const live: LiveVideoState = {
    videoEl,
    source,
    texture,
    sprite,
    spriteWrap,
    fit,
    rvfcId: null,
  }
  setLive(container, live)

  // Apply fit now (texture may have valid dimensions if HLS already
  // ready) and re-apply on metadata load so the sprite gets sized
  // correctly even if we attached before the video knew its dimensions.
  const refit = (): void => {
    if (container.destroyed) return
    const cached = getLatestData(container)
    if (cached !== undefined) refitLiveVideo(container, cached)
    markRenderDirty()
  }
  refit()
  videoEl.addEventListener('loadedmetadata', refit)

  // Pixi runs autoStart:false — Ticker.shared isn't pumping frames, so
  // we have to call markRenderDirty manually. Defer via rAF so any
  // VideoSource listener registered for the same event has a chance to
  // run first (e.g. updateFrame on `seeked` flips the upload flag —
  // we render AFTER that flip so the new frame actually shows).
  const safeMark = (): void => {
    if (container.destroyed) return
    requestAnimationFrame(() => {
      if (!container.destroyed) markRenderDirty()
    })
  }
  videoEl.addEventListener('seeked', safeMark)
  videoEl.addEventListener('canplay', safeMark)
  videoEl.addEventListener('loadeddata', safeMark)

  // While the video is playing, run a rAF loop that marks dirty every
  // frame. Pixi's render path picks up VideoSource's pending upload and
  // paints the latest frame. Loop self-stops when the video pauses.
  let playLoopId: number | null = null
  const playLoop = (): void => {
    if (videoEl.paused || videoEl.ended || container.destroyed) {
      playLoopId = null
      return
    }
    markRenderDirty()
    playLoopId = requestAnimationFrame(playLoop)
  }
  const startPlayLoop = (): void => {
    if (playLoopId !== null) return
    playLoopId = requestAnimationFrame(playLoop)
  }
  const stopPlayLoop = (): void => {
    if (playLoopId !== null) {
      cancelAnimationFrame(playLoopId)
      playLoopId = null
    }
  }
  videoEl.addEventListener('play', startPlayLoop)
  videoEl.addEventListener('pause', stopPlayLoop)
  videoEl.addEventListener('ended', stopPlayLoop)
  // If the video was already playing when we attached, kick the loop off.
  if (!videoEl.paused) startPlayLoop()

  asAny(container).__vidLiveHandlers = {
    videoEl,
    refit,
    safeMark,
    startPlayLoop,
    stopPlayLoop,
    getPlayLoopId: () => playLoopId,
  }

  markRenderDirty()
}

function teardownLiveVideo(container: Container): void {
  const live = getLive(container)
  if (live === undefined) return
  const handlers = asAny(container).__vidLiveHandlers as
    | {
        videoEl: HTMLVideoElement
        refit: () => void
        safeMark: () => void
        startPlayLoop: () => void
        stopPlayLoop: () => void
        getPlayLoopId: () => number | null
      }
    | undefined
  if (handlers !== undefined) {
    const { videoEl, refit, safeMark, startPlayLoop, stopPlayLoop, getPlayLoopId } = handlers
    videoEl.removeEventListener('loadedmetadata', refit)
    videoEl.removeEventListener('seeked', safeMark)
    videoEl.removeEventListener('canplay', safeMark)
    videoEl.removeEventListener('loadeddata', safeMark)
    videoEl.removeEventListener('play', startPlayLoop)
    videoEl.removeEventListener('pause', stopPlayLoop)
    videoEl.removeEventListener('ended', stopPlayLoop)
    const id = getPlayLoopId()
    if (id !== null) cancelAnimationFrame(id)
    delete asAny(container).__vidLiveHandlers
  }
  if (!live.spriteWrap.destroyed) live.spriteWrap.destroy({ children: true })
  if (!live.texture.destroyed) live.texture.destroy(true)
  setLive(container, undefined)
  setSpriteWrap(container, undefined)
  setSprite(container, undefined)
  setMask(container, undefined)
}

function refitLiveVideo(container: Container, data: VideoObject): void {
  const live = getLive(container)
  if (live === undefined) return
  const fit: 'cover' | 'contain' = data.fit ?? 'contain'
  const box = { w: data.width, h: data.height }
  applyFit(live.sprite, live.texture, box, fit)
  if (fit === 'cover') {
    const existingMask = getMask(container)
    const newMask = applyCoverMask(live.spriteWrap, existingMask, box)
    setMask(container, newMask)
  } else {
    const existingMask = getMask(container)
    if (existingMask !== undefined) {
      live.spriteWrap.mask = null
      existingMask.destroy()
      setMask(container, undefined)
    }
  }
  live.fit = fit
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property on Pixi Container is untyped
const asAny = (node: Container): any => node as any

function getSprite(node: Container): Sprite | undefined {
  return asAny(node)[SPRITE_TAG] as Sprite | undefined
}

function setSprite(node: Container, sprite: Sprite | undefined): void {
  asAny(node)[SPRITE_TAG] = sprite
}

function getPlaceholder(node: Container): Graphics | undefined {
  return asAny(node)[PLACEHOLDER_TAG] as Graphics | undefined
}

function setPlaceholder(node: Container, g: Graphics | undefined): void {
  asAny(node)[PLACEHOLDER_TAG] = g
}

function getMask(node: Container): Graphics | undefined {
  return asAny(node)[MASK_TAG] as Graphics | undefined
}

function setMask(node: Container, g: Graphics | undefined): void {
  asAny(node)[MASK_TAG] = g
}

function getSpriteWrap(node: Container): Container | undefined {
  return asAny(node)[SPRITE_WRAP_TAG] as Container | undefined
}

function setSpriteWrap(node: Container, c: Container | undefined): void {
  asAny(node)[SPRITE_WRAP_TAG] = c
}

function getPlayIcon(node: Container): Graphics | undefined {
  return asAny(node)[PLAY_ICON_TAG] as Graphics | undefined
}

function setPlayIcon(node: Container, g: Graphics | undefined): void {
  asAny(node)[PLAY_ICON_TAG] = g
}

function isAborted(node: Container): boolean {
  return (asAny(node)[ABORTED_TAG] as boolean | undefined) ?? false
}

function setAborted(node: Container): void {
  asAny(node)[ABORTED_TAG] = true
}

/** Bump the load generation and return the new (captured) value. */
function bumpLoadGen(node: Container): number {
  const next = ((asAny(node)[LOAD_GEN_TAG] as number | undefined) ?? 0) + 1
  asAny(node)[LOAD_GEN_TAG] = next
  return next
}

/**
 * A poster load is stale when the node was destroyed (aborted) or a
 * newer `startLoad` bumped the generation past the one this closure
 * captured (rapid asset / posterAssetId swap, or a poll firing after a
 * fresh startLoad). Stale work must abort without releasing the current
 * poster, tearing down the live sprite wrap, or clobbering tags.
 */
function isStale(node: Container, myGen: number): boolean {
  return isAborted(node) || (asAny(node)[LOAD_GEN_TAG] as number | undefined) !== myGen
}

function getAcquiredUrl(node: Container): string | undefined {
  return asAny(node)[ACQUIRED_URL_TAG] as string | undefined
}

function setAcquiredUrl(node: Container, url: string | undefined): void {
  asAny(node)[ACQUIRED_URL_TAG] = url
}

function getThumbTexture(node: Container): Texture | undefined {
  return asAny(node)[THUMB_TEXTURE_TAG] as Texture | undefined
}

function setThumbTexture(node: Container, texture: Texture | undefined): void {
  asAny(node)[THUMB_TEXTURE_TAG] = texture
}

function getPollTimer(node: Container): ReturnType<typeof setInterval> | undefined {
  return asAny(node)[POLL_TIMER_TAG] as ReturnType<typeof setInterval> | undefined
}

function setPollTimer(node: Container, t: ReturnType<typeof setInterval> | undefined): void {
  asAny(node)[POLL_TIMER_TAG] = t
}

// ---------------------------------------------------------------------------
// Transform helpers
// ---------------------------------------------------------------------------

function applyObjectTransform(container: Container, data: VideoObject): void {
  container.rotation = data.rotation
  container.alpha = data.opacity
  container.pivot.set(data.width / 2, data.height / 2)
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
  applyFlip(container, data)
}

// ---------------------------------------------------------------------------
// Placeholder drawing
// ---------------------------------------------------------------------------

/** Gray placeholder for loading / processing states. */
function drawLoadingPlaceholder(g: Graphics, width: number, height: number): void {
  g.clear()
  g.rect(0, 0, width, height)
  g.fill({ color: 0xcccccc, alpha: 1 })
}

/** Red placeholder for failed transcode. */
function drawFailedPlaceholder(g: Graphics, width: number, height: number): void {
  g.clear()
  // Light red background
  g.rect(0, 0, width, height)
  g.fill({ color: 0xffe0e0, alpha: 1 })
  // Red border
  g.rect(0, 0, width, height)
  g.stroke({ color: 0xcc0000, width: 2, alpha: 1 })
  // Centered X icon (two crossed lines)
  const cx = width / 2
  const cy = height / 2
  const size = Math.min(width, height) * 0.18
  const lw = Math.max(2, size * 0.18)
  // Line 1: top-left to bottom-right
  g.moveTo(cx - size, cy - size)
  g.lineTo(cx + size, cy + size)
  g.stroke({ color: 0xcc0000, width: lw, alpha: 1 })
  // Line 2: top-right to bottom-left
  g.moveTo(cx + size, cy - size)
  g.lineTo(cx - size, cy + size)
  g.stroke({ color: 0xcc0000, width: lw, alpha: 1 })
}

// ---------------------------------------------------------------------------
// Play icon
// ---------------------------------------------------------------------------

/**
 * Draws a centered semi-transparent play button (white circle + black triangle).
 */
function drawPlayIcon(g: Graphics, boxW: number, boxH: number): void {
  const cx = boxW / 2
  const cy = boxH / 2
  const radius = Math.min(boxW, boxH) * 0.15

  // Semi-transparent white circle
  g.circle(cx, cy, radius)
  g.fill({ color: 0xffffff, alpha: 0.85 })

  // Black triangle (play symbol) — slightly right-of-centre for optical balance
  const triSize = radius * 0.55
  g.moveTo(cx - triSize / 2, cy - triSize * 0.7)
  g.lineTo(cx - triSize / 2, cy + triSize * 0.7)
  g.lineTo(cx + triSize * 0.7, cy)
  g.closePath()
  g.fill({ color: 0x000000, alpha: 0.85 })
}

// ---------------------------------------------------------------------------
// Processing text helper
// ---------------------------------------------------------------------------

/**
 * Creates a centered Text label for the processing state.
 * Returns a Container wrapping the Text so it's easy to add/remove as a single child.
 */
function makeProcessingLabel(width: number, height: number): Container {
  const wrap = new Container()
  const label = new Text({
    text: 'Processing...',
    style: {
      fontSize: Math.max(12, Math.min(24, height * 0.06)),
      fill: 0x666666,
    },
  })
  label.anchor.set(0.5, 0.5)
  label.x = width / 2
  label.y = height / 2
  wrap.addChild(label)
  return wrap
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000

function startPolling(
  container: Container,
  assetId: string,
  box: { w: number; h: number },
  fit: 'cover' | 'contain',
  hasAuthoredPoster: boolean = false,
  myGen: number,
): void {
  // Clear any existing timer first.
  stopPolling(container)

  const timer = setInterval(() => {
    // Stop polling once destroyed or superseded by a newer load. A fresh
    // startLoad also calls stopPolling, but a poll already mid-await when
    // that happens is caught by the isStale check below.
    if (isStale(container, myGen)) {
      stopPolling(container)
      return
    }

    void (async () => {
      try {
        const resolver = getDefaultVideoInfoResolver()
        const info = await resolver({ assetId })
        if (isStale(container, myGen)) return
        applyVideoInfoResult(container, info, box, fit, hasAuthoredPoster, myGen)
      } catch {
        // Network error during poll — silently ignore, will retry next interval.
      }
    })()
  }, POLL_INTERVAL_MS)

  setPollTimer(container, timer)
}

function stopPolling(container: Container): void {
  const timer = getPollTimer(container)
  if (timer !== undefined) {
    clearInterval(timer)
    setPollTimer(container, undefined)
  }
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Applies the VideoInfoResult to the container, transitioning between states.
 * Called both on first load and during polling intervals.
 */
function applyVideoInfoResult(
  container: Container,
  info: {
    transcodeStatus: 'pending' | 'processing' | 'done' | 'failed'
    posterUrl?: string | null
  },
  box: { w: number; h: number },
  fit: 'cover' | 'contain',
  hasAuthoredPoster: boolean = false,
  myGen: number,
): void {
  // A poll (or the initial info fetch) that resolves after a newer
  // startLoad must not mutate the scene for the superseded asset.
  if (isStale(container, myGen)) return

  const status = info.transcodeStatus

  if (status === 'failed') {
    stopPolling(container)
    if (hasAuthoredPoster) {
      // Keep the authored poster visible — the slide content stays
      // intact and the user just can't play the video. Don't paint a
      // red "Failed" box over the author's preview.
      removeProcessingLabel(container)
      return
    }
    // Release any previously acquired texture.
    releasePosterTexture(container)
    // Remove sprite wrap.
    teardownSpriteWrap(container)
    // Remove play icon.
    removePlayIcon(container)
    // Show failed placeholder.
    const ph = ensurePlaceholder(container)
    drawFailedPlaceholder(ph, box.w, box.h)
    ph.visible = true
    return
  }

  if (status === 'pending' || status === 'processing') {
    if (hasAuthoredPoster) {
      // Authored poster is painting; skip the placeholder + processing
      // label entirely so the slide stays visually clean while HLS
      // catches up. We still start polling above so we can switch to
      // the play-icon overlay once transcodeStatus === 'done'.
      removeProcessingLabel(container)
      return
    }
    // The worker uploads the poster as soon as it has one, long before the
    // playback file (performance.md, R2): show it under the label while the
    // transcode runs. Until then, the grey placeholder.
    const stillUrl = info.posterUrl ?? null
    if (stillUrl === null || getAcquiredUrl(container) !== stillUrl) {
      const ph = ensurePlaceholder(container)
      drawLoadingPlaceholder(ph, box.w, box.h)
      ph.visible = getAcquiredUrl(container) === undefined
    }
    // Processing label: remove old if any, add fresh one.
    removeProcessingLabel(container)
    const label = makeProcessingLabel(box.w, box.h)
    container.addChild(label)
    setProcessingLabel(container, label)
    if (stillUrl !== null && getAcquiredUrl(container) !== stillUrl) {
      void loadPosterTexture(container, stillUrl, box, fit, myGen, { playIcon: false }).then(() => {
        // The poster landed above the label: the label goes back on top.
        const current = getProcessingLabel(container)
        if (current !== undefined && !current.destroyed) container.addChild(current)
      })
    }
    markRenderDirty()
    return
  }

  // status === 'done'
  stopPolling(container)
  removeProcessingLabel(container)

  const posterUrl = info.posterUrl ?? null

  if (hasAuthoredPoster) {
    // Authored poster (PPTX blipFill) is already painting. Don't tear
    // it down to swap in the HLS auto-poster — `loadPosterTexture`
    // releases the existing sprite BEFORE the new texture finishes
    // decoding, so the slide blinks empty for ~100-200ms. The author's
    // first-frame preview wins; the HLS poster is only useful when no
    // authored one exists. We still wire up the play-icon affordance.
    ensurePlayIcon(container, box)
    markRenderDirty()
    return
  }

  if (posterUrl === null) {
    // Done but no poster — show gray placeholder with play icon.
    const ph = ensurePlaceholder(container)
    drawLoadingPlaceholder(ph, box.w, box.h)
    ph.visible = true
    ensurePlayIcon(container, box)
    return
  }

  // The poster already shows (it came while the video was processing): only
  // the play icon is new — no reload, no blink.
  if (getAcquiredUrl(container) === posterUrl && getSprite(container) !== undefined) {
    ensurePlayIcon(container, box)
    markRenderDirty()
    return
  }

  // No authored poster — fall back to HLS auto-poster.
  void loadPosterTexture(container, posterUrl, box, fit, myGen)

  // P12b: this function flips placeholder visibility / spawns play icons /
  // kicks off async poster loads — all of which mutate the scene without
  // SceneGraph's knowledge. With auto-render off we must request a frame.
  markRenderDirty()
}

// ---------------------------------------------------------------------------
// Processing label symbol helpers
// ---------------------------------------------------------------------------

const PROCESSING_LABEL_TAG = Symbol('vidProcessingLabel')

function getProcessingLabel(node: Container): Container | undefined {
  return (node as unknown as Record<symbol, Container | undefined>)[PROCESSING_LABEL_TAG]
}

function setProcessingLabel(node: Container, c: Container | undefined): void {
  ;(node as unknown as Record<symbol, Container | undefined>)[PROCESSING_LABEL_TAG] = c
}

function removeProcessingLabel(node: Container): void {
  const label = getProcessingLabel(node)
  if (label !== undefined && !label.destroyed) {
    label.destroy({ children: true })
  }
  setProcessingLabel(node, undefined)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensures placeholder Graphics exists as a child and returns it. */
function ensurePlaceholder(container: Container): Graphics {
  let ph = getPlaceholder(container)
  if (ph === undefined || ph.destroyed) {
    ph = new Graphics()
    container.addChild(ph)
    setPlaceholder(container, ph)
  }
  if (!ph.parent) {
    container.addChild(ph)
  }
  return ph
}

/** Tears down sprite wrap and clears internal references. */
function teardownSpriteWrap(container: Container): void {
  const oldWrap = getSpriteWrap(container)
  if (oldWrap !== undefined && !oldWrap.destroyed) {
    oldWrap.destroy({ children: true })
  }
  setSpriteWrap(container, undefined)
  setSprite(container, undefined)
  setMask(container, undefined)
}

/** Removes play icon Graphics from container. */
function removePlayIcon(container: Container): void {
  const icon = getPlayIcon(container)
  if (icon !== undefined && !icon.destroyed) {
    icon.destroy()
  }
  setPlayIcon(container, undefined)
}

/** Ensures play icon Graphics exists and is on top. */
function ensurePlayIcon(container: Container, box: { w: number; h: number }): void {
  removePlayIcon(container)
  const icon = new Graphics()
  drawPlayIcon(icon, box.w, box.h)
  container.addChild(icon)
  setPlayIcon(container, icon)
}

/** Releases any currently acquired poster texture via ResourceManager. */
function releasePosterTexture(container: Container): void {
  const url = getAcquiredUrl(container)
  if (url !== undefined) {
    try {
      getDefaultResourceManager().releaseTexture(url)
    } catch {
      // ResourceManager may not be installed in tests — safe to ignore.
    }
    setAcquiredUrl(container, undefined)
  }
}

/** Async: acquire poster texture, build sprite + play icon. */
async function loadPosterTexture(
  container: Container,
  posterUrl: string,
  box: { w: number; h: number },
  fit: 'cover' | 'contain',
  myGen: number,
  opts: { playIcon: boolean } = { playIcon: true },
): Promise<void> {
  // Bail before any teardown if a newer load already superseded us — we
  // must not release the current poster or destroy the live sprite wrap.
  if (isStale(container, myGen)) return

  // Release previous.
  releasePosterTexture(container)
  teardownSpriteWrap(container)
  removePlayIcon(container)

  const rm = getDefaultResourceManager()

  let texture: Texture
  try {
    texture = await rm.acquireTexture(posterUrl)
  } catch {
    if (isStale(container, myGen)) return
    // Texture load failed — show error placeholder.
    const ph = ensurePlaceholder(container)
    drawFailedPlaceholder(ph, box.w, box.h)
    ph.visible = true
    return
  }

  if (isStale(container, myGen)) {
    rm.releaseTexture(posterUrl)
    return
  }

  setAcquiredUrl(container, posterUrl)

  // Build sprite wrap + sprite.
  const spriteWrap = new Container()
  const sprite = new Sprite(texture)

  applyFit(sprite, texture, box, fit)
  spriteWrap.addChild(sprite)

  if (fit === 'cover') {
    const mask = applyCoverMask(spriteWrap, undefined, box)
    setMask(container, mask)
  }

  container.addChild(spriteWrap)
  setSpriteWrap(container, spriteWrap)
  setSprite(container, sprite)

  // Hide placeholder.
  const ph = getPlaceholder(container)
  if (ph !== undefined && !ph.destroyed) {
    ph.visible = false
  }

  // Add play icon on top (not while the video is still processing).
  if (opts.playIcon) ensurePlayIcon(container, box)

  // P12b: async branch landed a sprite without going through SceneGraph;
  // poke the scheduler so the new poster shows up under autoStart:false.
  markRenderDirty()
}

// ---------------------------------------------------------------------------
// Core async load logic
// ---------------------------------------------------------------------------

function startLoad(container: Container, data: VideoObject): void {
  const { assetId } = data
  const fit = data.fit ?? 'contain'
  const box = { w: data.width, h: data.height }
  const authoredPosterAssetId =
    typeof data.posterAssetId === 'string' && data.posterAssetId !== ''
      ? data.posterAssetId
      : undefined

  // Invalidate any poster / video-info load still in flight from a prior
  // asset so it can't clobber this one's sprite or leak its texture.
  const myGen = bumpLoadGen(container)

  // Stop any existing poll.
  stopPolling(container)

  // Release previous texture.
  releasePosterTexture(container)

  // Reset visual state.
  teardownSpriteWrap(container)
  removePlayIcon(container)
  removeProcessingLabel(container)

  // Show loading placeholder ONLY when we have no authored poster to
  // fall back on. With `posterAssetId` set, we paint the author's
  // preview frame immediately — no grey "Processing…" box ever covers
  // the slide while the HLS transcode catches up.
  if (authoredPosterAssetId === undefined) {
    const ph = ensurePlaceholder(container)
    drawLoadingPlaceholder(ph, box.w, box.h)
    ph.visible = true
  } else {
    const ph = getPlaceholder(container)
    if (ph !== undefined && !ph.destroyed) ph.visible = false
    // Kick off the authored-poster load in parallel with the video-info
    // resolve below. The two are independent — poster paints, transcode
    // status drives playback availability.
    void loadAuthoredPoster(container, authoredPosterAssetId, box, fit, myGen)
  }

  // Empty assetId — keep whatever the authored poster painted (or the
  // placeholder if none) and bail before hitting the video-info API.
  if (assetId === '') return

  void (async () => {
    let info: Awaited<ReturnType<ReturnType<typeof getDefaultVideoInfoResolver>>>
    try {
      const resolver = getDefaultVideoInfoResolver()
      info = await resolver({ assetId })
    } catch {
      if (isStale(container, myGen)) return
      // When no authored poster is available, surface the failure state.
      // With an authored poster, keep it visible and silently move on —
      // the user can still see the slide content even if HLS metadata
      // never resolves.
      if (authoredPosterAssetId === undefined) {
        const ph2 = ensurePlaceholder(container)
        drawFailedPlaceholder(ph2, box.w, box.h)
      }
      return
    }

    if (isStale(container, myGen)) return

    applyVideoInfoResult(container, info, box, fit, authoredPosterAssetId !== undefined, myGen)

    // Start polling if transcode is still in progress.
    if (info.transcodeStatus === 'pending' || info.transcodeStatus === 'processing') {
      startPolling(container, assetId, box, fit, authoredPosterAssetId !== undefined, myGen)
    }
  })()
}

/**
 * Async: resolve the authored poster's signed URL, acquire the texture,
 * and paint it as the immediate preview frame. Independent of the HLS
 * transcode path — runs whenever `posterAssetId` is present, regardless
 * of `transcodeStatus`. Errors are swallowed: the HLS poster (or grey
 * placeholder) takes over if this fails.
 */
async function loadAuthoredPoster(
  container: Container,
  posterAssetId: string,
  box: { w: number; h: number },
  fit: 'cover' | 'contain',
  myGen: number,
): Promise<void> {
  let posterUrl: string
  try {
    const resolver = getDefaultImageUrlResolver()
    // Variant 'display' is the standard imgproxy resize (max 2560 long
    // edge, AVIF). Matches what `imageRenderer` uses for ImageObjects.
    posterUrl = await resolver({ assetId: posterAssetId, variant: 'display' })
  } catch {
    return
  }
  if (isStale(container, myGen)) return
  // The live <video> path may have already painted; don't clobber.
  if (getLive(container) !== undefined) return
  await loadPosterTexture(container, posterUrl, box, fit, myGen)
}

// ---------------------------------------------------------------------------
// Exported renderer
// ---------------------------------------------------------------------------

export const videoRenderer = {
  type: 'video' as const,

  mount(data: VideoObject): Container {
    const container = new Container()

    // Initial gray placeholder visible while resolving. With an
    // authored `posterAssetId`, `startLoad` immediately kicks off the
    // poster paint and hides the placeholder — but we still mount the
    // Graphics so `getPlaceholder` returns it when state transitions
    // need it later (e.g. failed transcode with no authored poster).
    const placeholder = new Graphics()
    drawLoadingPlaceholder(placeholder, data.width, data.height)
    const hasAuthoredPoster = typeof data.posterAssetId === 'string' && data.posterAssetId !== ''
    placeholder.visible = !hasAuthoredPoster
    container.addChild(placeholder)
    setPlaceholder(container, placeholder)

    applyObjectTransform(container, data)
    applyFilterEffects(container, data.shadow, data.blur)
    setLatestData(container, data)
    let set = containerRegistry.get(data.id)
    if (set === undefined) {
      set = new Set()
      containerRegistry.set(data.id, set)
    }
    set.add(container)
    startLoad(container, data)

    // If a hidden <video> element registered itself BEFORE this mount
    // (rare race during scene-graph rebuild), pick it up now.
    const pending = pendingVideoEls.get(data.id)
    if (pending !== undefined) {
      pendingVideoEls.delete(data.id)
      attachLiveVideoToContainer(container, pending)
    }

    return container
  },

  update(node: Container, prev: VideoObject, next: VideoObject): void {
    applyObjectTransform(node, next)
    applyFilterEffects(node, next.shadow, next.blur)
    setLatestData(node, next)
    // If size or fit changed, re-fit the live video sprite too.
    if (
      prev.width !== next.width ||
      prev.height !== next.height ||
      (prev.fit ?? 'contain') !== (next.fit ?? 'contain')
    ) {
      refitLiveVideo(node, next)
    }

    const box = { w: next.width, h: next.height }

    // Resize placeholder. Keep it hidden when an authored poster is
    // covering us, otherwise the grey box would flash on every patch.
    const ph = getPlaceholder(node)
    if (ph !== undefined && !ph.destroyed) {
      drawLoadingPlaceholder(ph, box.w, box.h)
      const hasAuthoredPoster = typeof next.posterAssetId === 'string' && next.posterAssetId !== ''
      const hasSprite = getSprite(node) !== undefined
      ph.visible = !hasAuthoredPoster && !hasSprite
    }

    const assetChanged = prev.assetId !== next.assetId
    const posterAssetChanged = (prev.posterAssetId ?? '') !== (next.posterAssetId ?? '')
    const fitChanged = prev.fit !== next.fit
    const sizeChanged = prev.width !== next.width || prev.height !== next.height

    if (assetChanged || posterAssetChanged) {
      startLoad(node, next)
      return
    }

    if (fitChanged || sizeChanged) {
      const sprite = getSprite(node)
      if (sprite !== undefined && sprite.texture !== undefined) {
        const fit = next.fit ?? 'contain'
        applyFit(sprite, sprite.texture, box, fit)

        const spriteWrap = getSpriteWrap(node)
        if (spriteWrap !== undefined) {
          if (fit === 'cover') {
            const existingMask = getMask(node)
            const newMask = applyCoverMask(spriteWrap, existingMask, box)
            setMask(node, newMask)
          } else {
            const existingMask = getMask(node)
            if (existingMask !== undefined) {
              spriteWrap.mask = null
              existingMask.destroy()
              setMask(node, undefined)
            }
          }
        }
      }

      // Reposition play icon.
      removePlayIcon(node)
      if (getSprite(node) !== undefined || getPlaceholder(node) !== undefined) {
        ensurePlayIcon(node, box)
      }
    }
  },

  applyPatch(node: Container, patch: Partial<VideoObject>): void {
    // Transform fields.
    if (patch.x !== undefined) {
      node.x = patch.x + node.pivot.x
    }
    if (patch.y !== undefined) {
      node.y = patch.y + node.pivot.y
    }
    if (patch.rotation !== undefined) {
      node.rotation = patch.rotation
    }
    if (patch.opacity !== undefined) {
      node.alpha = patch.opacity
    }

    // Geometry / fit fields.
    const sizeChanged = patch.width !== undefined || patch.height !== undefined
    const fitChanged = patch.fit !== undefined

    if (sizeChanged) {
      const currentPivotX = node.pivot.x
      const currentPivotY = node.pivot.y
      const dataX = node.x - currentPivotX
      const dataY = node.y - currentPivotY
      const currentW = currentPivotX * 2
      const currentH = currentPivotY * 2

      const newW = patch.width ?? currentW
      const newH = patch.height ?? currentH

      node.pivot.set(newW / 2, newH / 2)
      node.x = dataX + newW / 2
      node.y = dataY + newH / 2

      // Resize placeholder.
      const ph = getPlaceholder(node)
      if (ph !== undefined && !ph.destroyed) {
        drawLoadingPlaceholder(ph, newW, newH)
      }
    }

    if (sizeChanged || fitChanged) {
      const sprite = getSprite(node)
      if (sprite !== undefined && sprite.texture !== undefined) {
        const currentW = node.pivot.x * 2
        const currentH = node.pivot.y * 2
        const box = { w: currentW, h: currentH }

        let fit: 'cover' | 'contain'
        if (patch.fit !== undefined) {
          fit = patch.fit
        } else {
          fit = getMask(node) !== undefined ? 'cover' : 'contain'
        }

        applyFit(sprite, sprite.texture, box, fit)

        const spriteWrap = getSpriteWrap(node)
        if (spriteWrap !== undefined) {
          if (fit === 'cover') {
            const existingMask = getMask(node)
            const newMask = applyCoverMask(spriteWrap, existingMask, box)
            setMask(node, newMask)
          } else {
            const existingMask = getMask(node)
            if (existingMask !== undefined) {
              spriteWrap.mask = null
              existingMask.destroy()
              setMask(node, undefined)
            }
          }
        }

        // Reposition play icon.
        const currentW2 = node.pivot.x * 2
        const currentH2 = node.pivot.y * 2
        removePlayIcon(node)
        ensurePlayIcon(node, { w: currentW2, h: currentH2 })
      }
    }

    // Asset change → full async re-load.
    if (patch.assetId !== undefined) {
      const currentW = node.pivot.x * 2
      const currentH = node.pivot.y * 2
      const dataX = node.x - node.pivot.x
      const dataY = node.y - node.pivot.y

      const synthetic: VideoObject = {
        id: '',
        type: 'video',
        x: dataX,
        y: dataY,
        width: currentW,
        height: currentH,
        rotation: node.rotation,
        opacity: node.alpha,
        assetId: patch.assetId,
        fit: patch.fit ?? (getMask(node) !== undefined ? 'cover' : 'contain'),
      }

      // Show placeholder while re-loading.
      const ph = getPlaceholder(node)
      if (ph !== undefined && !ph.destroyed) {
        drawLoadingPlaceholder(ph, currentW, currentH)
        ph.visible = true
      }

      startLoad(node, synthetic)
    }

    if ('shadow' in patch || 'blur' in patch) {
      patchFilterEffects(node, 'shadow' in patch, patch.shadow, 'blur' in patch, patch.blur)
    }
    if (patch.width !== undefined || patch.height !== undefined || patch.fit !== undefined) {
      const cached = getLatestData(node)
      if (cached !== undefined) refitLiveVideo(node, cached)
    }
  },

  /**
   * No colour of its own goes through `resolveColour` — the pixels come from
   * the asset, the placeholder is a fixed grey. The shadow, the one token
   * colour VideoObject can hold, is repainted by filterEffects (index.ts).
   */
  repaintColours(_node: Container, _data: VideoObject): void {},

  destroy(node: Container): void {
    setAborted(node)
    stopPolling(node)

    teardownLiveVideo(node)
    releasePosterTexture(node)
    destroyFilterEffects(node)

    const data = getLatestData(node)
    if (data !== undefined) {
      const set = containerRegistry.get(data.id)
      if (set !== undefined) {
        set.delete(node)
        if (set.size === 0) containerRegistry.delete(data.id)
      }
    }

    // Thumbnail-owned texture (Texture.from(img)) — not tracked by the
    // ResourceManager. Destroy the sprite first (texture:false default),
    // then free the texture + GPU source.
    const thumbTexture = getThumbTexture(node)
    node.destroy({ children: true })
    if (thumbTexture !== undefined && !thumbTexture.destroyed) {
      try {
        thumbTexture.destroy(true)
      } catch {
        // Source may already be gone if the thumbnail context was torn down.
      }
      setThumbTexture(node, undefined)
    }
  },

  thumbnailMount(data: VideoObject): Container {
    const container = new Container()

    const placeholder = new Graphics()
    drawLoadingPlaceholder(placeholder, data.width, data.height)
    container.addChild(placeholder)
    setPlaceholder(container, placeholder)

    container.rotation = data.rotation
    container.alpha = data.opacity
    container.pivot.set(data.width / 2, data.height / 2)
    container.x = data.x + data.width / 2
    container.y = data.y + data.height / 2
    applyFlip(container, data)

    // Async: fetch video info and draw the 400w thumbnail. Uses thumbnailUrl
    // in preference to posterUrl (much smaller raster → cheaper to keep many
    // thumbnails alive in the sidebar).
    const { assetId } = data
    const fit: 'cover' | 'contain' = data.fit ?? 'contain'
    const box = { w: data.width, h: data.height }

    if (assetId === '') return container

    // Same reasoning as imageRenderer.thumbnailMount: do NOT go through the
    // main ResourceManager — its textures are bound to the main Canvas's
    // WebGL context. Load a fresh per-thumbnail Texture from an HTMLImageElement.
    // Exposes a ready-promise so the offscreen thumbnail renderer can await
    // the decode before taking its snapshot frame.
    const ready = (async () => {
      let infoUrl: string
      try {
        const resolver = getDefaultVideoInfoResolver()
        const info = await resolver({ assetId })
        if (isAborted(container)) return
        if (info.transcodeStatus !== 'done') return
        const url = info.thumbnailUrl ?? info.posterUrl
        if (url === null) return
        infoUrl = url
      } catch {
        return
      }

      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = infoUrl
      try {
        await img.decode()
      } catch {
        return
      }
      if (isAborted(container)) return

      const texture = Texture.from(img)
      // Thumbnail-owned texture — tag it so destroy() can free it (the
      // ResourceManager doesn't track thumbnail textures).
      setThumbTexture(container, texture)

      const spriteWrap = new Container()
      const sprite = new Sprite(texture)
      applyFit(sprite, texture, box, fit)
      spriteWrap.addChild(sprite)

      if (fit === 'cover') {
        const mask = applyCoverMask(spriteWrap, undefined, box)
        setMask(container, mask)
      }

      container.addChild(spriteWrap)
      setSpriteWrap(container, spriteWrap)
      setSprite(container, sprite)

      const ph = getPlaceholder(container)
      if (ph !== undefined && !ph.destroyed) {
        ph.visible = false
      }
    })()

    setThumbnailReady(container, ready)
    return container
  },
}
