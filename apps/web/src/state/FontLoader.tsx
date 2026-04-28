/**
 * state/FontLoader.tsx
 *
 * P15: bridges the deck's `fonts` Y.Array to the browser's
 * `document.fonts` set + Pixi text re-rasterisation.
 *
 * For every entry in `useDeckFonts()`:
 *   1. Resolve the asset URL via the font-url route.
 *   2. Build a FontFace with the parsed family/weight/style.
 *   3. Await `face.load()` and add to `document.fonts`.
 *   4. Walk the live SceneGraph and refresh any Text node already
 *      using the now-installed family — Pixi cached fallback glyphs
 *      at first paint and won't redraw on its own.
 *
 * On removal (a peer deletes the font):
 *   1. Remove the FontFace from `document.fonts`.
 *   2. Refresh the same Text nodes so they fall back gracefully.
 *
 * Mounted as a side-effect-only component inside SlideDocProvider — it
 * renders nothing.
 */

import { useEffect, useRef } from 'react'
import { useDeckFonts } from './useDeckFonts.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { getDefaultFontUrlResolver } from '../renderer/fontUrl.js'
import { forgetFontReady, notifyFontReady } from '../renderer/fontRegistry.js'

interface InstalledFont {
  face: FontFace
  family: string
}

export function FontLoader(): null {
  const { fonts } = useDeckFonts()
  const canvas = useCanvasInstance()

  // Per-asset state so a deck-fonts re-emit (which fires for any field
  // change, not just adds/removes) doesn't trigger a duplicate fetch.
  const installedRef = useRef<Map<string, InstalledFont>>(new Map())

  useEffect(() => {
    let cancelled = false

    const installed = installedRef.current
    const live = new Set(fonts.map((f) => f.id))

    // Add new fonts.
    for (const entry of fonts) {
      if (installed.has(entry.id)) continue
      // Reserve the slot synchronously so a Y.Doc echo within the
      // same tick doesn't double-fetch.
      installed.set(entry.id, {
        // Sentinel — replaced once load resolves.
        face: undefined as unknown as FontFace,
        family: entry.family,
      })

      void (async () => {
        try {
          const resolver = getDefaultFontUrlResolver()
          const info = await resolver({ assetId: entry.id })
          if (cancelled) return

          const face = new FontFace(entry.family, `url(${info.url})`, {
            weight: String(entry.weight),
            style: entry.style,
            display: 'swap',
          })
          await face.load()
          if (cancelled) return

          document.fonts.add(face)
          installed.set(entry.id, { face, family: entry.family })
          notifyFontReady(entry.family)

          canvas?.sceneGraph.refreshTextNodesUsingFamily(entry.family)
        } catch (err) {
          // Drop the placeholder so a future re-emit retries.
          installed.delete(entry.id)
          console.warn('[FontLoader] failed to install', entry.id, err)
        }
      })()
    }

    // Remove fonts that are no longer in the deck registry.
    for (const [id, slot] of installed) {
      if (live.has(id)) continue
      try {
        if (slot.face) document.fonts.delete(slot.face)
      } catch {
        // FontFaceSet.delete throws if the face wasn't actually added —
        // ignore.
      }
      installed.delete(id)
      // The family may still be served by another asset (e.g. a
      // different weight) — only un-mark "ready" if no live entry
      // declares it.
      const stillUsed = fonts.some((f) => f.family === slot.family)
      if (!stillUsed) forgetFontReady(slot.family)
      canvas?.sceneGraph.refreshTextNodesUsingFamily(slot.family)
    }

    return () => {
      cancelled = true
    }
  }, [fonts, canvas])

  return null
}
