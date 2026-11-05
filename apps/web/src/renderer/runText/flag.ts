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
 *   5. the default below (`runs`).
 *
 * Anything else than the two names is ignored.
 */

export type TextEngine = 'html' | 'runs'

/**
 * The engine a page uses when nothing chooses one: glyph runs, in Blink and
 * WebKit alike (Petr, 2026-10-26, ADR 0018 → Decision). WebKit paints its
 * HTML glyphs larger than ~180 device px a little heavier than canvas glyphs
 * (ADR 0018 → The residue; the lighter non-black text seen before was WebKit
 * uploading bitmaps unpremultiplied, fixed) — accepted; where the text sits
 * is the same as in edit mode, and that is what is gated.
 */
export const DEFAULT_TEXT_ENGINE: TextEngine = 'runs'

function defaultEngine(): TextEngine {
  return DEFAULT_TEXT_ENGINE
}

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
    chosen = fromGlobal() ?? fromUrl() ?? fromStorage() ?? fromBuild() ?? defaultEngine()
  }
  return chosen
}

/** Whether the canvas's text is drawn from glyph runs. */
export function runTextEnabled(): boolean {
  return textEngine() === 'runs'
}

/** Unit tests: choose again on the next call. */
export function _resetTextEngineForTests(next?: TextEngine): void {
  compatible = undefined
  chosen = next
}

/**
 * Whether the run engine draws as HTMLText did rather than where the page
 * puts text (`globalThis.__narrative_textHtmlTextCompatible = true`, e2e
 * only): no placement on the device grid (placement.ts) and the content
 * height rounded as Pixi measures it (readRuns.ts). For
 * e2e/text-runs-artboard.spec.ts, which holds the painter to HTMLText's
 * pixels; nothing a user does reaches it.
 */
export function htmlTextCompatible(): boolean {
  // Read once: set before the page loads, asked on every rendered frame.
  compatible ??=
    (globalThis as { __narrative_textHtmlTextCompatible?: unknown })
      .__narrative_textHtmlTextCompatible === true
  return compatible
}

let compatible: boolean | undefined

/**
 * Whether a first raster waits for a face still on its way (fontChanges.ts →
 * whenFamiliesSettled). On, but in a build made with
 * `VITE_TEXT_FACE_HOLD=off` — one side of a perf A/B measuring what the wait
 * costs (present.advance.text).
 */
export function faceHoldEnabled(): boolean {
  return import.meta.env.VITE_TEXT_FACE_HOLD !== 'off'
}
