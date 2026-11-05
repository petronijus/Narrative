/**
 * renderer/runText/runTextSystem.ts — a renderer's HTMLText rasters drawn
 * from glyph runs (ADR 0018).
 *
 * Pixi's HTMLText pipe asks the renderer's `htmlText` system for a text's
 * texture (`getTexturePromise(text)`) and hands the old one back when it has
 * a new one (`returnTexturePromise`). Those two public methods are wrapped on
 * the renderer's own system instance — Pixi's extension point for a system is
 * its interface, and the pipe, the bounds, the batching and everything that
 * waits for a raster (`_gpuData[uid].texturePromise`: thumbnails, present
 * mode, the render page, the zoom staging, the realignment) stay as they are:
 *
 *   1. the text's layout (`layoutCache.ts`: usually already there, the
 *      node's bounds were measured from it);
 *   2. painted at the text's resolution in a worker (`textRasterPool.ts`),
 *      into a canvas as large as the texture Pixi would give the raster;
 *   3. that texture (`RunTextureShape`) — where the canvas draws the page,
 *      one of its own, the raster's exact size, mipmapped only where it is
 *      drawn resampled, destroyed when the pipe returns it; elsewhere
 *      (thumbnails, HTMLText-compatible mode) Pixi's pooled power-of-two
 *      one, the same geometry as an HTMLText raster's (`textureSizeFor`),
 *      handed back to the pool — with the bitmap as its resource, uploaded
 *      at once (as Pixi uploads its raster when it lands).
 *
 * A text the run painter cannot draw as the engine does (`layout.unsupported`,
 * or a paint that fails) is rasterised by Pixi's own path instead — the
 * system's original method, with the race patch and the table grouping
 * around it (patchHTMLTextRace.ts). Its texture goes back to Pixi as before.
 */

import { Matrix, Rectangle, Texture, TexturePool, TextureSource, updateTextBounds } from 'pixi.js'
import type { HTMLText, Renderer } from 'pixi.js'
import { perfCount } from '@narrative/shared'
import { perfAvailable } from '../../perf/activation.js'
import { markRenderDirty } from '../RenderScheduler.js'
import { anyFaceOnTheWay, familiesOnTheWayIn, whenFamiliesSettled } from '../fontChanges.js'
import { trackRenderWork } from '../renderWork.js'
import { setHtmlTextMeasurer } from '../htmlTextBoundsMemo.js'
import { faceHoldEnabled, htmlTextCompatible, runTextEnabled } from './flag.js'
import type { TextDiff } from './fidelityProbe.js'
import { placeLayout, rasterSize, type TextRunLayout } from './glyphRuns.js'
import { engineRules, layoutEngine, measureWithRunLayout, runLayoutFor } from './layoutCache.js'
import { apply, boxOnPage, multiply, pageSpace, type Affine } from './pagePlacement.js'
import {
  drawnRegionOf,
  drawsPage,
  gridPhaseOf,
  onTexelGrid,
  ownScale,
  pageGridFor,
  pageOriginOf,
  PlacementWatch,
  rasterTop,
  sceneTransform,
} from './placement.js'
import { paintOnMainThread, textRasterPool } from './textRasterPool.js'
import { maxTextureSide } from '../maxTextureSide.js'
import { RUN_RASTER_UPLOAD } from './runRasterUpload.js'
import { textureSourceBytes } from '../ResourceManager.js'

interface HtmlTextSystemLike {
  getTexturePromise(options: unknown): Promise<Texture>
  returnTexturePromise(texturePromise: Promise<Texture>): void
}

const INSTALLED = Symbol('narrative.runTextSystem')

/** Textures this module made (and so destroys), with the bitmap behind each. */
const RUN_TEXTURES = new WeakMap<Texture, ImageBitmap>()

/** Those of them that are their own texture, not the pool's (RunTextureShape `exact`). */
const EXACT_TEXTURES = new WeakSet<Texture>()

/** What gets mipmaps (mipmapsFor): only rasters drawn resampled, or every one. */
export type RunTextMipmaps = 'resampled' | 'always'

/** Each renderer: whether an ImageBitmap uploads premultiplied when asked (UNPACK_PREMULTIPLY_ALPHA). */
const premultipliedBitmapUploads = new WeakMap<object, boolean>()

/**
 * Whether `renderer`'s WebGL premultiplies an ImageBitmap on upload as Pixi
 * asks it to (`premultiply-alpha-on-upload`). WebKit does not: it uploads a
 * bitmap's colours straight whatever the flag says, and Pixi's premultiplied
 * blending then drew every partly covered pixel of non-black text too bright
 * — white text on navy 1.48× the ink, grey text on a light fill 0.84×, black
 * text exact (probe 2026-10-30: the same bitmap uploaded and blended against
 * Canvas2D's drawImage; a canvas element uploads right). The "smoothing" the
 * gates saw on coloured WebKit text was this. Probed once per renderer: a
 * 1×1 half-transparent white bitmap reads back 128, not 255, when right.
 */
function premultipliesBitmaps(renderer: Renderer): boolean {
  const known = premultipliedBitmapUploads.get(renderer)
  if (known !== undefined) return known
  let result = true
  const gl = (renderer as unknown as { gl?: WebGLRenderingContext }).gl
  if (gl !== undefined && typeof OffscreenCanvas === 'function') {
    const oc = new OffscreenCanvas(1, 1)
    const c = oc.getContext('2d')
    if (c !== null) {
      c.fillStyle = 'rgba(255, 255, 255, 0.5)'
      c.fillRect(0, 0, 1, 1)
      const bitmap = oc.transferToImageBitmap()
      // Pixi caches its GL state: everything touched is put back as it was.
      const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
      const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      const unpack = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean
      const probe = gl.createTexture()
      const fb = gl.createFramebuffer()
      gl.bindTexture(gl.TEXTURE_2D, probe)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probe, 0)
      const px = new Uint8Array(4)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        result = px[0]! < 192
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, unpack)
      gl.deleteFramebuffer(fb)
      gl.deleteTexture(probe)
      bitmap.close()
    }
  }
  premultipliedBitmapUploads.set(renderer, result)
  return result
}

/** Which renderer a run texture serves: the editor canvas (`text`) or the thumbnails' (`thumb.text`). */
export type RunTextCounters = 'text' | 'thumb.text'

/** A live run-text texture: whose it is, the raster it holds, the text it was painted for. */
interface RunTextureEntry {
  counters: RunTextCounters
  /** The raster's own size (texels); the texture may be larger. */
  raster: { width: number; height: number }
  resolution: number
  text: WeakRef<HTMLText>
}

/** Every run-text texture made and not yet destroyed (the perf harness reads them: runTextureMemory). */
const LIVE_RUN_TEXTURES = new Map<Texture, RunTextureEntry>()

/** One live run-text texture as the perf harness sees it (runTextureMemory). */
export interface RunTextureInfo {
  raster: { width: number; height: number }
  texture: { width: number; height: number }
  resolution: number
  mipmaps: boolean
  /** The text it is a raster of (null: collected). */
  text: HTMLText | null
}

/**
 * The live run-text textures of `counters`' renderer: how many, the pixels of
 * their rasters and of the textures holding them, and the GPU bytes those
 * take (4 a pixel, a third more with mipmaps — ResourceManager's estimate).
 */
export function runTextureMemory(counters: RunTextCounters): {
  count: number
  rasterPx: number
  texturePx: number
  mipmapped: number
  bytes: number
  textures: RunTextureInfo[]
} {
  let count = 0
  let rasterPx = 0
  let texturePx = 0
  let mipmapped = 0
  let bytes = 0
  const textures: RunTextureInfo[] = []
  for (const [texture, e] of LIVE_RUN_TEXTURES) {
    if (e.counters !== counters) continue
    const source = texture.source
    count++
    rasterPx += e.raster.width * e.raster.height
    texturePx += source.pixelWidth * source.pixelHeight
    if (source.autoGenerateMipmaps) mipmapped++
    bytes += textureSourceBytes(source)
    textures.push({
      raster: { ...e.raster },
      texture: { width: source.pixelWidth, height: source.pixelHeight },
      resolution: e.resolution,
      mipmaps: source.autoGenerateMipmaps,
      text: e.text.deref() ?? null,
    })
  }
  return { count, rasterPx, texturePx, mipmapped, bytes, textures }
}

export interface RunTextOptions {
  /** Ask the editor's render scheduler for a frame when a raster lands (not offscreen renderers). */
  wakeRenderScheduler: boolean
  /** Prefix of the perf counters: `text` on the editor canvas, `thumb.text` offscreen. */
  counters: RunTextCounters
  /**
   * Which rasters get mipmaps (mipmapsFor; default `always`): `resampled`
   * where texts rest on the canvas's device grid and only a gesture scales
   * them (the editor).
   */
  mipmaps?: RunTextMipmaps
}

/**
 * Measure every HTMLText of the page with the run layout (when the page draws
 * text from runs). Called at import by `objectRenderers/textRenderer.ts`,
 * before any text exists.
 */
export function installRunTextMeasurement(): void {
  if (runTextEnabled()) setHtmlTextMeasurer(measureWithRunLayout)
}

/**
 * The pooled texture a raster gets (RunTextureShape `pooled`): Pixi's own
 * for an HTMLText raster of this size (`getPo2TextureFromSource`: a pooled
 * texture sized by `TexturePool` from the raster plus Pixi's 2 px UV
 * margin, the frame the raster's size). The
 * same backing size matters for the pixels, not only for the pool: a texture
 * of another size is sampled with other UV steps and other mip levels, which
 * moved text drawn scaled (a shrunk autofit box, a thumbnail) by up to 64 of
 * 255 and everything else by 1 (e2e/text-runs-artboard.spec.ts, 2026-10-26).
 */
export function textureSizeFor(
  raster: { width: number; height: number },
  resolution: number,
): { width: number; height: number } {
  const uvSafeOffset = 2
  return TexturePool.getOptimalSize(
    ((raster.width + uvSafeOffset) / resolution) | 0,
    ((raster.height + uvSafeOffset) / resolution) | 0,
    resolution,
  )
}

/**
 * What texture a raster gets (`textureShapeFor`):
 *
 *   - `exact`: a texture of its own, the raster's size texel for texel, its
 *     GPU memory freed the moment the pipe hands it back. Where the canvas
 *     draws the page (the editor, present mode, the render page — not in
 *     HTMLText-compatible mode): there a raster is painted for the canvas's
 *     device grid and drawn texel on device pixel, or turned at that scale,
 *     and nothing compares its sampling with an HTMLText raster's. The
 *     pool's power-of-two sizes held 2.0× the rasters' pixels on the crowded
 *     slide, and every returned texture kept its GPU memory in Pixi's pool
 *     until Pixi's collector ran a minute later (1.7 GB at the fitted zoom
 *     after a zoom to 544 %, 2026-10-31; ADR 0020 → texture memory).
 *     `mipmaps`: whether it gets a mipmap chain (`mipmapsFor`).
 *   - `pooled`: Pixi's own texture for an HTMLText raster of this size
 *     (`textureSizeFor`) — the thumbnails, which draw text scaled down, and
 *     HTMLText-compatible mode, whose pixels are compared with HTMLText's.
 */
export type RunTextureShape = { kind: 'exact'; mipmaps: boolean } | { kind: 'pooled' }

/** The size the painter paints a raster at for a texture of `shape`. */
export function paintSizeFor(
  shape: RunTextureShape,
  raster: { width: number; height: number },
  resolution: number,
): { width: number; height: number } {
  return shape.kind === 'exact'
    ? { width: raster.width, height: raster.height }
    : textureSizeFor(raster, resolution)
}

/**
 * Whether an exact texture needs mipmaps: a raster drawn at more than one
 * of its texels a device pixel when it is painted. A raster on the device
 * grid (`onGrid`: placed, or painted in device px) is drawn texel for device
 * pixel and needs none — a third more memory and a `generateMipmap` per
 * upload for levels nothing samples. Off the grid, the texels a device px
 * along the text's axes: a text in a group scaled down, or held at a
 * resolution above the canvas's. `always` (present mode, the render page:
 * builds and transitions scale texts down while they play, captures are
 * drawn smaller than the canvas) keeps them on every raster, as before.
 *
 * A raster on the grid drawn smaller later — a zoom-out gesture, before the
 * commit's staging paints it again — is minified without them meanwhile, as
 * the compositor minified the whole canvas during a gesture before ADR 0020.
 */
export function mipmapsFor(
  policy: RunTextMipmaps,
  onGrid: boolean,
  /** The raster's texels per world px (its resolution). */
  resolution: number,
  /** Device px per world px of the text where it is drawn: the canvas's resolution × the text's world scale. */
  drawn: number,
): boolean {
  if (policy === 'always') return true
  if (onGrid) return false
  return drawn > 0 && resolution / drawn > 1 + 1e-3
}

/**
 * The raster as its texture: the bitmap covers the whole backing texture
 * (the worker painted it at the texture's size, transparent beyond the
 * raster), so nothing a previous user of a pooled texture left stays in it.
 * Uploaded at once, as Pixi uploads its raster when it lands.
 */
/** The texture fields that place its quad (read-only in Pixi's typings). */
interface MutableQuad {
  orig: Rectangle
  trim: Rectangle | undefined
}

function runTexture(
  renderer: Renderer | null,
  bitmap: ImageBitmap,
  raster: { width: number; height: number },
  resolution: number,
  text: HTMLText,
  /**
   * How far the quad is moved off where Pixi would put it (CSS px): a placed
   * raster's corner onto the whole device pixel it was painted for
   * (placement.ts). Done with the texture's trim, not `roundPixels`: the
   * shader rounds in float32, and at a corner a hair from a half pixel it
   * rounded the other way than the painter did — the text a device px off
   * (measured: 0.87 px at the fitted zoom).
   */
  offset: { x: number; y: number } | null = null,
  /** The text's key the raster was painted for (default: its key now). */
  key: string = text.styleKey,
  /** A raster painted in device px (pagePlacement.ts): where it lies, upright, in world px. */
  device: DeviceQuad | null = null,
  /**
   * A placed raster cut to the drawn region (cutToRegion): the whole raster's
   * frame and where the cut part lies in it, in the text's own units — the
   * quad is anchored on the whole frame and placed at the part.
   */
  cut: { full: { width: number; height: number }; at: { x: number; y: number } } | null = null,
  /** Whose texture it is (the perf harness's ledger, runTextureMemory). */
  counters: RunTextCounters = 'text',
  /** A texture of its own, or a pooled one (RunTextureShape). */
  shape: RunTextureShape = { kind: 'pooled' },
): Texture {
  const scaleMode = text.textureStyle?.scaleMode
  let texture: Texture
  if (shape.kind === 'exact') {
    const source = new TextureSource({
      width: raster.width / resolution,
      height: raster.height / resolution,
      resolution,
      autoGenerateMipmaps: shape.mipmaps,
      // Freed when the pipe returns it (destroyRunTexture), never by Pixi's
      // collector behind the renderer's back (as the pool's textures).
      autoGarbageCollect: false,
      ...(scaleMode !== undefined ? { scaleMode } : {}),
    })
    // Whole texels, whatever width / resolution × resolution rounds to.
    source.pixelWidth = raster.width
    source.pixelHeight = raster.height
    texture = new Texture({ source })
    EXACT_TEXTURES.add(texture)
  } else {
    const uvSafeOffset = 2
    texture = TexturePool.getOptimalTexture({
      width: ((raster.width + uvSafeOffset) / resolution) | 0,
      height: ((raster.height + uvSafeOffset) / resolution) | 0,
      resolution,
      autoGenerateMipmaps:
        text.autoGenerateMipmaps ?? TextureSource.defaultOptions.autoGenerateMipmaps ?? false,
      ...(scaleMode !== undefined ? { scaleMode } : {}),
    })
  }
  const source = texture.source
  const resource = bitmap
  source.uploadMethodId =
    renderer === null || premultipliesBitmaps(renderer) ? 'image' : RUN_RASTER_UPLOAD
  source.resource = resource
  source.alphaMode = 'premultiply-alpha-on-upload'
  texture.frame.width = raster.width / resolution
  texture.frame.height = raster.height / resolution
  texture.updateUvs()
  if (device !== null) {
    // The quad is the raster's rectangle in the render group's space, drawn
    // through the transform the text has moved by since (deviceQuadTransform):
    // Pixi computes it from the trim, the anchor and the padding
    // (updateTextBounds), so the trim is what puts it there.
    const { width, height } = texture.frame
    const own = texture as unknown as MutableQuad
    const pad = (text.style as unknown as { _getFinalPadding(): number })._getFinalPadding()
    const ax = text.anchor.x
    const ay = text.anchor.y
    own.orig = new Rectangle(0, 0, width, height)
    own.trim = new Rectangle(
      ax * width + pad - 2 * ax * pad,
      ay * height + pad - 2 * ay * pad,
      width,
      height,
    )
    DEVICE_QUADS.set(texture, device)
  } else if (offset !== null) {
    const { width, height } = texture.frame
    // Pixi declares both read-only; its Texture constructor sets them (orig
    // defaulting to the frame itself) and nothing caches them.
    const own = texture as unknown as MutableQuad
    own.orig = new Rectangle(
      0,
      0,
      cut === null ? width : cut.full.width,
      cut === null ? height : cut.full.height,
    )
    own.trim = new Rectangle(
      offset.x + (cut?.at.x ?? 0),
      offset.y + (cut?.at.y ?? 0),
      width,
      height,
    )
  }
  RUN_TEXTURES.set(texture, resource)
  // What it is a raster of (the text's key when painted): diagnostics and the
  // e2e transition spec read it — a texture drawn while another is still in
  // flight may already be the current one (rasterStaleTextNow).
  texture.label = `runText:${key}`
  LIVE_RUN_TEXTURES.set(texture, {
    counters,
    raster: { width: raster.width, height: raster.height },
    resolution,
    text: new WeakRef(text),
  })
  source.emit('update', source)
  renderer?.texture.initSource(source)
  return texture
}

function destroyRunTexture(texture: Texture): void {
  const resource = RUN_TEXTURES.get(texture)
  if (resource === undefined) return
  RUN_TEXTURES.delete(texture)
  LIVE_RUN_TEXTURES.delete(texture)
  if (EXACT_TEXTURES.delete(texture)) {
    // Its own texture: gone from the GPU now (TextureSource.destroy unloads it).
    DEVICE_QUADS.delete(texture)
    if (!texture.destroyed) texture.destroy(true)
  } else if (!texture.destroyed) {
    // Back to the pool as Pixi returns its rasters (HTMLTextSystem._cleanUp);
    // destroying the stage with its textures may have got here first.
    // The pool's next user gets the texture as the pool made it.
    const own = texture as unknown as MutableQuad
    own.orig = texture.frame
    own.trim = undefined
    DEVICE_QUADS.delete(texture)
    texture.label = ''
    const source = texture.source
    TexturePool.returnTexture(texture)
    source.resource = null as unknown as ImageBitmap
    source.uploadMethodId = 'unknown'
  }
  resource.close()
}

/**
 * A raster painted in device px (pagePlacement.ts) and where it was painted
 * for: its corner in the render group's space, and the inverse of the text's
 * group transform then — the quad is drawn through the group transform now
 * times that inverse, so it stays upright on its pixels while the text has
 * not moved, and moves with it (turned, if the text turns) until the
 * placement watch paints it again.
 */
interface DeviceQuad {
  /** The raster's quad (from 0, 0, in its texels over the canvas's resolution) into the render group's space, when painted. */
  place: Matrix
  inverse: Matrix
}

const DEVICE_QUADS = new WeakMap<Texture, DeviceQuad>()

/** The GPU data of a text that the transform hook is installed on. */
const QUAD_HOOKED = Symbol('narrative.runText.deviceQuad')

/**
 * Pixi packs a text's quad through `transform` of its batchable (the text's
 * group transform, set once when the batchable is made). For a raster painted
 * in device px that is the group transform times the inverse of the one the
 * raster was painted for; for every other raster, the group transform itself.
 */
function hookQuadTransform(gpu: Record<PropertyKey, unknown>, text: HTMLText): void {
  if (gpu[QUAD_HOOKED] === true) return
  gpu[QUAD_HOOKED] = true
  const scratch = new Matrix()
  Object.defineProperty(gpu, 'transform', {
    configurable: true,
    enumerable: true,
    get(): Matrix {
      const texture = gpu['texture'] as Texture | undefined
      const quad = texture === undefined ? undefined : DEVICE_QUADS.get(texture)
      if (quad === undefined) return text.groupTransform
      return scratch.copyFrom(text.groupTransform).append(quad.inverse).append(quad.place)
    },
    set(): void {
      // Pixi sets it to the text's group transform, which the getter reads.
    },
  })
}

/** Whether `texture` is a run-text raster (tests, diagnostics). */
export function isRunTexture(texture: Texture | null | undefined): boolean {
  return texture !== null && texture !== undefined && RUN_TEXTURES.has(texture)
}

/** The width of the edit overlay's outline around a text box (ui/TextEditOverlay.tsx → rigStyle). */
const RIG_OUTLINE = 2

/** How far (device px) a raster cut to the drawn region reaches past it: a short scroll keeps it. */
const CUT_MARGIN = 256

/**
 * The part of a raster `width` × `height` texels whose texel (0, 0) is world
 * device px `corner` (world px × resolution) that the canvas's drawn
 * `region` (world px), and `CUT_MARGIN` around it, shows: texel ranges, and
 * the world rectangle that covers (unbounded on a side where nothing was
 * cut). Null when nothing needs cutting.
 */
function cutToRegion(
  corner: { x: number; y: number },
  size: { width: number; height: number },
  region: { x: number; y: number; width: number; height: number },
  resolution: number,
): {
  x0: number
  y0: number
  width: number
  height: number
  covers: { x: number; y: number; width: number; height: number }
} {
  const span = (c: number, n: number, r0: number, r1: number): [number, number] => {
    const a = Math.max(0, Math.min(n, Math.floor(r0 * resolution - c) - CUT_MARGIN))
    const b = Math.max(0, Math.min(n, Math.ceil(r1 * resolution - c) + CUT_MARGIN))
    // Nothing of it in view: one texel, painted again when the region reaches it.
    return b > a ? [a, b] : [a, Math.min(n, a + 1)]
  }
  const [x0, x1] = span(corner.x, size.width, region.x, region.x + region.width)
  const [y0, y1] = span(corner.y, size.height, region.y, region.y + region.height)
  const far = 1e12
  const left = x0 > 0 ? (corner.x + x0) / resolution : -far
  const right = x1 < size.width ? (corner.x + x1) / resolution : far
  const top = y0 > 0 ? (corner.y + y0) / resolution : -far
  const bottom = y1 < size.height ? (corner.y + y1) / resolution : far
  return {
    x0,
    y0,
    width: x1 - x0,
    height: y1 - y0,
    covers: { x: left, y: top, width: right - left, height: bottom - top },
  }
}

/**
 * How long a first raster waits for a face still downloading
 * (`whenFamiliesSettled`); a download that takes longer paints the fallback,
 * and again when the face lands.
 */
const FACE_WAIT_MS = 6000

/**
 * Draw `renderer`'s HTMLText from glyph runs (when the page does). After
 * `app.init()` (the system exists) and after `patchHTMLTextRace`, whose
 * patched raster is the fallback. Idempotent.
 */
export function installRunText(renderer: Renderer, opts: RunTextOptions): void {
  if (!runTextEnabled()) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's systems are untyped on Renderer
  const system = (renderer as any).htmlText as
    (HtmlTextSystemLike & { [INSTALLED]?: true }) | undefined
  if (system === undefined || system[INSTALLED] === true) return
  system[INSTALLED] = true
  const getHtml = system.getTexturePromise.bind(system)
  const returnHtml = system.returnTexturePromise.bind(system)
  const started = `${opts.counters}.raster.started`
  const finished = `${opts.counters}.raster.finished`
  const kpx = `${opts.counters}.raster.kpx`
  const fallback = `${opts.counters}.raster.fallback`
  const pool = textRasterPool()
  const paint = engineRules().paint
  const mipmapPolicy: RunTextMipmaps = opts.mipmaps ?? 'always'
  /** Rasters get textures of their own where the canvas draws the page (RunTextureShape). */
  const exactTextures = (): boolean => drawsPage(renderer) && !htmlTextCompatible()
  /** The texture size a raster takes (the limit checks): its own, or the pool's. */
  const textureSize = (
    raster: { width: number; height: number },
    resolution: number,
  ): { width: number; height: number } =>
    exactTextures()
      ? { width: raster.width, height: raster.height }
      : textureSizeFor(raster, resolution)
  /** The texture a raster of `text` at `resolution` gets (`onGrid`: drawn texel on device px). */
  const shapeFor = (
    text: HTMLText,
    resolution: number,
    onGrid: boolean,
    /** The canvas's resolution where the raster is drawn (its page grid's: pageGridFor). */
    deviceResolution: number,
  ): RunTextureShape => {
    if (!exactTextures()) return { kind: 'pooled' }
    const m = sceneTransform(text, new Matrix())
    const worldScale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
    return {
      kind: 'exact',
      mipmaps: mipmapsFor(mipmapPolicy, onGrid, resolution, deviceResolution * worldScale),
    }
  }
  // (deviceBox is a hoisted function below: the watch asks it after each frame.)
  const watch = new PlacementWatch(
    renderer,
    opts.counters,
    (text, base) => deviceBox(text, base) !== null,
  )

  /**
   * What a raster of `text` at `base` (its resolution) is: its layout, the
   * raster's own resolution (base × the text's own scale, ownScale), size,
   * place (placement.ts) and the quad's offset onto the device px it was
   * painted for. Null when the run painter cannot draw it.
   */
  /**
   * A text box turned, flipped or shrunk on the page the edit overlay draws
   * (pagePlacement.ts): its raster painted in device px, the layout drawn
   * through the transform the page draws it with — null when the text is
   * not one (the placed raster then, or an unplaced one).
   */
  /**
   * The box a text is drawn in on the page, when its raster is painted in
   * device px (devicePlan): a text box's text, turned, flipped or shrunk, at
   * the renderer's resolution (or the one of the page it is prepared for:
   * pageGridFor), on a canvas that draws the page. Null otherwise.
   */
  function deviceBox(text: HTMLText, base: number) {
    if (htmlTextCompatible() || !drawsPage(renderer)) return null
    const grid = pageGridFor(renderer, base)
    if (grid === null) return null
    // Pixi's data of the text in this renderer: the quad's transform is hooked there.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi keeps per-renderer GPU data untyped
    if ((text as any)._gpuData?.[renderer.uid] === undefined) return null
    const engine = layoutEngine()
    if (engine === 'other') return null
    const origin = grid.origin
    const box = boxOnPage(text, origin)
    if (box === null || (box.rig === null && box.scale === 1)) return null
    // The text itself upright and evenly scaled in its box (textRenderer).
    const k = box.scale
    if (!(k > 0)) return null
    if (text.rotation !== 0 || text.skew.x !== 0 || text.skew.y !== 0 || text.scale.y !== k)
      return null
    // The quad is drawn in the render group's space: world px up to a
    // translation (placement.ts → sceneTransform: the world without the
    // region transform Pixi puts on the stage while it renders).
    const world = sceneTransform(text, new Matrix())
    const group = text.groupTransform
    const toGroup = group.clone().append(world.clone().invert())
    if (
      Math.abs(toGroup.a - 1) > 1e-9 ||
      Math.abs(toGroup.d - 1) > 1e-9 ||
      Math.abs(toGroup.b) > 1e-9 ||
      Math.abs(toGroup.c) > 1e-9
    )
      return null
    return { box, engine, origin, k, group, toGroup, grid }
  }

  const devicePlan = (text: HTMLText, layout: TextRunLayout, base: number) => {
    const found = deviceBox(text, base)
    if (found === null) return null
    const { box, engine, origin, k, group, toGroup, grid: page } = found
    const dsf = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
    const space = pageSpace(box, engine, dsf)
    const dr = page.resolution
    const pad = layout.padding
    const cw = Math.max(1, layout.width) + 2 * pad
    const ch = Math.max(1, layout.height) + 2 * pad
    // The layout's (0, 0) in the box: where Pixi anchors the content (the
    // anchor's share of the content's own size, the padding kept).
    const ax = text.anchor.x
    const ay = text.anchor.y
    const inBox = {
      x: text.x + k * (-ax * cw - pad + 2 * ax * pad),
      y: text.y + k * (-ay * ch - pad + 2 * ay * pad),
    }
    // In the innermost layer (the frame's px for a shrunk box), as the page
    // holds it (LayoutUnits), plus what the layers' snapping left there.
    const at = {
      x: Math.round((inBox.x / k) * 64) / 64 + space.offset.x,
      y: Math.round((inBox.y / k) * 64) / 64 + space.offset.y,
    }
    if (engine === 'blink' && box.rig !== null) {
      // Blink composites the overlay's turned rig (it overlaps the WebGL
      // canvas): the compositor rasterises the rig's layer upright, at the
      // canvas's resolution, its texel grid from the rig's corner — the
      // glyphs placed there as an upright text is, no baseline rounded in
      // CSS px — and turns that raster (bilinear). Measured 2026-10-30
      // against the page with a WebGL canvas behind the rig: that model
      // pixel-exact at 90° and 180°, fractional offsets included; the paint
      // model 0.15–0.9 px off. The raster is that layer's, drawn through the
      // rig's transform (the rig at its offset rounded to a whole px, the
      // fraction dropped: pageSpace).
      const rig = pageSpace({ ...box, scale: 1 }, engine, dsf)
      const s = dr * k
      // The layer's raster starts at its bounds, which the overlay's 2 px
      // outline (ui/TextEditOverlay.tsx: the rig's edit outline) takes 2 px
      // past the rig's corner: the texel grid lies from (−2, −2) of the rig
      // (measured: from the corner, every row of a 90° / 180° text 0.13 px
      // off; from the outline's corner, exact).
      const grid = -RIG_OUTLINE / k
      let left = Math.floor(s * (at.x - grid)) - 1
      let top = Math.floor(s * (at.y - grid)) - 1
      let width = Math.ceil(s * (at.x - grid + cw)) + 1 - left
      let height = Math.ceil(s * (at.y - grid + ch)) + 1 - top
      let paintScale = s
      const pooledTurned = textureSize({ width, height }, dr)
      const limitTurned = maxTextureSide(renderer)
      if (pooledTurned.width > limitTurned || pooledTurned.height > limitTurned) {
        // Larger than a texture: the resolution a texture holds (soft, drawn).
        const fit = (limitTurned - 4) / Math.max(width, height)
        paintScale = s * fit
        left = Math.floor(paintScale * (at.x - grid)) - 1
        top = Math.floor(paintScale * (at.y - grid)) - 1
        width = Math.ceil(paintScale * (at.x - grid + cw)) + 1 - left
        height = Math.ceil(paintScale * (at.y - grid + ch)) + 1 - top
      }
      // texel = paintScale × (p − grid) − left: in the painter's terms
      // (texel = paintScale × p − device), device = left + paintScale × grid.
      const device = { x: left + paintScale * grid, y: top + paintScale * grid }
      const placedTurned: TextRunLayout = {
        ...layout,
        runs: layout.runs.map((r) => ({ ...r, x: r.x + at.x, y: r.y + at.y })),
        decorations: layout.decorations.map((d) => ({ ...d, x: d.x + at.x, top: d.top + at.y })),
        place: {
          device,
          css: { x: 0, y: 0 },
          // Blink rounds the baseline to a whole px of the layer (then the
          // compositor's raster places the glyphs).
          unit: 1,
          clip: { x: at.x, y: at.y, width: cw, height: ch },
        },
      }
      // The quad (texels / the canvas's resolution) → rig px (texel i is the
      // frame's (i + left) / paintScale, the rig's k times that) → world →
      // the render group.
      const q = (k * dr) / paintScale
      const toWorld = multiply(
        [1, 0, 0, 1, origin.x, origin.y],
        multiply(rig.toPage, [
          q,
          0,
          0,
          q,
          (k * device.x) / paintScale,
          (k * device.y) / paintScale,
        ]),
      )
      const place = toGroup
        .clone()
        .append(new Matrix(toWorld[0], toWorld[1], toWorld[2], toWorld[3], toWorld[4], toWorld[5]))
      return {
        grid: page,
        placed: placedTurned,
        scale: paintScale,
        raster: { width, height },
        quad: { place, inverse: group.clone().invert() },
        covers: null,
      }
    }
    // Layer coordinates → the canvas's device px (world px × resolution).
    const toDevice = multiply([dr, 0, 0, dr, dr * origin.x, dr * origin.y], space.toPage)
    const corners = [
      { x: at.x, y: at.y },
      { x: at.x + cw, y: at.y },
      { x: at.x, y: at.y + ch },
      { x: at.x + cw, y: at.y + ch },
    ].map((p) => apply(toDevice, p))
    const phase = page.phase
    const xs = corners.map((p) => p.x)
    const ys = corners.map((p) => p.y)
    // The raster: whole texels of the canvas around it, a texel more for the edges' AA.
    let x0 = Math.floor(Math.min(...xs) - phase.x) + phase.x - 1
    let y0 = Math.floor(Math.min(...ys) - phase.y) + phase.y - 1
    let raster = {
      width: Math.ceil(Math.max(...xs) - x0) + 1,
      height: Math.ceil(Math.max(...ys) - y0) + 1,
    }
    // Larger than a texture can be (a large text zoomed in): the part the
    // canvas draws, at full density (cutToRegion).
    let covers: { x: number; y: number; width: number; height: number } | null = null
    const region = page.region
    const pooled = textureSize(raster, dr)
    const limit = maxTextureSide(renderer)
    if (region !== null && (pooled.width > limit || pooled.height > limit)) {
      const c = cutToRegion({ x: x0, y: y0 }, raster, region, dr)
      x0 += c.x0
      y0 += c.y0
      raster = { width: c.width, height: c.height }
      covers = c.covers
    }
    // texel = full × p, written as outer × (scale × p − device), outer a turn or flip.
    const full = multiply([1, 0, 0, 1, -x0, -y0], toDevice)
    const scale = Math.sqrt(Math.abs(full[0] * full[3] - full[1] * full[2]))
    const outer: Affine = [full[0] / scale, full[1] / scale, full[2] / scale, full[3] / scale, 0, 0]
    const device = {
      x: -(outer[0] * full[4] + outer[1] * full[5]),
      y: -(outer[2] * full[4] + outer[3] * full[5]),
    }
    const placed: TextRunLayout = {
      ...layout,
      runs: layout.runs.map((r) => ({ ...r, x: r.x + at.x, y: r.y + at.y })),
      decorations: layout.decorations.map((d) => ({ ...d, x: d.x + at.x, top: d.top + at.y })),
      place: {
        device,
        css: { x: 0, y: 0 },
        unit: space.unit,
        ...(engine === 'webkit' ? { truncate: true } : {}),
        outer,
        clip: { x: at.x, y: at.y, width: cw, height: ch },
      },
    }
    const corner = toGroup.apply({ x: x0 / dr, y: y0 / dr })
    return {
      grid: page,
      placed,
      scale,
      raster,
      quad: {
        place: new Matrix(1, 0, 0, 1, corner.x, corner.y),
        inverse: group.clone().invert(),
      },
      covers,
    }
  }

  const plan = (text: HTMLText, base: number) => {
    const layout = runLayoutFor(text.text, text.style)
    if (layout.unsupported !== undefined) return null
    const inDevice = devicePlan(text, layout, base)
    if (inDevice !== null)
      return {
        layout,
        // The texture's: texels on the canvas's device px.
        resolution: inDevice.grid.resolution,
        // The painter's: the layout's px to device px.
        paintResolution: inDevice.scale,
        raster: inDevice.raster,
        top: null,
        placed: inDevice.placed,
        offset: null,
        quad: inDevice.quad,
        cut: null,
        covers: inDevice.covers,
        unit: 1,
        shape: shapeFor(text, inDevice.grid.resolution, true, inDevice.grid.resolution),
        grid: inDevice.grid,
      }
    // The page the raster lands on: the canvas's now, or the one it is
    // prepared for (a present standby set, pageGridFor); null: none — not
    // on a device grid.
    const grid = pageGridFor(renderer, base)
    const dr = grid?.resolution ?? renderer.resolution
    const scale = grid !== null ? ownScale(text) : 1
    let resolution = base * scale
    let raster = rasterSize(layout, resolution)
    const limit = maxTextureSide(renderer)
    const pooled = textureSize(raster, resolution)
    const tooLarge = pooled.width > limit || pooled.height > limit
    // No region to cut to (a thumbnail, the render page, the editor before
    // its region is laid out): the largest resolution a texture holds —
    // drawn a little soft, never not at all; painted again once a region
    // is there (an empty `covers` never holds one).
    let softened = false
    const region = grid !== null ? grid.region : drawnRegionOf(renderer)
    if (tooLarge && region === null) {
      const fit = (limit - 4) / Math.max(raster.width, raster.height)
      resolution *= fit
      raster = rasterSize(layout, resolution)
      softened = true
    }
    // Painted for where it lands, when it lands on the device grid
    // (placement.ts): baselines rounded where the page rounds them.
    const top = rasterTop(text, raster, layout.padding, resolution, dr, layout)
    const phase = grid?.phase ?? gridPhaseOf(renderer)
    // The page's rounding unit (RasterPlace.unit): WebKit's page rounds to device px.
    const webkitPage = engineRules().paint.decorations === 'webkit' && drawsPage(renderer)
    const unit = webkitPage
      ? globalThis.devicePixelRatio > 0
        ? globalThis.devicePixelRatio
        : 1
      : 1
    const placed =
      top === null
        ? layout
        : placeLayout(
            layout,
            top,
            resolution,
            grid?.origin ?? pageOriginOf(renderer),
            top.shift,
            top.frame === null
              ? undefined
              : { origin: top.frame, scale: top.scale, deviceResolution: dr },
            phase,
            unit,
            webkitPage,
            top.box,
          )
    // The texture's trim, in the text's own units: the quad's corner onto
    // the device px the raster was painted for.
    const offset =
      top === null
        ? null
        : {
            x: (onTexelGrid(top.x * dr, phase.x) / dr - top.x) / top.scale,
            y: (onTexelGrid(top.y * dr, phase.y) / dr - top.y) / top.scale,
          }
    // Larger than a texture can be (a large text zoomed in, the region
    // known): the part the canvas draws, at full density — texel for device
    // px, placed as the whole raster is (cutToRegion).
    let cut: { full: { width: number; height: number }; at: { x: number; y: number } } | null = null
    let covers: { x: number; y: number; width: number; height: number } | null = softened
      ? { x: 0, y: 0, width: 0, height: 0 }
      : null
    let painted = placed
    if (tooLarge && region !== null) {
      if (top === null || placed.place === undefined) {
        // Not on the device grid (turned, or another resolution): the
        // largest resolution a texture holds.
        const fit = (limit - 4) / Math.max(raster.width, raster.height)
        resolution *= fit
        raster = rasterSize(layout, resolution)
      } else {
        const corner = { x: onTexelGrid(top.x * dr, phase.x), y: onTexelGrid(top.y * dr, phase.y) }
        const c = cutToRegion(corner, raster, region, dr)
        cut = {
          full: { width: raster.width / resolution, height: raster.height / resolution },
          at: { x: c.x0 / resolution, y: c.y0 / resolution },
        }
        covers = c.covers
        painted = {
          ...placed,
          place: {
            ...placed.place,
            device: { x: placed.place.device.x + c.x0, y: placed.place.device.y + c.y0 },
          },
        }
        raster = { width: c.width, height: c.height }
      }
    }
    return {
      layout,
      resolution,
      paintResolution: resolution,
      raster,
      top,
      placed: painted,
      offset,
      quad: null,
      cut,
      covers,
      unit,
      shape: shapeFor(text, resolution, top !== null, dr),
      grid,
    }
  }

  /** Pixi's per-renderer data of `text` (devicePlan made sure it exists). */
  const gpuDataOf = (text: HTMLText): Record<PropertyKey, unknown> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi keeps per-renderer GPU data untyped
    (text as any)._gpuData[renderer.uid] as Record<PropertyKey, unknown>

  const fromRuns = async (text: HTMLText): Promise<Texture> => {
    // A face of the text's family still downloading: wait for it rather than
    // paint the fallback face and move when it lands (ADR 0018 → Fonts). Pixi
    // keeps drawing the text's previous texture meanwhile, if it had one.
    const waitingFor =
      faceHoldEnabled() && anyFaceOnTheWay()
        ? familiesOnTheWayIn(text.text, text.style.cssStyle)
        : []
    if (waitingFor.length > 0) {
      perfCount(`${opts.counters}.raster.heldForFace`)
      await trackRenderWork(whenFamiliesSettled(waitingFor, FACE_WAIT_MS))
    }
    // The key this raster is of: the node may change while it is painted.
    const key = text.styleKey
    const base = text.resolution
    const p = plan(text, base)
    if (p === null) {
      perfCount(fallback)
      return await getHtml(text)
    }
    const {
      layout,
      resolution,
      paintResolution,
      raster,
      top,
      placed,
      offset,
      quad,
      cut,
      covers,
      unit,
      shape,
      grid,
    } = p
    // started/finished pair up on every path (the perf harness's settle waits
    // for them to match); a fallback's HTMLText raster counts its own.
    perfCount(started)
    let painted: Awaited<ReturnType<typeof pool.paint>>
    try {
      painted = await pool.paint(
        placed,
        paintResolution,
        paint,
        paintSizeFor(shape, raster, resolution),
      )
    } finally {
      perfCount(finished)
    }
    if (painted === null) {
      perfCount(fallback)
      return await getHtml(text)
    }
    // The raster's own pixels, as patchHTMLTextRace counts an HTMLText raster's.
    perfCount(kpx, Math.round((raster.width * raster.height) / 1000))
    if (painted.where === 'main') perfCount(`${opts.counters}.raster.mainThread`)
    // The system forgets its renderer when the renderer is destroyed (a slide
    // switch tearing down a thumbnail renderer mid-paint): nothing to upload to.
    const live = (system as { _renderer?: unknown })._renderer != null ? renderer : null
    if (quad !== null) hookQuadTransform(gpuDataOf(text), text)
    const texture = runTexture(
      live,
      painted.bitmap,
      raster,
      resolution,
      text,
      offset,
      key,
      quad,
      cut,
      opts.counters,
      shape,
    )
    if (quad !== null) watch.recordDevice(text, covers, grid)
    else
      watch.record(text, top, layout.padding, resolution, layout, base, covers, unit, grid?.phase)
    if (opts.wakeRenderScheduler) markRenderDirty()
    return texture
  }

  system.getTexturePromise = (options: unknown): Promise<Texture> => fromRuns(options as HTMLText)

  // A stale raster painted now, on the page (rasterStaleTextNow).
  syncPainters.set(renderer, (text: HTMLText): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi keeps per-renderer GPU data untyped
    const gpu = (text as any)._gpuData?.[renderer.uid] as SyncGpuText | undefined
    if (gpu === undefined || text.destroyed) return false
    if (gpu.generatingTexture !== true && gpu.currentKey === text.styleKey) return false
    if (anyFaceOnTheWay() && familiesOnTheWayIn(text.text, text.style.cssStyle).length > 0)
      return false
    const base = text._autoResolution ? renderer.resolution : text.resolution
    const p = plan(text, base)
    if (p === null) return false
    const {
      layout,
      resolution,
      paintResolution,
      raster,
      top,
      placed,
      offset,
      quad,
      cut,
      covers,
      unit,
      shape,
      grid,
    } = p
    const size = paintSizeFor(shape, raster, resolution)
    const painted = paintOnMainThread(placed, paintResolution, paint, size.width, size.height)
    if (painted === null) return false
    perfCount(`${opts.counters}.raster.sync`)
    // Pixi's own raster of this text, started now if none is: when it lands
    // it replaces the one painted here, which then goes back to the pool.
    if (gpu.generatingTexture !== true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's render pipes are untyped
      const pipe = (renderer as any).renderPipes?.htmlText as
        { _updateGpuText(t: HTMLText): Promise<void> } | undefined
      pipe?._updateGpuText(text).catch((e: unknown) => console.error(e))
    }
    if (quad !== null) hookQuadTransform(gpu as unknown as Record<PropertyKey, unknown>, text)
    const now = runTexture(
      renderer,
      painted.bitmap,
      raster,
      resolution,
      text,
      offset,
      text.styleKey,
      quad,
      cut,
      opts.counters,
      shape,
    )
    if (quad !== null) watch.recordDevice(text, covers, grid)
    else
      watch.record(text, top, layout.padding, resolution, layout, base, covers, unit, grid?.phase)
    gpu.texture = now
    updateTextBounds(gpu as never, text)
    const group = text.renderGroup ?? text.parentRenderGroup
    if (group !== null && group !== undefined) group.structureDidChange = true
    const landing = gpu.texturePromise
    const release = (): void => {
      if (gpu.texture === now && !text.destroyed) return void setTimeout(release, 100)
      destroyRunTexture(now)
    }
    if (landing != null) landing.then(release, release)
    else release()
    markRenderDirty()
    return true
  })

  if (opts.counters === 'text' && perfAvailable()) exposeProbe(renderer, getHtml, returnHtml)

  system.returnTexturePromise = (texturePromise: Promise<Texture>): void => {
    texturePromise.then(
      (texture) => {
        if (RUN_TEXTURES.has(texture)) destroyRunTexture(texture)
        else returnHtml(Promise.resolve(texture))
      },
      () => {
        /* a failed raster has nothing to return; Pixi reports its own failures */
      },
    )
  }
}

interface SyncGpuText {
  texture: Texture
  texturePromise?: Promise<Texture> | null
  generatingTexture?: boolean
  currentKey?: string
}

/** Each renderer's synchronous page painter (installRunText). */
const syncPainters = new WeakMap<Renderer, (text: HTMLText) => boolean>()

/**
 * Paint `text` now, on the page, if the raster `renderer` draws for it is
 * not of its current text and style (a raster still in a worker): the next
 * frame then draws what the text is. For the moment the edit overlay goes
 * (SceneGraph.setTextNodeFaded): a character typed just before was otherwise
 * drawn missing for the frames the worker took (e2e/text-edit-transition).
 * Returns whether it painted. Nothing where the page does not draw runs.
 */
export function rasterStaleTextNow(renderer: Renderer, text: HTMLText): boolean {
  return syncPainters.get(renderer)?.(text) ?? false
}

/** What the e2e parity specs read (`window.__narrative_runText`, dev builds and `?perf=1`). */
export interface RunTextDebugApi {
  /** Every text on the editor canvas drawn both ways and compared (fidelityProbe.ts). */
  compare(options?: { images?: number }): Promise<TextDiff[]>
  /** Live run-text textures. */
  stats(): { count: number; pixels: number; workers: number }
}

function exposeProbe(
  renderer: Renderer,
  htmlRaster: (text: unknown) => Promise<Texture>,
  returnHtml: (p: Promise<Texture>) => void,
): void {
  const api: RunTextDebugApi = {
    async compare(options) {
      const { compareTexts } = await import('./fidelityProbe.js')
      return await compareTexts(renderer, htmlRaster, returnHtml, undefined, options)
    },
    stats() {
      const m = runTextureMemory('text')
      return { count: m.count, pixels: m.texturePx, workers: textRasterPool().workers }
    },
  }
  ;(globalThis as { __narrative_runText?: RunTextDebugApi }).__narrative_runText = api
}
