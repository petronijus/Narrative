/**
 * renderer/runText/fontAliases.ts — the names a text worker draws a family's
 * faces under (ADR 0018 → Fonts).
 *
 * A worker's canvas resolves a `font` string to faces once and keeps that:
 * in Chromium (seen 2026-10-27, Chrome 14x) a font string first used in a
 * worker before its family's face was added there stays on the fallback face
 * after the face loads — every later raster of a text in that font, size and
 * weight painted the fallback's glyphs at the layout's (custom) positions,
 * while texts whose font string was first used afterwards painted right. A
 * face added later must therefore be reached under a name no font string of
 * the worker has used yet: each change to a family's faces registers them
 * again under a fresh alias (`nrf alias <n>`), and every font string a paint
 * carries is rewritten to the family's current alias. A family with no faces
 * keeps its own name (and the fallback the layout had too).
 */

/** A family name the worker registers a family's faces under. */
export function aliasName(generation: number): string {
  return `nrf alias ${generation}`
}

const GENERIC = new Set([
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
])

/** Split a CSS family list at commas outside quotes; names unquoted and unescaped. */
export function splitFamilies(list: string): Array<{ name: string; generic: boolean }> {
  const out: Array<{ name: string; generic: boolean }> = []
  let i = 0
  while (i < list.length) {
    while (i < list.length && /[\s,]/u.test(list[i]!)) i++
    if (i >= list.length) break
    const q = list[i]
    if (q === '"' || q === "'") {
      let name = ''
      i++
      while (i < list.length && list[i] !== q) {
        if (list[i] === '\\' && i + 1 < list.length) i++
        name += list[i]
        i++
      }
      i++
      out.push({ name, generic: false })
    } else {
      let name = ''
      while (i < list.length && list[i] !== ',') name += list[i++]
      name = name.trim().replace(/\s+/gu, ' ')
      out.push({ name, generic: GENERIC.has(name.toLowerCase()) })
    }
  }
  return out
}

function quote(name: string): string {
  return `"${name.replace(/["\\]/gu, (c) => `\\${c}`)}"`
}

/**
 * `font` (a CSS `font` shorthand as the layout reads it: style, weight, size
 * [/line-height], family list) with each family `alias` maps renamed. The
 * part before the family list is kept as it is.
 */
export function rewriteFontFamilies(
  font: string,
  alias: (family: string) => string | undefined,
): string {
  // The size is the first token ending in a length unit or a percentage.
  const m = /(^|\s)(\d*\.?\d+(?:px|pt|em|rem|%))(\s*\/\s*\S+)?\s+/u.exec(font)
  if (m === null) return font
  const head = font.slice(0, m.index + m[0].length)
  const families = splitFamilies(font.slice(m.index + m[0].length))
  let changed = false
  const names = families.map(({ name, generic }) => {
    if (generic) return name
    const a = alias(name)
    if (a !== undefined) changed = true
    return quote(a ?? name)
  })
  return changed ? head + names.join(', ') : font
}
