/**
 * slide-model/src/scanTokenUsages.ts
 *
 * M16 P4 — Pure walker that finds all references to a given design token
 * inside a replayed Y.Doc (deck or component doc).
 *
 * The walker is dependency-free beyond yjs so it runs identically on the
 * server (Node) and in tests.  The route in apps/server orchestrates the
 * DB reads and calls these helpers.
 *
 * Coverage:
 *   - Slide object fields: fill, stroke (and gradient stop colors stored
 *     under fillStyle.stops[*].color — but those are plain numbers, not
 *     TokenRefs, so skipped)
 *   - Text object color + stroke
 *   - Text Y.Text run attributes (color)
 *   - Animation step params: to.color, to.fill, to.stroke
 *   - ComponentInstance overrides: leaves.<leafId>.fill / .stroke
 *   - Groups: recursed via groupId membership on the flat objects array
 *
 * textStyle token refs (folder doc) are scanned separately by the route
 * handler because they live in a different Y.Doc and require a different
 * call shape.
 */

import * as Y from 'yjs'
import { isTokenRef } from './tokens.js'

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface DeckUsageEntry {
  kind: 'deck'
  deckId: string
  deckTitle: string
  slideIndex: number
  objectId?: string
  field: string
}

export interface ComponentUsageEntry {
  kind: 'component'
  componentId: string
  componentName: string
  objectId?: string
  field: string
}

export interface TextStyleUsageEntry {
  kind: 'textStyle'
  styleId: string
  styleName: string
  field: 'color'
}

export type UsageEntry = DeckUsageEntry | ComponentUsageEntry | TextStyleUsageEntry

// ---------------------------------------------------------------------------
// Internal: check if a value stored in a Y.Map is a token ref for the target
// ---------------------------------------------------------------------------

function isTargetRef(value: unknown, tokenKey: string): boolean {
  return isTokenRef(value) && value.$token === tokenKey
}

// ---------------------------------------------------------------------------
// Internal: scan a single object Y.Map for color-bearing fields
// ---------------------------------------------------------------------------

/**
 * Checks the common color-bearing fields on a slide object Y.Map.
 * Returns the field names that reference the target token.
 */
function scanObjectMap(objectMap: Y.Map<unknown>, tokenKey: string): string[] {
  const matches: string[] = []

  // fill / stroke on shapes and text
  for (const field of ['fill', 'stroke', 'color']) {
    const v = objectMap.get(field)
    if (isTargetRef(v, tokenKey)) {
      matches.push(field)
    }
  }

  // Text Y.Text run attributes — inline color overrides per character range
  const textValue = objectMap.get('text')
  if (textValue instanceof Y.Text) {
    const delta = textValue.toDelta() as Array<{
      insert?: unknown
      attributes?: Record<string, unknown>
    }>
    for (const op of delta) {
      if (op.attributes?.['color'] !== undefined && isTargetRef(op.attributes['color'], tokenKey)) {
        if (!matches.includes('text.color')) {
          matches.push('text.color')
        }
      }
    }
  }

  // ComponentInstance overrides — leaves.<leafId>.fill / .stroke
  const overrides = objectMap.get('overrides')
  if (overrides instanceof Y.Map) {
    const leaves = overrides.get('leaves')
    if (leaves instanceof Y.Map) {
      leaves.forEach((leafMap, leafId) => {
        if (!(leafMap instanceof Y.Map)) return
        for (const f of ['fill', 'stroke']) {
          const v = leafMap.get(f)
          if (isTargetRef(v, tokenKey)) {
            matches.push(`overrides.leaves.${leafId}.${f}`)
          }
        }
      })
    }
  }

  return matches
}

// ---------------------------------------------------------------------------
// Internal: scan a single animation step Y.Map
// ---------------------------------------------------------------------------

function scanAnimationMap(stepMap: Y.Map<unknown>, tokenKey: string): string[] {
  const matches: string[] = []
  const params = stepMap.get('params')
  if (!(params instanceof Y.Map)) return matches

  // Color tweens use to.color / from.color, to.fill, to.stroke
  for (const outer of ['to', 'from']) {
    const group = params.get(outer)
    if (!(group instanceof Y.Map)) continue
    for (const field of ['color', 'fill', 'stroke']) {
      const v = group.get(field)
      if (isTargetRef(v, tokenKey)) {
        matches.push(`params.${outer}.${field}`)
      }
    }
  }

  // Flat params (in case a preset stores color directly at params level)
  for (const field of ['color', 'fill', 'stroke']) {
    const v = params.get(field)
    if (isTargetRef(v, tokenKey)) {
      matches.push(`params.${field}`)
    }
  }

  return matches
}

// ---------------------------------------------------------------------------
// scanDeckDoc — scan a replayed deck Y.Doc for token references
// ---------------------------------------------------------------------------

/**
 * Walks a deck Y.Doc and returns all references to the token identified by
 * `tokenKey` (e.g. `"colors.abc1234567"`).
 *
 * Fills in deckId + deckTitle from the caller — the Y.Doc itself does not
 * store those (they live in the Postgres metadata row).
 */
export function scanDeckDoc(
  doc: Y.Doc,
  deckId: string,
  deckTitle: string,
  tokenKey: string,
): DeckUsageEntry[] {
  const entries: DeckUsageEntry[] = []
  const slides = doc.getArray<Y.Map<unknown>>('slides')

  for (let slideIndex = 0; slideIndex < slides.length; slideIndex++) {
    const slideMap = slides.get(slideIndex)
    if (!(slideMap instanceof Y.Map)) continue

    const objects = slideMap.get('objects')
    if (objects instanceof Y.Array) {
      for (let oi = 0; oi < objects.length; oi++) {
        const objMap = objects.get(oi)
        if (!(objMap instanceof Y.Map)) continue
        const objectId =
          typeof objMap.get('id') === 'string' ? (objMap.get('id') as string) : undefined

        const fields = scanObjectMap(objMap, tokenKey)
        for (const field of fields) {
          entries.push({ kind: 'deck', deckId, deckTitle, slideIndex, objectId, field })
        }
      }
    }

    const animations = slideMap.get('animations')
    if (animations instanceof Y.Array) {
      for (let ai = 0; ai < animations.length; ai++) {
        const stepMap = animations.get(ai)
        if (!(stepMap instanceof Y.Map)) continue
        const objectId =
          typeof stepMap.get('objectId') === 'string'
            ? (stepMap.get('objectId') as string)
            : undefined

        const fields = scanAnimationMap(stepMap, tokenKey)
        for (const field of fields) {
          entries.push({ kind: 'deck', deckId, deckTitle, slideIndex, objectId, field })
        }
      }
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// scanComponentDoc — scan a replayed component Y.Doc for token references
// ---------------------------------------------------------------------------

/**
 * Walks a component Y.Doc (same schema as deck slides) and returns all
 * references to the token identified by `tokenKey`.
 *
 * A component doc contains slides (array) just like a deck — typically one
 * slide with the component's object tree. We scan every slide for
 * completeness.
 */
export function scanComponentDoc(
  doc: Y.Doc,
  componentId: string,
  componentName: string,
  tokenKey: string,
): ComponentUsageEntry[] {
  const entries: ComponentUsageEntry[] = []
  const slides = doc.getArray<Y.Map<unknown>>('slides')

  for (let si = 0; si < slides.length; si++) {
    const slideMap = slides.get(si)
    if (!(slideMap instanceof Y.Map)) continue

    const objects = slideMap.get('objects')
    if (objects instanceof Y.Array) {
      for (let oi = 0; oi < objects.length; oi++) {
        const objMap = objects.get(oi)
        if (!(objMap instanceof Y.Map)) continue
        const objectId =
          typeof objMap.get('id') === 'string' ? (objMap.get('id') as string) : undefined

        const fields = scanObjectMap(objMap, tokenKey)
        for (const field of fields) {
          entries.push({ kind: 'component', componentId, componentName, objectId, field })
        }
      }
    }

    const animations = slideMap.get('animations')
    if (animations instanceof Y.Array) {
      for (let ai = 0; ai < animations.length; ai++) {
        const stepMap = animations.get(ai)
        if (!(stepMap instanceof Y.Map)) continue
        const objectId =
          typeof stepMap.get('objectId') === 'string'
            ? (stepMap.get('objectId') as string)
            : undefined

        const fields = scanAnimationMap(stepMap, tokenKey)
        for (const field of fields) {
          entries.push({ kind: 'component', componentId, componentName, objectId, field })
        }
      }
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// scanFolderDoc — scan a replayed folder Y.Doc for textStyle token refs
// ---------------------------------------------------------------------------

/**
 * Walks the folder Y.Doc's `tokens.textStyles` map and returns entries for
 * any text style whose `color` field references the target token key.
 *
 * Only relevant when `category === 'colors'` — textStyle.color can be a
 * TokenRef into the colors map.
 */
export function scanFolderDoc(doc: Y.Doc, tokenKey: string): TextStyleUsageEntry[] {
  const entries: TextStyleUsageEntry[] = []
  const tokensMap = doc.getMap<unknown>('tokens')
  const textStylesMap = tokensMap.get('textStyles')
  if (!(textStylesMap instanceof Y.Map)) return entries

  textStylesMap.forEach((styleEntry: unknown, styleId: string) => {
    if (!(styleEntry instanceof Y.Map)) return
    const color = styleEntry.get('color')
    if (isTargetRef(color, tokenKey)) {
      const styleName =
        typeof styleEntry.get('name') === 'string' ? (styleEntry.get('name') as string) : styleId
      entries.push({ kind: 'textStyle', styleId, styleName, field: 'color' })
    }
  })

  return entries
}
