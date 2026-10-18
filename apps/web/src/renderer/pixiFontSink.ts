/**
 * renderer/pixiFontSink.ts — Pixi's half of `./fontChanges.ts`.
 *
 * The font registry does not import Pixi, so registering a font (the app's
 * boot registers the bundled Inter, the folder pages their folder fonts)
 * does not put the renderer's vendor chunk on that route
 * (docs/plans/performance.md → L1). This module writes the registry's state
 * into Pixi's asset `Cache` and `FontStylePromiseCache`, which HTMLText reads
 * when it rasterises. Imported for its effect by the text renderer
 * (`objectRenderers/textRenderer.ts`), so it is installed before any HTMLText
 * exists; the registry hands it everything registered until then.
 */

import { Cache, FontStylePromiseCache } from 'pixi.js'
import { installHtmlTextFontSink } from './fontChanges.js'

const entriesKey = (family: string): string => `${family}-and-url`

installHtmlTextFontSink({
  setEntries(family, entries) {
    Cache.set(entriesKey(family), {
      entries: entries.map((entry) => ({
        url: entry.url,
        faces: entry.faces.map((f) => ({ ...f })),
      })),
    })
  },
  hasEntries: (family) => Cache.has(entriesKey(family)),
  removeEntries(family) {
    Cache.remove(entriesKey(family))
  },
  setCss(family, css) {
    FontStylePromiseCache.set(family, Promise.resolve(css))
  },
  dropCss(family) {
    FontStylePromiseCache.delete(family)
  },
})
