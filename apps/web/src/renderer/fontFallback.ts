/**
 * renderer/fontFallback.ts
 *
 * Best-effort font-category fallback.
 *
 * Why: imported decks (notably PPTX) often reference fonts that aren't
 * installed locally — "Northwind Sans ST Pro 36 Bold", "Druk Wide",
 * "Asterisk Sans Variable Black", "Montserrat Light", "Calibri", and
 * so on. Without an explicit fallback, the browser drops to its
 * default generic family, which on every platform we ship to ends up
 * being a **serif** (Times-ish). That makes every modern brand deck
 * look wrong on first open: bold sans-serif titles render as
 * Times-italic.
 *
 * What this does: detect the visual category of a font name from
 * well-known substrings (sans / serif / monospace) and append a
 * platform-native CSS generic stack so the browser's fallback path
 * lands somewhere in the same family. No new fonts are loaded — just
 * a smarter CSS string.
 *
 * Defaults to **sans-serif** when we can't recognise the name. Modern
 * decks are overwhelmingly sans, and a sans fallback for an actual
 * serif title is still a better look than the inverse (a Times-ish
 * fallback for a modern sans display face reads as a bug).
 *
 * Calling this is a one-way transform. Once you've appended a stack,
 * don't run it again — `withFontFallback("Inter, sans-serif")` is a
 * no-op because the comma triggers the pass-through branch.
 */

import { quoteCssFamilyName } from '@narrative/slide-model'

/** Sans fallback. Pixi v8 HTMLText renders into an SVG `<foreignObject>`
 *  where some platform-conditional fonts (system-ui, ui-monospace) don't
 *  always resolve, so we lead with concrete families that always exist
 *  on every browser baseline (Arial, Helvetica) before the generic. */
const SANS_STACK = 'Arial, Helvetica, "Helvetica Neue", "Segoe UI", Roboto, sans-serif'

/** Serif fallback. Same reasoning — Times / Georgia ship everywhere. */
const SERIF_STACK = 'Georgia, "Times New Roman", Times, Cambria, serif'

/** Monospace fallback. */
const MONO_STACK = 'Menlo, Consolas, "Courier New", Courier, monospace'

/**
 * Substring patterns (case-insensitive) that strongly suggest a font's
 * visual category. Ordered most-specific → most-generic so the first
 * match wins.
 */
const SERIF_PATTERNS = [
  'serif',
  'times',
  'garamond',
  'georgia',
  'caslon',
  'bodoni',
  'didot',
  'baskerville',
  'palatino',
  'minion',
  'cambria',
  'book antiqua',
  'goudy',
  'sabon',
  'mrs eaves',
  'cardo',
  'lora',
  'merriweather',
  'pt serif',
  'libre baskerville',
  'playfair',
  'crimson',
  'newsreader',
  'source serif',
]

const MONO_PATTERNS = [
  'mono',
  'courier',
  'consolas',
  'menlo',
  'monaco',
  'fira code',
  'jetbrains',
  'source code',
  'ibm plex mono',
]

const SANS_PATTERNS = [
  'sans',
  'grotesk',
  'gothic',
  'helvetica',
  'arial',
  'inter',
  'roboto',
  'druk',
  'montserrat',
  'calibri',
  'segoe',
  'tahoma',
  'verdana',
  'futura',
  'avenir',
  'gill',
  'optima',
  'din',
  'lato',
  'work sans',
  'open sans',
  'asterisk',
  'midnight',
  'space grotesk',
  'manrope',
  'poppins',
  'nunito',
  'rubik',
  'barlow',
]

/**
 * Categorise a single family name. Returns the CSS generic that best
 * matches the font's visual character, or undefined when we can't tell.
 */
export function categoriseFont(family: string): 'sans-serif' | 'serif' | 'monospace' | undefined {
  const lower = family.toLowerCase()
  for (const p of SERIF_PATTERNS) if (lower.includes(p)) return 'serif'
  for (const p of MONO_PATTERNS) if (lower.includes(p)) return 'monospace'
  for (const p of SANS_PATTERNS) if (lower.includes(p)) return 'sans-serif'
  return undefined
}

/**
 * Append a category-appropriate CSS generic stack to a font-family
 * value, leaving the original family in front so it still wins when
 * installed. No-op when the input already contains a comma (caller
 * has already supplied their own stack).
 *
 * @example
 *   withFontFallback('Northwind Sans ST Pro 36 Bold')
 *   // → 'Northwind Sans ST Pro 36 Bold, system-ui, -apple-system, …'
 *
 *   withFontFallback('Georgia')  // already serif-known
 *   // → 'Georgia, Georgia, Cambria, "Times New Roman", Times, serif'
 *
 *   withFontFallback('Custom, sans-serif')  // already has a stack
 *   // → 'Custom, sans-serif'
 */
export function withFontFallback(family: string | undefined): string | undefined {
  if (family === undefined) return undefined
  const trimmed = family.trim()
  if (trimmed === '') return undefined
  // Caller already authored a stack — don't append a second one.
  if (trimmed.includes(',')) return trimmed
  return `${trimmed}, ${categoryStackFor(trimmed)}`
}

/**
 * Same fallback policy as `withFontFallback`, but expressed as an array
 * of family entries (each comma-split element of the resulting CSS
 * stack, in priority order). Useful for Pixi v8's HTMLText, where
 * `style.fontFamily` is an array and each entry becomes a separate
 * `@font-face` embed candidate via `extractFontFamilies`. The generic
 * fallback entries fail to embed (they're not real fonts) but they
 * still end up in the resulting CSS `font-family` list, which is
 * exactly what we want.
 */
export function fontFallbackArray(family: string | undefined): string[] {
  if (family === undefined) return []
  const trimmed = family.trim()
  if (trimmed === '') return []
  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return [
    trimmed,
    ...categoryStackFor(trimmed)
      .split(',')
      .map((s) => s.trim()),
  ]
}

/**
 * Build a CSS-safe `font-family` value: wrap multi-word non-generic
 * family names in double quotes per the CSS Font spec, then join with
 * commas. Pixi v8's HTMLText path embeds `style.fontFamily` directly
 * into the SVG's CSS via raw template literal (no auto-quoting), so
 * an unquoted PPTX face like `Northwind Sans ST Pro 36 Regular` would
 * break the parser at the digit run "36" and the browser would drop
 * to its default serif. Quoting fixes that.
 *
 * @example
 *   cssFontFamily('Northwind Sans ST Pro 36 Regular')
 *   // → '"Northwind Sans ST Pro 36 Regular", Arial, Helvetica, …, sans-serif'
 */
export function cssFontFamily(family: string | undefined): string | undefined {
  if (family === undefined) return undefined
  const trimmed = family.trim()
  if (trimmed === '') return undefined
  const entries = trimmed.includes(',')
    ? trimmed
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [
        trimmed,
        ...categoryStackFor(trimmed)
          .split(',')
          .map((s) => s.trim()),
      ]
  return entries.map((entry) => quoteCssFamilyName(entry)).join(', ')
}

function categoryStackFor(family: string): string {
  const category = categoriseFont(family) ?? 'sans-serif'
  return category === 'serif' ? SERIF_STACK : category === 'monospace' ? MONO_STACK : SANS_STACK
}
