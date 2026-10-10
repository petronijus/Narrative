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
 * `document.fonts` (so the DOM textarea uses it) AND in Pixi's Cache
 * under `${family}-and-url` (so HTMLText.getFontCss embeds it into
 * the SVG). With both layers seeing the SAME glyph file, metrics
 * match and the caret lands where the user expects.
 */

import { Cache } from 'pixi.js'
import { announceFontFamilyChanged } from '../renderer/fontChanges.js'
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
  // so a single FontFace per style is enough.
  const normal = new FontFace(family, `url(${interLatinNormalUrl})`, {
    weight: '100 900',
    style: 'normal',
    display: 'swap',
  })
  const italic = new FontFace(family, `url(${interLatinItalicUrl})`, {
    weight: '100 900',
    style: 'italic',
    display: 'swap',
  })
  try {
    await Promise.all([normal.load(), italic.load()])
    document.fonts.add(normal)
    document.fonts.add(italic)
  } catch (err) {
    console.warn('[bundledFonts] Inter load failed', err)
    return
  }

  Cache.set(`${family}-and-url`, {
    entries: [
      { url: interLatinNormalUrl, faces: [{ weight: '100 900', style: 'normal' }] },
      { url: interLatinItalicUrl, faces: [{ weight: '100 900', style: 'italic' }] },
    ],
  })

  // Text that rasterised before the face and its Cache entry landed shows
  // the fallback: every canvas redraws its Inter text now
  // (renderer/fontChanges.ts); a canvas created later finds the entry.
  announceFontFamilyChanged(family)
}
