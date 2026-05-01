/**
 * state/FolderFontLoader.ts
 *
 * M16 P3: Side-effect component that installs folder-scoped custom fonts
 * into document.fonts + Pixi's HTMLText cache.
 *
 * Mirrors the deck-level FontLoader (state/FontLoader.tsx) but sources
 * its font list from useFolderFonts() instead of useDeckFonts().
 *
 * Mounted inside FolderDocGate > FolderFontsProvider so it has access
 * to the live folder font list.
 *
 * Per-font cache: the installedRef map is keyed by assetId. A font that is
 * already in document.fonts is not re-fetched when the component re-renders.
 *
 * Cache is per component instance (ref), so navigating away destroys it.
 * The module-level cache in useFolderFonts.ts prevents the list re-fetch;
 * FontFace objects themselves are recreated on remount but the browser's
 * own font cache means the bytes aren't re-downloaded.
 */

import { useEffect, useRef } from 'react'
import { Cache } from 'pixi.js'
import { useFolderFonts } from './useFolderFonts.js'

// Reuse the same Pixi cache helpers as FontLoader — copy the shape
// so we don't create an unnecessary dependency on FontLoader internals.

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
  const { fonts } = useFolderFonts()
  const installedRef = useRef<Map<string, InstalledFont>>(new Map())

  useEffect(() => {
    let cancelled = false
    const installed = installedRef.current
    const live = new Set(fonts.map((f) => f.assetId))

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

      void (async () => {
        try {
          const face = new FontFace(font.family, `url(${font.url})`, {
            weight: String(font.weight),
            style: font.style,
            display: 'swap',
          })
          await face.load()
          if (cancelled) return

          document.fonts.add(face)
          addToPixiFontCache(font.family, font.url, String(font.weight), font.style)

          installed.set(font.assetId, {
            face,
            family: font.family,
            weight: String(font.weight),
            style: font.style,
          })
        } catch (err) {
          // Drop the placeholder so a future re-emit retries
          installed.delete(font.assetId)
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
    }

    return () => {
      cancelled = true
    }
  }, [fonts])

  return null
}
