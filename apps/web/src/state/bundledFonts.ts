/**
 * state/bundledFonts.ts
 *
 * Bundle a small set of webfonts that the app's "system" font picker
 * advertises but that aren't necessarily installed on the user's OS.
 * Inter is the canonical case: when the OS doesn't have Inter the DOM
 * textarea silently falls back to system-ui (different metrics), and
 * Pixi v8 HTMLText — which rasterises an SVG that can ONLY see fonts
 * either embedded in the SVG or accessible to the SVG-img subsystem
 * — falls back to its own generic, producing yet a third set of
 * metrics. The combined effect: caret in the textarea no longer
 * lines up with rendered glyphs (visible only on Inter; the other
 * "system" entries map to OS-native faces both DOM and Pixi can see).
 *
 * Fix: ship Inter as a self-hosted webfont, register it both in
 * `document.fonts` (so the DOM textarea uses it) AND as HTMLText faces
 * (renderer/fontChanges.ts, which hands them to Pixi once the renderer
 * loads), from the same downloaded bytes. With both layers seeing the SAME
 * glyph file, metrics match and the caret lands where the user expects.
 * Registered as faces like a folder font's, a text embeds only the file it
 * draws with: upright text no longer carries the italic file (~70 kB of
 * base64 per raster; docs/plans/performance.md → E2).
 */

import { setHtmlTextFace } from '../renderer/fontChanges.js'
// `?url` returns the public URL to the asset Vite emits at build time.
import interLatinNormalUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import interLatinItalicUrl from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?url'

let registered = false

export async function registerBundledFonts(): Promise<void> {
  if (registered) return
  registered = true
  if (typeof document === 'undefined') return

  const family = 'Inter'

  // Variable fonts cover the full 100..900 weight axis from one file,
  // so a single face per style is enough. One download per file: the
  // FontFace and the HTMLText face are made from the same bytes (a FontFace
  // from bytes is no fetch, so font-src does not apply; the download is the
  // app's own static file, connect-src 'self').
  const files = [
    { url: interLatinNormalUrl, style: 'normal' },
    { url: interLatinItalicUrl, style: 'italic' },
  ] as const
  let loaded: { style: 'normal' | 'italic'; bytes: ArrayBuffer; face: FontFace }[]
  try {
    loaded = await Promise.all(
      files.map(async ({ url, style }) => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
        const bytes = await response.arrayBuffer()
        const face = new FontFace(family, bytes, { weight: '100 900', style, display: 'swap' })
        await face.load()
        return { style, bytes, face }
      }),
    )
  } catch (err) {
    console.warn('[bundledFonts] Inter load failed', err)
    return
  }
  for (const { face } of loaded) document.fonts.add(face)

  // Pixi gets the faces through the font registry once the renderer loads
  // (renderer/pixiFontSink.ts): importing Pixi here put its vendor chunk on
  // every route, login included. Registering announces the family: text
  // that rasterised before the faces landed is redrawn on every canvas
  // (renderer/fontChanges.ts); a canvas created later finds them.
  for (const { style, bytes } of loaded) {
    setHtmlTextFace({ key: `bundled:inter:${style}`, family, weight: '100 900', style, bytes })
  }
}
