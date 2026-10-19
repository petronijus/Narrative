/**
 * renderer/pixiFontSink.ts — Pixi's half of `./fontChanges.ts`.
 *
 * The font registry does not import Pixi, so registering a font (the app's
 * boot registers the bundled Inter, the folder pages their folder fonts)
 * does not put the renderer's vendor chunk on that route
 * (docs/plans/performance.md → L1). This module writes the registry's state
 * into Pixi's asset `Cache` and `FontStylePromiseCache`, which HTMLText reads
 * when it rasterises: one entry per key of `htmlTextFontKeys` (some faces of
 * one family). Imported for its effect by the text renderer
 * (`objectRenderers/textRenderer.ts`), so it is installed before any HTMLText
 * exists; the registry hands it everything registered until then.
 */

import { Cache, FontStylePromiseCache } from 'pixi.js'
import { installHtmlTextFontSink } from './fontChanges.js'

const entriesKey = (key: string): string => `${key}-and-url`

installHtmlTextFontSink({
  setCss(key, css) {
    // Pixi embeds a name only if its asset Cache has this entry; the CSS it
    // embeds is the promise below, so the entry lists no URLs to download.
    if (!Cache.has(entriesKey(key))) Cache.set(entriesKey(key), { entries: [] })
    FontStylePromiseCache.set(key, Promise.resolve(css))
  },
  dropCss(key) {
    FontStylePromiseCache.delete(key)
    if (Cache.has(entriesKey(key))) Cache.remove(entriesKey(key))
  },
})
