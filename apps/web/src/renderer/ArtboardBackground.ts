/**
 * renderer/ArtboardBackground.ts
 *
 * P2: per-slide artboard background. Mounts a single Pixi Container
 * that sits underneath every slide object. The container is rebuilt
 * from scratch whenever the active `SlideBackground` changes.
 *
 * Kinds:
 *   - color: flat Graphics rect
 *   - linearGradient: canvas texture (angled linear gradient painted on
 *     an offscreen 2D canvas, uploaded as a Pixi Texture once per
 *     identity change)
 *   - radialGradient: same strategy with a radial gradient
 *   - image: imgproxy-resolved Sprite, fit cover / contain
 *
 * Texture reuse:
 *   Repaints on every identity change (stringified signature).
 *   Previous texture is destroyed. Not aggressive caching for now —
 *   an identity hash → texture cache can land in a later polish pass
 *   if many decks share backgrounds.
 *
 * Writing:
 *   Consumer calls `applyBackground(container, background, size, urlResolver?)`.
 *   The container is assumed to live as the FIRST child of the slide
 *   root so objects stack above it.
 */

import type { Container } from 'pixi.js'
import { Graphics, Sprite, Texture } from 'pixi.js'
import type {
  SlideBackground,
  LinearGradientBackground,
  RadialGradientBackground,
  ImageBackground,
} from '@narrative/shared'
import { markRenderDirty } from './RenderScheduler'
import { getDefaultResourceManager } from './ResourceManager.js'

// ---------------------------------------------------------------------------
// Internal metadata keys (Symbol-tagged on the Container)
// ---------------------------------------------------------------------------

const SIG_TAG = Symbol('bgSignature')
const TEX_URL_TAG = Symbol('bgTextureUrl')
/**
 * P12c: when the background renders a procedurally-painted gradient
 * texture (linear / radial), we acquire it from ResourceManager's
 * procedural cache. The key is stored on the container so the next
 * paint can release it before acquiring the new one.
 */
const PROC_KEY_TAG = Symbol('bgProceduralKey')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol metadata on Pixi Container is untyped
const asAny = (c: Container): any => c

function getSignature(c: Container): string | undefined {
  return asAny(c)[SIG_TAG] as string | undefined
}
function setSignature(c: Container, sig: string): void {
  asAny(c)[SIG_TAG] = sig
}
function getAcquiredUrl(c: Container): string | undefined {
  return asAny(c)[TEX_URL_TAG] as string | undefined
}
function setAcquiredUrl(c: Container, url: string | undefined): void {
  asAny(c)[TEX_URL_TAG] = url
}
function getProceduralKey(c: Container): string | undefined {
  return asAny(c)[PROC_KEY_TAG] as string | undefined
}
function setProceduralKey(c: Container, key: string | undefined): void {
  if (key === undefined) {
    delete asAny(c)[PROC_KEY_TAG]
  } else {
    asAny(c)[PROC_KEY_TAG] = key
  }
}

// ---------------------------------------------------------------------------
// Signature — compares background identity to decide if we can skip repaint
// ---------------------------------------------------------------------------

function signature(bg: SlideBackground | undefined, width: number, height: number): string {
  if (bg === undefined) return `none:${width}x${height}`
  switch (bg.kind) {
    case 'color':
      return `c:${bg.color}:${bg.alpha ?? 1}:${width}x${height}`
    case 'linearGradient':
      return `lg:${bg.angleDeg}:${JSON.stringify(bg.stops)}:${width}x${height}`
    case 'radialGradient':
      return `rg:${bg.centerX},${bg.centerY},${bg.radius}:${JSON.stringify(bg.stops)}:${width}x${height}`
    case 'image':
      return `i:${bg.assetId}:${bg.fit}:${bg.dim ?? 0}:${width}x${height}`
  }
}

// ---------------------------------------------------------------------------
// Canvas → Texture helpers
// ---------------------------------------------------------------------------

function canvasForGradient(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  // Use device pixel rounding cap — 2× for HiDPI thumbs but not beyond,
  // gradients are smooth so extra resolution is wasted.
  const scale = Math.min(2, window.devicePixelRatio ?? 1)
  c.width = Math.max(1, Math.round(width * scale))
  c.height = Math.max(1, Math.round(height * scale))
  return c
}

function paintLinear(
  canvas: HTMLCanvasElement,
  bg: LinearGradientBackground,
  logicalWidth: number,
  logicalHeight: number,
): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  // Map angleDeg → line across the logical rect. 0° = top→bottom,
  // 90° = left→right (matches most design tools).
  const rad = (bg.angleDeg * Math.PI) / 180
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  const halfDiag = Math.hypot(canvas.width, canvas.height) / 2
  const dx = Math.sin(rad) * halfDiag
  const dy = -Math.cos(rad) * halfDiag
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy)
  for (const s of bg.stops) {
    g.addColorStop(clamp01(s.offset), rgba(s.color, s.alpha ?? 1))
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  void logicalWidth
  void logicalHeight
}

function paintRadial(canvas: HTMLCanvasElement, bg: RadialGradientBackground): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const cx = canvas.width * clamp01(bg.centerX)
  const cy = canvas.height * clamp01(bg.centerY)
  const r = Math.hypot(canvas.width, canvas.height) * clamp01(bg.radius)
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r))
  for (const s of bg.stops) {
    g.addColorStop(clamp01(s.offset), rgba(s.color, s.alpha ?? 1))
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

function rgba(color: number, alpha: number): string {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  return `rgba(${r},${g},${b},${alpha})`
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

// ---------------------------------------------------------------------------
// Public: applyBackground
// ---------------------------------------------------------------------------

export interface ApplyBackgroundArgs {
  /** The artboard-background Container to (re)paint in place. */
  container: Container
  /** The new background descriptor. `undefined` clears to an empty container. */
  background: SlideBackground | undefined
  /** Artboard world size. */
  width: number
  height: number
  /**
   * Optional resolver for `ImageBackground.assetId → url` — usually the
   * main app's imgproxy URL resolver. Without it, image backgrounds
   * stay blank.
   */
  resolveAssetUrl?: (assetId: string) => Promise<string>
  /**
   * Optional texture acquire/release hooks. If provided, image
   * backgrounds go through the app's ResourceManager so it can ref-
   * count shared textures.
   */
  acquireTexture?: (url: string) => Promise<Texture>
  releaseTexture?: (url: string) => void
}

export function applyBackground(args: ApplyBackgroundArgs): void {
  const { container, background, width, height } = args
  const sig = signature(background, width, height)
  if (sig === getSignature(container)) return

  // Tear down current content.
  clearContainer(container, args.releaseTexture)
  setSignature(container, sig)

  if (background === undefined) return

  if (background.kind === 'color') {
    const g = new Graphics()
    g.rect(0, 0, width, height)
    g.fill({ color: background.color, alpha: background.alpha ?? 1 })
    container.addChild(g)
    return
  }

  if (background.kind === 'linearGradient' || background.kind === 'radialGradient') {
    // P12c: route the painted gradient through ResourceManager's
    // procedural cache (ref-counted, LRU-bounded). Without this,
    // clearContainer() would destroy the Sprite but leak the texture
    // every time the user nudged the gradient slider.
    const key = `bg:${sig}`
    let texture: Texture
    try {
      const rm = getDefaultResourceManager()
      texture = rm.acquireProcedural(key, () => {
        const canvas = canvasForGradient(width, height)
        if (background.kind === 'linearGradient') {
          paintLinear(canvas, background, width, height)
        } else {
          paintRadial(canvas, background)
        }
        return Texture.from(canvas)
      })
      setProceduralKey(container, key)
    } catch {
      // ResourceManager not installed (tests, headless thumb) — fall
      // back to a fresh paint with no caching. Matches pre-P12c
      // behaviour for those callers.
      const canvas = canvasForGradient(width, height)
      if (background.kind === 'linearGradient') {
        paintLinear(canvas, background, width, height)
      } else {
        paintRadial(canvas, background)
      }
      texture = Texture.from(canvas)
    }
    const sprite = new Sprite(texture)
    sprite.width = width
    sprite.height = height
    container.addChild(sprite)
    return
  }

  // image
  void mountImageBackground(container, background, width, height, args)
}

async function mountImageBackground(
  container: Container,
  bg: ImageBackground,
  width: number,
  height: number,
  args: ApplyBackgroundArgs,
): Promise<void> {
  if (bg.assetId === '' || args.resolveAssetUrl === undefined) return
  let url: string
  try {
    url = await args.resolveAssetUrl(bg.assetId)
  } catch {
    return
  }
  if (getSignature(container) !== signature(bg, width, height)) return

  let texture: Texture
  if (args.acquireTexture !== undefined) {
    try {
      texture = await args.acquireTexture(url)
    } catch {
      return
    }
    setAcquiredUrl(container, url)
  } else {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = url
    try {
      await img.decode()
    } catch {
      return
    }
    texture = Texture.from(img)
  }
  if (getSignature(container) !== signature(bg, width, height)) {
    args.releaseTexture?.(url)
    return
  }

  const sprite = new Sprite(texture)
  const texW = texture.width
  const texH = texture.height
  if (texW > 0 && texH > 0) {
    if (bg.fit === 'cover') {
      const s = Math.max(width / texW, height / texH)
      sprite.width = texW * s
      sprite.height = texH * s
      sprite.x = (width - sprite.width) / 2
      sprite.y = (height - sprite.height) / 2
    } else {
      const s = Math.min(width / texW, height / texH)
      sprite.width = texW * s
      sprite.height = texH * s
      sprite.x = (width - sprite.width) / 2
      sprite.y = (height - sprite.height) / 2
    }
  }
  container.addChild(sprite)

  if (bg.dim !== undefined && bg.dim > 0) {
    const dim = new Graphics()
    dim.rect(0, 0, width, height)
    dim.fill({ color: 0x000000, alpha: clamp01(bg.dim) })
    container.addChild(dim)
  }

  // P12b: Pixi auto-render is OFF — when this async path resolves it has
  // mutated the scene without anyone calling markDirty for us.
  markRenderDirty()
}

function clearContainer(container: Container, release?: (url: string) => void): void {
  const acquired = getAcquiredUrl(container)
  if (acquired !== undefined) {
    release?.(acquired)
    setAcquiredUrl(container, undefined)
  }
  // P12c: release the procedural-cache ref before destroying child
  // sprites — the ResourceManager owns the texture, the Sprite was just
  // a renderer for it.
  const procKey = getProceduralKey(container)
  if (procKey !== undefined) {
    try {
      getDefaultResourceManager().releaseProcedural(procKey)
    } catch {
      // ResourceManager not installed — safe to drop.
    }
    setProceduralKey(container, undefined)
  }
  for (const child of [...container.children]) {
    if (!child.destroyed) child.destroy({ children: true })
  }
}
