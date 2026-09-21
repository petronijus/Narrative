/**
 * renderer/pixiHtmlTextStyleScope.ts
 *
 * Stops PixiJS text measurement from restyling the whole page.
 *
 * Every `HTMLText` render measures its content by building
 * `<svg><foreignObject><div><style>…</style><div>…</div></div>` and
 * appending it to `document.body` for one synchronous layout
 * (`pixi.js/lib/scene/text-html/utils/measureHtmlText`). The `<style>` it
 * injects comes from `HTMLTextStyle.cssStyle`, and that CSS is written with
 * a bare element selector:
 *
 *     div { color; font-size: 158px; font-family; line-height: 142px;
 *           padding: 8px; max-width: 986px; …; width: 986px }
 *
 * A `<style>` element is document-global whether or not it sits inside a
 * foreignObject, and an unlayered element rule outranks every layered
 * utility class in the app. So for the duration of each measurement every
 * `div` on the page is a 158px heading. The slide panel's rows are divs;
 * their heights change, the list's scrollHeight changes, and when the list
 * is scrolled to its end the browser clamps the position to the new,
 * smaller maximum. The style is removed a moment later and the content
 * comes back — the scroll position does not. Forty-seven thumbnails of a
 * text-heavy deck, one clamp per text object, is the panel "walking back"
 * thousands of pixels while a deck loads, and clicking a slide (which
 * renders its text on the canvas) is the same thing once more.
 *
 * Bisected: with thumbnails drawing empty slides, or every object except
 * text, the list holds its position; with text it walks back 3,216px.
 *
 * The fix scopes the selectors to `foreignObject div`, which matches
 * exactly the same elements inside Pixi's own SVG — measurement and the
 * rasterised result are unchanged — and nothing outside it. Tag rules
 * (`b { … }`, `i { … }`, custom tags) get the same treatment.
 *
 * Installed by importing this module; it patches the prototype once and is
 * idempotent. `textRenderer.ts` imports it, and every HTMLText in the app
 * goes through that renderer.
 */

import { HTMLTextStyle } from 'pixi.js'

const INSTALLED = Symbol.for('narrative.pixiHtmlTextStyleScope')
const SCOPED = Symbol('narrative.scopedCssStyle')

/** Where the scoped rules must live to keep matching Pixi's own markup. */
export const MEASUREMENT_SCOPE = 'foreignObject'

/**
 * Prefix every top-level rule selector with the measurement scope.
 * Pixi emits flat rules only — `sel { decls }` joined by spaces, no
 * nesting, no braces inside declarations — so a selector is whatever
 * precedes each `{` at the start of the string or after a `}`.
 *
 * Pixi's own `div { … }` rule describes the outer container — its
 * `padding` is the room around the text, its `width` the wrap width — but
 * as a bare element rule it also hits every div *inside* the text. Our
 * paragraphs are divs (`<div data-pb>`, one per paragraph), so a padding
 * of 15px meant 30px added to every paragraph and the first line pushed
 * down instead of given room above. That one rule becomes `foreignObject
 * > div`: the container only. Everything the paragraphs need from it
 * (font, colour, line height, letter spacing, alignment, wrapping, stroke
 * and shadow) is inherited CSS, and a block child fills the container's
 * width without being told to. Tag rules (`b`, `i`, custom tags) stay
 * descendant rules, which is what they are.
 */
export function scopeHtmlTextCss(css: string): string {
  return css.replace(
    /(^|\})(\s*)([^{}]+?)\s*\{/g,
    (_m, before: string, ws: string, sel: string) => {
      const scoped = sel
        .split(',')
        .map((s) => s.trim())
        .map((s) => (s === 'div' ? `${MEASUREMENT_SCOPE} > div` : `${MEASUREMENT_SCOPE} ${s}`))
        .join(', ')
      return `${before}${ws}${scoped} {`
    },
  )
}

export function installPixiHtmlTextStyleScope(): void {
  const proto = HTMLTextStyle.prototype as unknown as Record<PropertyKey, unknown>
  if (proto[INSTALLED] === true) return
  const desc = Object.getOwnPropertyDescriptor(HTMLTextStyle.prototype, 'cssStyle')
  if (desc === undefined || typeof desc.get !== 'function') {
    // Unit suites mock `pixi.js` with a bare HTMLTextStyle and have no DOM
    // to leak into; in a real build this means Pixi changed shape and the
    // leak is back. Say so loudly, but an unpatched leak degrades the
    // editor rather than justifying refusing to load it.
    if (import.meta.env.MODE !== 'test') {
      console.error(
        '[pixiHtmlTextStyleScope] HTMLTextStyle.cssStyle is not a getter — Pixi changed shape; ' +
          'the measurement style leak is unpatched',
      )
    }
    return
  }
  const originalGet = desc.get
  Object.defineProperty(HTMLTextStyle.prototype, 'cssStyle', {
    configurable: true,
    enumerable: desc.enumerable ?? false,
    get(this: HTMLTextStyle & Record<symbol, unknown>) {
      const raw = originalGet.call(this) as string
      const cache = this[SCOPED] as { raw: string; scoped: string } | undefined
      if (cache !== undefined && cache.raw === raw) return cache.scoped
      const scoped = scopeHtmlTextCss(raw)
      this[SCOPED] = { raw, scoped }
      return scoped
    },
  })
  proto[INSTALLED] = true
}

installPixiHtmlTextStyleScope()
