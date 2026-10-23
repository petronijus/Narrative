/**
 * renderer/runText/layoutCache.ts — one layout per text, many paints
 * (ADR 0018, decision 2).
 *
 * A text's glyph runs are kept by what its layout depends on: the markup, the
 * style's CSS (padding, wrap width and every typographic field are in it) and
 * the page's face generation (`htmlTextMeasureGeneration`, bumped when a face
 * is installed or removed and when webfonts finish loading). The node's bounds
 * (the measurer below), its raster, a zoom's repaint, a thumbnail's and a
 * present-mode scene's all take the same entry: the DOM is laid out once.
 *
 * The `<!--n:uid-->` comment every node's markup starts with (textRenderer
 * `buildHtmlForNode`, keeping Pixi's texture cache per node) is not part of
 * the key: it does not lay out, and two nodes with the same text — component
 * instances, a thumbnail's copy of a slide — share one layout.
 */

import { perfCount } from '@narrative/shared'
import { htmlTextMeasureGeneration, type MeasurableText } from '../htmlTextBoundsMemo.js'
import type { TextRunLayout } from './glyphRuns.js'
import type { PaintRules } from './protocol.js'
import { readRuns, type ReadRunsOptions, type RunStyleSource } from './readRuns.js'

/** How many layouts are kept (least recently used dropped first). */
export const LAYOUT_CACHE_LIMIT = 2048

const cache = new Map<string, TextRunLayout>()
let cacheGeneration = -1

const NODE_PREFIX = /^<!--n:\d+-->/u

/** The engine's layout rules, decided once (the page's engine does not change). */
interface EngineRules {
  read: Omit<ReadRunsOptions, 'generation'>
  paint: PaintRules
}

let rules: EngineRules | null = null

/** The page's layout engine: Blink, WebKit (Safari, WKWebView — the Tauri shell —, WebKitGTK) or another. */
export function layoutEngine(): 'blink' | 'webkit' | 'other' {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent
  if (/Chrome\/|Chromium\/|Edg\//u.test(ua)) return 'blink'
  if (/AppleWebKit/u.test(ua) && !/Gecko\/\d/u.test(ua)) return 'webkit'
  return 'other'
}

/** Whether this page's engine is WebKit. */
export function isWebKitEngine(): boolean {
  return layoutEngine() === 'webkit'
}

function canvasCaps(): ReadRunsOptions['canvas'] {
  const proto =
    typeof OffscreenCanvasRenderingContext2D === 'function'
      ? OffscreenCanvasRenderingContext2D.prototype
      : typeof CanvasRenderingContext2D === 'function'
        ? CanvasRenderingContext2D.prototype
        : undefined
  return {
    letterSpacing: proto !== undefined && 'letterSpacing' in proto,
    fontStretch: proto !== undefined && 'fontStretch' in proto,
  }
}

/** The rules of this page's engine. */
export function engineRules(): EngineRules {
  if (rules === null) {
    const engine = layoutEngine()
    const webkit = engine === 'webkit'
    rules = {
      // WebKit's layout and canvas agree across spaces, and its range rects
      // are snapped: word positions would only move its words.
      read: {
        wordsAtSpaces: !webkit,
        canvas: canvasCaps(),
        // Underlines follow Blink's or WebKit's rules (decorations.ts); another
        // engine's are not known: its decorated texts stay HTMLText.
        decorations: engine !== 'other',
      },
      paint: {
        snapBaseline: true,
        decorations: webkit ? 'webkit' : 'chromium',
        strokeMiterLimit: webkit ? 10 : 4,
      },
    }
  }
  return rules
}

/** Unit tests: decide the rules again. */
export function _resetEngineRulesForTests(): void {
  rules = null
}

function keyOf(markup: string, css: string): string {
  // The CSS's length keeps the key unambiguous: the markup follows it, whole.
  return `${css.length}|${css}|${markup.replace(NODE_PREFIX, '')}`
}

/** The layout of `markup` styled by `style` (laid out now unless kept). */
export function runLayoutFor(markup: string, style: RunStyleSource): TextRunLayout {
  const generation = htmlTextMeasureGeneration()
  if (generation !== cacheGeneration) {
    cache.clear()
    cacheGeneration = generation
  }
  const key = keyOf(markup, style.cssStyle)
  const known = cache.get(key)
  if (known !== undefined && known.padding === style.padding) {
    // Most recently used last.
    cache.delete(key)
    cache.set(key, known)
    return known
  }
  perfCount('text.layout')
  const layout = readRuns(markup, style, { ...engineRules().read, generation })
  if (layout.unsupported !== undefined) perfCount(`text.layout.unsupported.${layout.unsupported}`)
  cache.set(key, layout)
  if (cache.size > LAYOUT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return layout
}

/** The bounds measurer of the run-text engine (htmlTextBoundsMemo `setHtmlTextMeasurer`). */
export function measureWithRunLayout(text: MeasurableText): { width: number; height: number } {
  perfCount('text.measure.bounds')
  const layout = runLayoutFor(text.text, text._style)
  return { width: layout.width, height: layout.height }
}

/** Forget every layout (tests). */
export function _clearRunLayoutsForTests(): void {
  cache.clear()
  cacheGeneration = -1
}
