/**
 * renderer/runText/textRasterWorker.ts — a text raster worker (ADR 0018):
 * paints glyph-run layouts with Canvas2D on an OffscreenCanvas and hands the
 * pixels back as an `ImageBitmap` (transferred, no copy).
 *
 * Fonts: the page posts each registered face's bytes and descriptors; the
 * worker adds a `FontFace` made from them to its own `FontFaceSet`
 * (`self.fonts`), so a family's faces are matched by the engine's own CSS
 * Fonts 4 §5.2 algorithm — the faces and descriptors the page's document has,
 * the same pick. A FontFace made from bytes is no fetch: `font-src` does not
 * apply (ADR 0007); the worker itself is a same-origin module script
 * (`worker-src 'self'`).
 *
 * A paint waits for every face posted before it to have loaded (`faces`
 * below is a chain): the first raster in a face is never drawn before the
 * face is there — the WebKit failure of HTMLText that drew some texts in an
 * embedded face as nothing (performance.md → E7) has no counterpart here.
 *
 * Names: a family's faces are registered under an alias that changes with
 * every change to the family's faces, and each paint's font strings are
 * rewritten to it (fontAliases.ts): the worker's canvas keeps what a font
 * string resolved to the first time it was used, so a face added after a
 * text in its family was painted with the fallback would otherwise never be
 * drawn in that font string.
 */

import { aliasName, rewriteFontFamilies } from './fontAliases.js'
import type { TextRunLayout } from './glyphRuns.js'
import { offscreenScratch, paintRuns, type PaintSupport } from './paintRuns.js'
import type { FromWorker, PaintMessage, ToWorker } from './protocol.js'

interface WorkerScope {
  fonts?: { add(face: FontFace): void; delete(face: FontFace): boolean }
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope

const canPaint =
  typeof OffscreenCanvas === 'function' && new OffscreenCanvas(1, 1).getContext('2d') !== null
const fonts = scope.fonts !== undefined && typeof FontFace === 'function'

/** The scratch canvas underline ink skipping draws its masks into (one per worker). */
const support: PaintSupport | null = canPaint ? { scratch: offscreenScratch() } : null

/** Every face posted, by the page's key: its family, descriptors and bytes. */
const posted = new Map<
  string,
  { family: string; bytes: ArrayBuffer; descriptors: FontFaceDescriptors }
>()
/** Each family with faces: the alias they are registered under now, and those FontFaces. */
const aliases = new Map<string, { alias: string; faces: FontFace[] }>()
let generation = 0
/** Families whose re-registration is queued and has not started. */
const realiasQueued = new Set<string>()
/** Settles when every face posted so far has loaded (or failed). */
let faces: Promise<void> = Promise.resolve()

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer)
}

/** Register `family`'s posted faces again under a fresh alias, and drop the previous ones. */
function realias(family: string): void {
  // Faces of one family arrive one message each: one registration for all
  // that came before it ran.
  if (realiasQueued.has(family)) return
  realiasQueued.add(family)
  faces = faces.then(async () => {
    realiasQueued.delete(family)
    if (!fonts) return
    const previous = aliases.get(family)
    const keys = [...posted].filter(([, f]) => f.family === family)
    const alias = aliasName(++generation)
    const made: FontFace[] = []
    for (const [key, f] of keys) {
      try {
        // A copy: the posted bytes stay for the next alias.
        const face = new FontFace(alias, f.bytes.slice(0), f.descriptors)
        await face.load()
        scope.fonts!.add(face)
        made.push(face)
      } catch (err) {
        post({ type: 'faceFailed', key, message: String(err) })
      }
    }
    if (made.length > 0) aliases.set(family, { alias, faces: made })
    else aliases.delete(family)
    for (const face of previous?.faces ?? []) scope.fonts!.delete(face)
  })
}

function addFace(msg: Extract<ToWorker, { type: 'face' }>): void {
  const before = posted.get(msg.key)
  posted.set(msg.key, {
    family: msg.family,
    bytes: msg.bytes,
    descriptors: { weight: msg.weight, style: msg.style, stretch: msg.stretch },
  })
  if (before !== undefined && before.family !== msg.family) realias(before.family)
  realias(msg.family)
}

function dropFace(key: string): void {
  const before = posted.get(key)
  if (before === undefined) return
  posted.delete(key)
  realias(before.family)
}

/** `layout` with every font string naming its families' current aliases. */
function aliased(layout: TextRunLayout): TextRunLayout {
  if (aliases.size === 0) return layout
  const alias = (family: string): string | undefined => aliases.get(family)?.alias
  return {
    ...layout,
    runs: layout.runs.map((r) => ({ ...r, font: rewriteFontFamilies(r.font, alias) })),
    decorations: layout.decorations.map((d) => ({
      ...d,
      font: rewriteFontFamilies(d.font, alias),
    })),
  }
}

function paint(msg: PaintMessage): void {
  void faces.then(() => {
    const t0 = performance.now()
    try {
      const canvas = new OffscreenCanvas(Math.max(1, msg.width), Math.max(1, msg.height))
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('no 2d context')
      paintRuns(ctx, aliased(msg.layout), msg.resolution, msg.rules, support ?? undefined)
      const bitmap = canvas.transferToImageBitmap()
      post({ type: 'painted', id: msg.id, bitmap, ms: performance.now() - t0 }, [bitmap])
    } catch (err) {
      post({ type: 'paintFailed', id: msg.id, message: String(err) })
    }
  })
}

scope.onmessage = (e: MessageEvent<ToWorker>): void => {
  const msg = e.data
  switch (msg.type) {
    case 'face':
      addFace(msg)
      return
    case 'dropFace':
      dropFace(msg.key)
      return
    case 'paint':
      paint(msg)
      return
  }
}

post({ type: 'ready', canPaint, fonts })
