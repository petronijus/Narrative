/**
 * services/tokenRebind.ts
 *
 * What happens to a deck's design-token references when the deck moves to
 * another folder. Tokens belong to folders (the folder document's
 * `tokens.{colors,textStyles,effectStyles}` maps), and a deck refers to them
 * by id: `{ $token: 'colors.<id>' }` on any colour-bearing field (object
 * fills, strokes, text colour, text-run attributes, shadows, table cells and
 * borders, animation params, backgrounds — at any depth) and
 * `textStyleId: '<id>'` on text objects and table cells. After a move those
 * ids point into the OLD folder, so the deck would render with fallbacks.
 *
 * THE RULE (per reference, category by category):
 *
 *   1. Look the referenced token up in the SOURCE folder. A reference to a
 *      token the source folder does not have is already dangling: it is left
 *      exactly as it is (counted as `unmatched`).
 *   2. Match by NAME within the same category in the DESTINATION folder:
 *      names are compared trimmed, with runs of whitespace collapsed and case
 *      ignored ("Brand  Blue" = "brand blue"). Several destination tokens
 *      with that name → the one with the smallest id (deterministic).
 *      A match → the reference now points at the destination token
 *      (`rebound`). The same id in both folders with the same name is a match
 *      that changes nothing.
 *   3. No match:
 *      - a colour reference (`colors.*`, or a `textStyles.*` reference used as
 *        a colour) becomes the LITERAL colour it resolved to in the source
 *        folder (`literalised`), so the deck looks exactly as before;
 *      - a text-style link (`textStyleId`) is removed (`detached`): the text
 *        keeps the typography it already carries, it just no longer follows
 *        a style;
 *      - an effect-style reference has no literal form and is left as it is
 *        (`unmatched`).
 *
 * Token roles are not modelled yet (plan §7.2 adds them with style packs);
 * when they land, a role match should take precedence over a name match.
 */

import * as Y from 'yjs'
import { isTokenRef, resolveTokenValue, type FolderTokensSnapshot } from '@narrative/slide-model'
import type { TokenRebindReport } from '@narrative/commands'

type Category = keyof FolderTokensSnapshot

type Outcome =
  | { kind: 'rebind'; to: string }
  | { kind: 'literal'; value: number }
  | { kind: 'keep' }

export interface RebindPlan {
  /** `category.id` (a token ref key) → what to do with references to it. */
  refs: Map<string, Outcome>
  /** Text-style id → new id, or null to detach. Missing = leave alone (dangling). */
  textStyleLinks: Map<string, string | null>
}

export type RebindCounts = Omit<TokenRebindReport, 'deckId' | 'error'>

function normaliseName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const n = name.trim().replace(/\s+/g, ' ').toLowerCase()
  return n === '' ? null : n
}

function indexByName(tokens: Record<string, { name?: unknown }>): Map<string, string> {
  const byName = new Map<string, string>()
  for (const id of Object.keys(tokens).sort()) {
    const n = normaliseName(tokens[id]?.name)
    if (n !== null && !byName.has(n)) byName.set(n, id)
  }
  return byName
}

function literalColour(ref: string, source: FolderTokensSnapshot): number | null {
  const hex = resolveTokenValue({ $token: ref }, source)
  if (hex === null) return null
  const digits = hex.replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(digits) ? parseInt(digits, 16) : null
}

/** Build the rebinding plan from the two folders' token snapshots. */
export function planTokenRebinding(
  source: FolderTokensSnapshot,
  dest: FolderTokensSnapshot,
): RebindPlan {
  const refs = new Map<string, Outcome>()
  const textStyleLinks = new Map<string, string | null>()
  for (const category of ['colors', 'textStyles', 'effectStyles'] as const satisfies Category[]) {
    const destByName = indexByName(dest[category] as Record<string, { name?: unknown }>)
    for (const [id, token] of Object.entries(source[category])) {
      const n = normaliseName((token as { name?: unknown }).name)
      const match = n === null ? undefined : destByName.get(n)
      const key = `${category}.${id}`
      if (match !== undefined) {
        refs.set(key, { kind: 'rebind', to: `${category}.${match}` })
        if (category === 'textStyles') textStyleLinks.set(id, match)
        continue
      }
      if (category === 'textStyles') textStyleLinks.set(id, null)
      const literal = category === 'effectStyles' ? null : literalColour(key, source)
      refs.set(key, literal === null ? { kind: 'keep' } : { kind: 'literal', value: literal })
    }
  }
  return { refs, textStyleLinks }
}

/**
 * Apply a plan to a deck document (in the caller's transaction) — to every
 * slide, or only to `slides` (slide maps of that document). Returns what
 * changed. Only values that change are written.
 */
export function applyTokenRebinding(
  doc: Y.Doc,
  plan: RebindPlan,
  slides?: ReadonlyArray<Y.Map<unknown>>,
): RebindCounts {
  const counts: RebindCounts = { rebound: 0, literalised: 0, detached: 0, unmatched: 0 }

  /** New value for a token ref, or undefined to leave it. */
  const mapRef = (ref: { $token: string }): unknown => {
    const outcome = plan.refs.get(ref.$token)
    if (outcome === undefined || outcome.kind === 'keep') {
      counts.unmatched++
      return undefined
    }
    if (outcome.kind === 'literal') {
      counts.literalised++
      return outcome.value
    }
    counts.rebound++
    return outcome.to === ref.$token ? undefined : { $token: outcome.to }
  }

  const mapLink = (id: string): { set: string } | { remove: true } | undefined => {
    if (!plan.textStyleLinks.has(id)) {
      counts.unmatched++
      return undefined
    }
    const to = plan.textStyleLinks.get(id) ?? null
    if (to === null) {
      counts.detached++
      return { remove: true }
    }
    counts.rebound++
    return to === id ? undefined : { set: to }
  }

  /** Plain JSON (not a Yjs type): a rewritten copy, or undefined when nothing changed. */
  const rewritePlain = (value: unknown): { value: unknown } | undefined => {
    if (Array.isArray(value)) {
      let changed = false
      const next = value.map((v) => {
        const r = rewritePlain(v)
        if (r === undefined) return v
        changed = true
        return r.value
      })
      return changed ? { value: next } : undefined
    }
    if (value === null || typeof value !== 'object' || value instanceof Y.AbstractType) {
      return undefined
    }
    if (isTokenRef(value)) {
      const mapped = mapRef(value)
      return mapped === undefined ? undefined : { value: mapped }
    }
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'textStyleId' && typeof v === 'string') {
        const link = mapLink(v)
        if (link === undefined) next[k] = v
        else if ('set' in link) next[k] = link.set
        changed ||= link !== undefined
        continue
      }
      const r = rewritePlain(v)
      if (r === undefined) next[k] = v
      else {
        next[k] = r.value
        changed = true
      }
    }
    return changed ? { value: next } : undefined
  }

  const walkText = (text: Y.Text): void => {
    let pos = 0
    for (const op of text.toDelta() as Array<{
      insert: unknown
      attributes?: Record<string, unknown>
    }>) {
      const len = typeof op.insert === 'string' ? op.insert.length : 1
      const attrs = op.attributes
      if (attrs !== undefined) {
        const patch: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(attrs)) {
          if (isTokenRef(v)) {
            const mapped = mapRef(v)
            if (mapped !== undefined) patch[k] = mapped
          }
        }
        if (Object.keys(patch).length > 0) text.format(pos, len, patch)
      }
      pos += len
    }
  }

  const walkMap = (map: Y.Map<unknown>): void => {
    for (const [k, v] of [...map.entries()]) {
      if (v instanceof Y.Map) walkMap(v)
      else if (v instanceof Y.Array) walkArray(v)
      else if (v instanceof Y.Text) walkText(v)
      else if (v instanceof Y.AbstractType)
        continue // notes (XmlFragment) carry no tokens
      else if (k === 'textStyleId' && typeof v === 'string') {
        const link = mapLink(v)
        if (link === undefined) continue
        if ('set' in link) map.set(k, link.set)
        else map.delete(k)
      } else {
        const r = rewritePlain(v)
        if (r !== undefined) map.set(k, r.value)
      }
    }
  }

  const walkArray = (arr: Y.Array<unknown>): void => {
    for (let i = 0; i < arr.length; i++) {
      const v = arr.get(i)
      if (v instanceof Y.Map) walkMap(v)
      else if (v instanceof Y.Array) walkArray(v)
      else if (v instanceof Y.Text) walkText(v)
      else if (!(v instanceof Y.AbstractType)) {
        const r = rewritePlain(v)
        if (r !== undefined) {
          arr.delete(i, 1)
          arr.insert(i, [r.value])
        }
      }
    }
  }

  if (slides === undefined) walkArray(doc.getArray('slides'))
  else for (const slide of slides) walkMap(slide)
  return counts
}
