/**
 * cssFontFamily.ts — one font family name as a CSS `font-family` entry.
 *
 * Shared by the two places that write family names into CSS: the rich-text
 * HTML of a text run (`toHtml`, an inline `style="font-family:…"`) and the
 * text renderer's box rule (apps/web/src/renderer/fontFallback.ts, inside the
 * HTMLText SVG's <style>). A family that is not a plain CSS identifier must
 * be a CSS string — `Northwind Sans ST Pro 36 Regular` unquoted breaks at the
 * digits and the browser drops the whole declaration — while the generic
 * families (`serif`, `sans-serif`, …) must stay bare to keep their meaning.
 */

/** CSS generic families and CSS-wide keywords: never quoted. */
export const CSS_GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  'inherit',
  'initial',
  'unset',
])

/**
 * `raw` as one `font-family` entry: bare when it is a generic family or a
 * plain identifier, otherwise a CSS string in `quote` (`"` inside a <style>
 * element, `'` inside a double-quoted style attribute). A name that arrives
 * quoted is unquoted first and quoted again: its quotes are not trusted to be
 * balanced, and a quoted generic stays a quoted name. Backslashes and the
 * quote character are escaped, and control characters (line breaks
 * included), `<`, `>` and `&` written as hex escapes, so the result cannot
 * end the string, the declaration, the attribute — or, inside a `<style>`
 * element set through innerHTML, the element (`</style>`).
 */
export function quoteCssFamilyName(raw: string, quote: '"' | "'" = '"'): string {
  const name = raw.replace(/^(["'])(.*)\1$/s, '$2')
  const quoted = name !== raw
  if (name.length === 0) return name
  if (!quoted && CSS_GENERIC_FAMILIES.has(name.toLowerCase())) return name
  // A CSS identifier: a letter or underscore, then letters, digits, hyphens
  // and underscores. Anything else is quoted.
  if (!quoted && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return name
  const special =
    quote === '"' ? /[\\"<>&\u0000-\u001f\u007f]/g : /[\\'<>&\u0000-\u001f\u007f]/g
  const escaped = name.replace(special, (c) =>
    c === '\\' || c === quote ? `\\${c}` : `\\${c.charCodeAt(0).toString(16)} `,
  )
  return `${quote}${escaped}${quote}`
}

/** The family names in a `font-family` value (a stack), unquoted, in order, each once. */
export function fontFamilyNames(value: string): string[] {
  const names: string[] = []
  for (const entry of value.split(',')) {
    const name = entry
      .trim()
      .replace(/^(["'])(.*)\1$/s, '$2')
      .trim()
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}
