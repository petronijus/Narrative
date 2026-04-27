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

import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { VideoObject } from '@narrative/shared'
import { getDefaultVideoInfoResolver } from '../videoInfo.js'
import { getDefaultResourceManager } from '../ResourceManager.js'
import { applyFit, applyCoverMask } from '../mediaFit.js'
import { setThumbnailReady } from '../thumbnailReady.js'
import { markRenderDirty } from '../RenderScheduler.js'

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
const POLL_TIMER_TAG = Symbol('vidPollTimer')

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

function getAcquiredUrl(node: Container): string | undefined {
  return asAny(node)[ACQUIRED_URL_TAG] as string | undefined
}

function setAcquiredUrl(node: Container, url: string | undefined): void {
  asAny(node)[ACQUIRED_URL_TAG] = url
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
): void {
  // Clear any existing timer first.
  stopPolling(container)

  const timer = setInterval(() => {
    if (isAborted(container)) {
      stopPolling(container)
      return
    }

    void (async () => {
      try {
        const resolver = getDefaultVideoInfoResolver()
        const info = await resolver({ assetId })
        if (isAborted(container)) return
        applyVideoInfoResult(container, info, box, fit)
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
): void {
  const status = info.transcodeStatus

  if (status === 'failed') {
    stopPolling(container)
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
    // Keep placeholder visible with loading style, start polling if not already.
    const ph = ensurePlaceholder(container)
    drawLoadingPlaceholder(ph, box.w, box.h)
    ph.visible = true
    // Processing label: remove old if any, add fresh one.
    removeProcessingLabel(container)
    const label = makeProcessingLabel(box.w, box.h)
    container.addChild(label)
    setProcessingLabel(container, label)
    return
  }

  // status === 'done'
  stopPolling(container)
  removeProcessingLabel(container)

  const posterUrl = info.posterUrl ?? null

  if (posterUrl === null) {
    // Done but no poster — show gray placeholder with play icon.
    const ph = ensurePlaceholder(container)
    drawLoadingPlaceholder(ph, box.w, box.h)
    ph.visible = true
    ensurePlayIcon(container, box)
    return
  }

  // Load poster texture.
  void loadPosterTexture(container, posterUrl, box, fit)

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
): Promise<void> {
  // Release previous.
  releasePosterTexture(container)
  teardownSpriteWrap(container)
  removePlayIcon(container)

  const rm = getDefaultResourceManager()

  let texture: Texture
  try {
    texture = await rm.acquireTexture(posterUrl)
  } catch {
    if (isAborted(container)) return
    // Texture load failed — show error placeholder.
    const ph = ensurePlaceholder(container)
    drawFailedPlaceholder(ph, box.w, box.h)
    ph.visible = true
    return
  }

  if (isAborted(container)) {
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

  // Add play icon on top.
  ensurePlayIcon(container, box)

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

  // Stop any existing poll.
  stopPolling(container)

  // Release previous texture.
  releasePosterTexture(container)

  // Reset visual state.
  teardownSpriteWrap(container)
  removePlayIcon(container)
  removeProcessingLabel(container)

  // Show loading placeholder.
  const ph = ensurePlaceholder(container)
  drawLoadingPlaceholder(ph, box.w, box.h)
  ph.visible = true

  // Empty assetId — remain in placeholder state.
  if (assetId === '') return

  void (async () => {
    let info: Awaited<ReturnType<ReturnType<typeof getDefaultVideoInfoResolver>>>
    try {
      const resolver = getDefaultVideoInfoResolver()
      info = await resolver({ assetId })
    } catch {
      if (isAborted(container)) return
      const ph2 = ensurePlaceholder(container)
      drawFailedPlaceholder(ph2, box.w, box.h)
      return
    }

    if (isAborted(container)) return

    applyVideoInfoResult(container, info, box, fit)

    // Start polling if transcode is still in progress.
    if (info.transcodeStatus === 'pending' || info.transcodeStatus === 'processing') {
      startPolling(container, assetId, box, fit)
    }
  })()
}

// ---------------------------------------------------------------------------
// Exported renderer
// ---------------------------------------------------------------------------

export const videoRenderer = {
  type: 'video' as const,

  mount(data: VideoObject): Container {
    const container = new Container()

    // Initial gray placeholder visible while resolving.
    const placeholder = new Graphics()
    drawLoadingPlaceholder(placeholder, data.width, data.height)
    container.addChild(placeholder)
    setPlaceholder(container, placeholder)

    applyObjectTransform(container, data)
    startLoad(container, data)

    return container
  },

  update(node: Container, prev: VideoObject, next: VideoObject): void {
    applyObjectTransform(node, next)

    const box = { w: next.width, h: next.height }

    // Resize placeholder.
    const ph = getPlaceholder(node)
    if (ph !== undefined && !ph.destroyed) {
      drawLoadingPlaceholder(ph, box.w, box.h)
      ph.visible = true
    }

    const assetChanged = prev.assetId !== next.assetId
    const fitChanged = prev.fit !== next.fit
    const sizeChanged = prev.width !== next.width || prev.height !== next.height

    if (assetChanged) {
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
  },

  destroy(node: Container): void {
    setAborted(node)
    stopPolling(node)

    releasePosterTexture(node)

    node.destroy({ children: true })
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
