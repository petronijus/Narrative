/**
 * state/FolderFontLoader.ts
 *
 * M16 P3 (consolidated): installs folder-scoped custom fonts into
 * document.fonts and registers their bytes as HTMLText faces
 * (renderer/fontChanges.ts), which redraws any live text that painted in
 * a fallback face first.
 *
 * This is the single FontLoader after the M16 P3 consolidation — the
 * deck-level FontLoader has been removed.
 *
 * Mounted inside FolderFontsProvider (via DeckShell's FolderDocGate) so
 * it has access to the live folder font list. It sits above the canvas, so
 * it reaches no canvas itself: each installed or removed face is announced
 * (renderer/fontChanges.ts) and every SceneGraph redraws its text in that
 * family. A canvas created later needs nothing — its text finds the face in
 * Pixi's cache when it first rasterises.
 */

import { trackRenderWork } from '../renderer/renderWork.js'
import { useEffect, useRef, useCallback } from 'react'
import { useFolderFonts } from './useFolderFonts.js'
import { useDeckFontsOptional } from './useDeckFonts.js'
import { removeHtmlTextFace, setHtmlTextFace } from '../renderer/fontChanges.js'
import type { FolderFontSummary } from '../api/client.js'
import {
  readFontVerticalMetrics,
  powerpointDescentRatio,
  powerpointLineHeightRatio,
} from '../lib/fontFileMetrics.js'
import { registerDeclaredLineMetrics } from '../lib/fontLineMetrics.js'

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
  const { fonts: folderFonts, refresh: refreshFolderFonts } = useFolderFonts()
  // When mounted inside a deck, also pull deck-scoped promoted fonts so
  // they install through the same Pixi cache pipeline. Outside a deck
  // (e.g. folder grid preload), useDeckFontsOptional returns null.
  const deckCtx = useDeckFontsOptional()
  const fonts: FolderFontSummary[] =
    deckCtx === null ? folderFonts : [...folderFonts, ...deckCtx.fonts]
  const installedRef = useRef<Map<string, InstalledFont>>(new Map())

  // MEDIA-1: font `url`s are short-TTL presigned MinIO URLs. If a FontFace
  // load fails (most likely an expired URL on a deck left open > the URL TTL
  // before first paint), re-list the folder fonts ONCE to obtain freshly
  // presigned URLs, which re-triggers this effect with valid URLs. Throttled
  // so a genuinely broken font file can't spin a refresh loop.
  const refreshRef = useRef(refreshFolderFonts)
  refreshRef.current = refreshFolderFonts
  const lastRefreshAtRef = useRef(0)
  const requestUrlRefresh = useCallback((): void => {
    const now = Date.now()
    // At most one refresh per 30 s — comfortably below the 1 h URL TTL and
    // the 5 min list cache TTL, but enough to stop a tight retry loop.
    if (now - lastRefreshAtRef.current < 30_000) return
    lastRefreshAtRef.current = now
    void refreshRef.current().catch(() => undefined)
  }, [])

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

      // Counted until it settles, so the render page waits for the folder's
      // fonts before it measures or paints text (renderer/renderWork.ts).
      void trackRenderWork(
        (async () => {
          try {
            // Fetch the bytes ourselves rather than handing the URL to
            // FontFace: the same download then also yields the file's own
            // vertical metrics, which the line-height resolver needs because
            // no browser API exposes them for a font that sets
            // USE_TYPO_METRICS (see lib/fontFileMetrics.ts).
            const response = await fetch(font.url)
            if (!response.ok) throw new Error(`font download failed: HTTP ${response.status}`)
            const bytes = await response.arrayBuffer()
            const face = new FontFace(font.family, bytes, {
              weight: String(font.weight),
              style: font.style,
              display: 'swap',
            })
            await face.load()
            const metrics = await readFontVerticalMetrics(bytes)
            if (metrics !== null) {
              registerDeclaredLineMetrics(font.family, font.weight, font.style, {
                lineHeight: powerpointLineHeightRatio(metrics),
                descent: powerpointDescentRatio(metrics),
              })
            }
            // If cleanup ran while we were loading, bail without installing.
            // The cleanup will have already deleted the placeholder slot, so
            // the next effect invocation will retry.
            if (cancelled) return

            document.fonts.add(face)

            // Slot is now fully installed — remove from pending so cleanup
            // does NOT delete it (the face is live and should stay).
            pendingIds.delete(font.assetId)
            installed.set(font.assetId, {
              face,
              family: font.family,
              weight: String(font.weight),
              style: font.style,
            })

            // HTMLText draws with the face from these bytes, and every
            // canvas redraws its text in this family (renderer/fontChanges.ts:
            // announced as tracked render work, so the render page's settle
            // loop waits for the redraw too).
            setHtmlTextFace({
              key: font.assetId,
              family: font.family,
              weight: String(font.weight),
              style: font.style,
              bytes,
            })
          } catch (err) {
            // Drop the placeholder so a future re-emit retries
            installed.delete(font.assetId)
            pendingIds.delete(font.assetId)
            console.warn('[FolderFontLoader] failed to install', font.assetId, err)
            // MEDIA-1: likely an expired presigned URL — pull a fresh list so
            // the next effect run loads with a valid URL.
            requestUrlRefresh()
            // Reported as a failed face (the render page names its family);
            // the retry's success clears it.
            throw err
          }
        })(),
        { font: { key: font.assetId, family: font.family } },
      )
    }

    // Remove fonts no longer in the list
    for (const [id, slot] of installed) {
      if (live.has(id)) continue
      try {
        if (slot.face) document.fonts.delete(slot.face)
      } catch {
        // FontFaceSet.delete throws if face was never fully added — ignore
      }
      removeHtmlTextFace(id)
      installed.delete(id)
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

  return null
}
