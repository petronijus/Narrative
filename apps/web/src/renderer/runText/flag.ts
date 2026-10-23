/**
 * renderer/runText/flag.ts — which engine draws the canvas's text (ADR 0018).
 *
 *   - `html` — Pixi's HTMLText: the markup in an SVG `foreignObject`, the faces
 *     embedded as `data:` URLs, the SVG loaded as an image and uploaded;
 *   - `runs` — the same markup and CSS laid out by the browser in a contained
 *     host of the renderer's, read as glyph runs, painted with Canvas2D in a
 *     worker (`runText/`), uploaded as an exact-size texture.
 *
 * The choice is made once per page, before the first text is measured, and
 * holds for every renderer of the page (the editor, thumbnails, present mode,
 * the render page move together — ADR 0018, decision 5): a text's bounds and
 * its raster come from one engine. Read from, in order:
 *
 *   1. `globalThis.__narrative_textEngine` (e2e specs, `addInitScript`);
 *   2. the page URL's `?textEngine=` parameter;
 *   3. `localStorage['narrative:textEngine']` (a developer's own choice);
 *   4. the build's `VITE_TEXT_ENGINE` (a perf A/B builds one side with it:
 *      `VITE_TEXT_ENGINE=runs just perf-compare HEAD . <ids>`);
 *   5. the default below.
 *
 * Anything else than the two names is ignored.
 */

export type TextEngine = 'html' | 'runs'

/** The engine a page uses when nothing chooses one. */
export const DEFAULT_TEXT_ENGINE: TextEngine = 'html'

export const TEXT_ENGINE_STORAGE_KEY = 'narrative:textEngine'

function parse(value: unknown): TextEngine | undefined {
  return value === 'html' || value === 'runs' ? value : undefined
}

function fromGlobal(): TextEngine | undefined {
  return parse((globalThis as { __narrative_textEngine?: unknown }).__narrative_textEngine)
}

function fromUrl(): TextEngine | undefined {
  if (typeof location === 'undefined') return undefined
  try {
    return parse(new URLSearchParams(location.search).get('textEngine'))
  } catch {
    return undefined
  }
}

function fromStorage(): TextEngine | undefined {
  try {
    return parse(globalThis.localStorage?.getItem(TEXT_ENGINE_STORAGE_KEY))
  } catch {
    // Storage denied (a sandboxed frame, privacy mode): not a choice.
    return undefined
  }
}

function fromBuild(): TextEngine | undefined {
  return parse(import.meta.env.VITE_TEXT_ENGINE)
}

let chosen: TextEngine | undefined

/** The page's text engine (decided on first call, then fixed). */
export function textEngine(): TextEngine {
  if (chosen === undefined) {
    chosen = fromGlobal() ?? fromUrl() ?? fromStorage() ?? fromBuild() ?? DEFAULT_TEXT_ENGINE
  }
  return chosen
}

/** Whether the canvas's text is drawn from glyph runs. */
export function runTextEnabled(): boolean {
  return textEngine() === 'runs'
}

/** Unit tests: choose again on the next call. */
export function _resetTextEngineForTests(next?: TextEngine): void {
  chosen = next
}
