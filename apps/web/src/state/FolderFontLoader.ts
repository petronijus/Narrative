/**
 * state/FolderFontLoader.ts
 *
 * M16 P3 (consolidated): installs folder-scoped custom fonts into
 * document.fonts + Pixi's HTMLText cache, and refreshes any live Text
 * nodes that picked up a fallback face on first paint.
 *
 * This is the single FontLoader after the M16 P3 consolidation — the
 * deck-level FontLoader has been removed.
 *
 * Mounted inside FolderFontsProvider (via DeckShell's FolderDocGate) so
 * it has access to the live folder font list. The CanvasInstance is read
 * from CanvasInstanceContext via a ref so the Pixi-refresh call always
 * sees the current canvas (even if it spins up after fonts have loaded).
 */

import { useEffect, useRef } from 'react'
import { Cache } from 'pixi.js'
import { useFolderFonts } from './useFolderFonts.js'
import { useDeckFontsOptional } from './useDeckFonts.js'
import { useCanvasInstance, type CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import type { FolderFontSummary } from '../api/client.js'

/**
 * Pixi v8's HTMLText pipeline does NOT consult `document.fonts` when
 * embedding @font-face declarations into the SVG it rasterises — it
 * only looks at its own asset Cache under the key `${family}-and-url`
 * (see pixi.js/scene/text-html/utils/getFontCss). Without an entry
 * there, getFontCss returns "" and the SVG falls back to the system
 * font. Register every loaded face in that exact shape so HTMLText
 * picks them up.
 */
interface PixiFontCacheEntry {
  url: string
  faces: { weight: string; style: string }[]
}

function pixiFontCacheKey(family: string): string {
  return `${family}-and-url`
}

function addToPixiFontCache(family: string, url: string, weight: string, style: string): void {
  const key = pixiFontCacheKey(family)
  const existing = Cache.has(key)
    ? (Cache.get(key) as { entries: PixiFontCacheEntry[] })
    : { entries: [] as PixiFontCacheEntry[] }
  let entry = existing.entries.find((e) => e.url === url)
  if (entry === undefined) {
    entry = { url, faces: [] }
    existing.entries.push(entry)
  }
  if (!entry.faces.some((f) => f.weight === weight && f.style === style)) {
    entry.faces.push({ weight, style })
  }
  if (!Cache.has(key)) Cache.set(key, existing)
}

function removeFromPixiFontCache(family: string, weight: string, style: string): void {
  const key = pixiFontCacheKey(family)
  if (!Cache.has(key)) return
  const value = Cache.get(key) as { entries: PixiFontCacheEntry[] }
  for (const entry of value.entries) {
    entry.faces = entry.faces.filter((f) => !(f.weight === weight && f.style === style))
  }
  value.entries = value.entries.filter((e) => e.faces.length > 0)
  if (value.entries.length === 0) Cache.remove(key)
}

interface InstalledFont {
  face: FontFace
  family: string
  weight: string
  style: string
}

/**
 * Renders nothing; installs/removes folder fonts from document.fonts on
 * each change to the folder font list.
 */
export function FolderFontLoader(): null {
  const { fonts: folderFonts } = useFolderFonts()
  // When mounted inside a deck, also pull deck-scoped promoted fonts so
  // they install through the same Pixi cache pipeline. Outside a deck
  // (e.g. folder grid preload), useDeckFontsOptional returns null.
  const deckCtx = useDeckFontsOptional()
  const fonts: FolderFontSummary[] =
    deckCtx === null ? folderFonts : [...folderFonts, ...deckCtx.fonts]
  const canvas = useCanvasInstance()
  const installedRef = useRef<Map<string, InstalledFont>>(new Map())

  // Live ref to the canvas so the async IIFE below always reads the
  // CURRENT instance — without this, the closure captures whatever
  // `canvas` was at scheduling time. On a cold-start reload that's
  // typically null (Pixi hasn't finished `app.init()` yet), so the
  // refresh call after FontFace.load was a silent no-op.
  const canvasRef = useRef<CanvasInstance | null>(canvas)
  canvasRef.current = canvas

  useEffect(() => {
    let cancelled = false
    const installed = installedRef.current
    const live = new Set(fonts.map((f) => f.assetId))

    // Track IDs for which THIS effect invocation reserved a placeholder slot.
    // If cleanup fires before the async load completes (e.g. React 18
    // strict-mode double-invoke), we must delete the placeholder so the
    // next effect invocation can retry — otherwise it sees `installed.has(id)
    // === true` (a stale placeholder with face=undefined), skips the font
    // entirely, and the load that was cancelled never gets retried.
    const pendingIds = new Set<string>()

    // Install new fonts
    for (const font of fonts) {
      if (installed.has(font.assetId)) continue

      // Reserve slot synchronously to prevent double-fetch on rapid re-emits
      installed.set(font.assetId, {
        face: undefined as unknown as FontFace,
        family: font.family,
        weight: String(font.weight),
        style: font.style,
      })
      pendingIds.add(font.assetId)

      void (async () => {
        try {
          const face = new FontFace(font.family, `url(${font.url})`, {
            weight: String(font.weight),
            style: font.style,
            display: 'swap',
          })
          await face.load()
          // If cleanup ran while we were loading, bail without installing.
          // The cleanup will have already deleted the placeholder slot, so
          // the next effect invocation will retry.
          if (cancelled) return

          document.fonts.add(face)
          addToPixiFontCache(font.family, font.url, String(font.weight), font.style)

          // Slot is now fully installed — remove from pending so cleanup
          // does NOT delete it (the face is live and should stay).
          pendingIds.delete(font.assetId)
          installed.set(font.assetId, {
            face,
            family: font.family,
            weight: String(font.weight),
            style: font.style,
          })

          // Cold-start: read canvas via ref so we get whatever is current
          // RIGHT NOW, not the value at IIFE-schedule time.
          canvasRef.current?.sceneGraph.refreshTextNodesUsingFamily(font.family)
        } catch (err) {
          // Drop the placeholder so a future re-emit retries
          installed.delete(font.assetId)
          pendingIds.delete(font.assetId)
          console.warn('[FolderFontLoader] failed to install', font.assetId, err)
        }
      })()
    }

    // Remove fonts no longer in the list
    for (const [id, slot] of installed) {
      if (live.has(id)) continue
      try {
        if (slot.face) document.fonts.delete(slot.face)
      } catch {
        // FontFaceSet.delete throws if face was never fully added — ignore
      }
      removeFromPixiFontCache(slot.family, slot.weight, slot.style)
      installed.delete(id)
      canvasRef.current?.sceneGraph.refreshTextNodesUsingFamily(slot.family)
    }

    return () => {
      cancelled = true
      // Delete placeholder slots for any loads that were in-flight when
      // cleanup fired. Without this, the next effect invocation (e.g. after
      // React 18 strict-mode double-invoke) skips them because
      // `installed.has(id)` is still true, and the cancelled async bails
      // before calling `document.fonts.add()` — leaving the font permanently
      // uninstalled with no error.
      for (const id of pendingIds) {
        installed.delete(id)
      }
      pendingIds.clear()
    }
  }, [fonts])

  // Cold-start catch-up: when the Pixi canvas appears AFTER fonts have
  // already loaded (the typical reload sequence — FontFace.load resolves
  // before app.init does), walk every already-installed family and force
  // a re-rasterise so the text picks up the fallback-vs-installed swap.
  useEffect(() => {
    if (canvas === null) return
    const installed = installedRef.current
    const seen = new Set<string>()
    for (const slot of installed.values()) {
      if (slot.face === undefined) continue
      if (seen.has(slot.family)) continue
      seen.add(slot.family)
      canvas.sceneGraph.refreshTextNodesUsingFamily(slot.family)
    }
  }, [canvas])

  return null
}
