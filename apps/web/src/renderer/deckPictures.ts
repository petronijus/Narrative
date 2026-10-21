/**
 * renderer/deckPictures.ts — every picture a deck's slides draw: image
 * objects, image backgrounds, and image fills (`fillStyle` of a shape, a
 * table's defaults and its cells (`rows`)). The editor prefetches their URLs when a
 * deck opens (Canvas.tsx, one batched request: imageUrl.ts) and present mode
 * preloads them (present/preloadMedia.ts).
 */

import type { ImageObject, Slide, SlideObject } from '@narrative/shared'

export type DeckPicture =
  | { assetId: string; kind: 'object'; object: ImageObject }
  | { assetId: string; kind: 'background' | 'fill' }

function imageFillAsset(fillStyle: unknown): string | null {
  if (typeof fillStyle !== 'object' || fillStyle === null) return null
  const f = fillStyle as { kind?: unknown; assetId?: unknown }
  return f.kind === 'image' && typeof f.assetId === 'string' && f.assetId !== '' ? f.assetId : null
}

/** The pictures of `slides`, in slide order (an asset may appear more than once). */
export function deckPictures(slides: readonly Slide[]): DeckPicture[] {
  const out: DeckPicture[] = []
  const fill = (fillStyle: unknown): void => {
    const assetId = imageFillAsset(fillStyle)
    if (assetId !== null) out.push({ assetId, kind: 'fill' })
  }
  const visit = (o: SlideObject): void => {
    if (o.type === 'image') {
      if (o.assetId !== '') out.push({ assetId: o.assetId, kind: 'object', object: o })
      return
    }
    fill((o as { fillStyle?: unknown }).fillStyle)
    if (o.type === 'table') {
      fill(o.defaults.fillStyle)
      for (const row of o.rows) for (const cell of row) fill(cell.fillStyle)
    }
  }
  for (const s of slides) {
    if (s.background?.kind === 'image' && s.background.assetId !== '')
      out.push({ assetId: s.background.assetId, kind: 'background' })
    for (const o of s.objects) visit(o)
  }
  return out
}

/** Each asset id of `slides`' pictures once. */
export function deckPictureAssetIds(slides: readonly Slide[]): string[] {
  return [...new Set(deckPictures(slides).map((p) => p.assetId))]
}
