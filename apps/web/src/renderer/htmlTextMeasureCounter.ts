/**
 * renderer/htmlTextMeasureCounter.ts — counts Pixi's HTMLText measurements for
 * the performance harness (docs/plans/perf-harness.md → The counters).
 *
 * Pixi measures an HTMLText's content with `measureHtmlText`
 * (`pixi.js/lib/scene/text-html/utils/measureHtmlText`): an SVG appended to
 * the page for one synchronous layout. It runs from two places — the bounds of
 * a node (`HTMLText.updateBounds`) and each raster (`_buildTexturePromise`,
 * counted in patchHTMLTextRace.ts as `text.raster.started`). The module
 * function is internal to Pixi, so the bounds path is counted here, on the
 * prototype method that calls it: `text.measure.bounds`.
 *
 * With counting off the wrapper is one extra call into perfCount, which
 * returns at once. Installed by importing this module (textRenderer.ts does);
 * idempotent.
 */

import { HTMLText } from 'pixi.js'
import { perfCount } from '@narrative/shared'

const INSTALLED = Symbol.for('narrative.htmlTextMeasureCounter')

export function installHtmlTextMeasureCounter(): void {
  const proto = HTMLText.prototype as unknown as Record<PropertyKey, unknown>
  if (proto[INSTALLED] === true) return
  const original = proto['updateBounds']
  // Unit suites mock pixi.js with a bare HTMLText; there is nothing to count.
  if (typeof original !== 'function') return
  proto['updateBounds'] = function (this: unknown, ...args: unknown[]): unknown {
    perfCount('text.measure.bounds')
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  }
  proto[INSTALLED] = true
}

installHtmlTextMeasureCounter()
