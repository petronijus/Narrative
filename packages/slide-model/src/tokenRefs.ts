/**
 * slide-model/src/tokenRefs.ts — rewrite a deck's design-token references
 * in place, wherever they are (agentic A5.4).
 *
 * A deck refers to its folder's tokens by id: `{ $token: 'colors.<id>' }`
 * on any colour-bearing field — object fills, strokes, text colour, the
 * attributes of text runs, shadows, table cells and borders, animation
 * params, backgrounds, at any depth — and `textStyleId: '<id>'` on text
 * objects and table cells. Two things rewrite them: a deck or slides moving
 * to another folder (server services/tokenRebind.ts) and a slide re-laid
 * with another pack (`style.deck.apply { relayout }`). Both walk the same
 * places; this is that walk. What a reference becomes is the caller's
 * (`TokenRefRewrite`), told which slide it is on, since a colour resolves on
 * the slide's surface.
 *
 * Writes go to the slide's own Yjs types (in the caller's transaction):
 * only values that change are written; a run's attribute through
 * `Y.Text.format`, a plain JSON value replaced whole.
 */

import * as Y from 'yjs'
import { isTokenRef } from './tokens.js'

export interface TokenRefRewrite {
  /** What a `{ $token }` on `slide` becomes: a new value (a reference or a literal), or undefined to leave it. */
  ref(ref: { $token: string }, slide: Y.Map<unknown>): unknown
  /** What a text-style link on `slide` becomes: a new id, null to remove it, undefined to leave it. */
  link(id: string, slide: Y.Map<unknown>): string | null | undefined
}

/** Rewrite every token reference on `slides` (slide maps) as `rewrite` says. */
export function rewriteTokenRefs(slides: Iterable<Y.Map<unknown>>, rewrite: TokenRefRewrite): void {
  for (const slide of slides) {
    /** Plain JSON: a rewritten copy, or undefined when nothing changed. */
    const plain = (value: unknown): { value: unknown } | undefined => {
      if (Array.isArray(value)) {
        let changed = false
        const next = value.map((v) => {
          const r = plain(v)
          if (r === undefined) return v
          changed = true
          return r.value
        })
        return changed ? { value: next } : undefined
      }
      if (value === null || typeof value !== 'object' || value instanceof Y.AbstractType)
        return undefined
      if (isTokenRef(value)) {
        const mapped = rewrite.ref(value, slide)
        return mapped === undefined ? undefined : { value: mapped }
      }
      let changed = false
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === 'textStyleId' && typeof v === 'string') {
          const to = rewrite.link(v, slide)
          if (to === undefined) next[k] = v
          else {
            if (to !== null) next[k] = to
            changed = true
          }
          continue
        }
        const r = plain(v)
        if (r === undefined) next[k] = v
        else {
          next[k] = r.value
          changed = true
        }
      }
      return changed ? { value: next } : undefined
    }

    const text = (t: Y.Text): void => {
      let pos = 0
      for (const op of t.toDelta() as Array<{
        insert: unknown
        attributes?: Record<string, unknown>
      }>) {
        const len = typeof op.insert === 'string' ? op.insert.length : 1
        if (op.attributes !== undefined) {
          const patch: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(op.attributes))
            if (isTokenRef(v)) {
              const mapped = rewrite.ref(v, slide)
              if (mapped !== undefined) patch[k] = mapped
            }
          if (Object.keys(patch).length > 0) t.format(pos, len, patch)
        }
        pos += len
      }
    }

    const map = (m: Y.Map<unknown>): void => {
      for (const [k, v] of [...m.entries()]) {
        if (v instanceof Y.Map) map(v)
        else if (v instanceof Y.Array) array(v)
        else if (v instanceof Y.Text) text(v)
        else if (v instanceof Y.AbstractType)
          continue // notes (XmlFragment) carry no tokens
        else if (k === 'textStyleId' && typeof v === 'string') {
          const to = rewrite.link(v, slide)
          if (to === undefined) continue
          if (to === null) m.delete(k)
          else if (to !== v) m.set(k, to)
        } else {
          const r = plain(v)
          if (r !== undefined) m.set(k, r.value)
        }
      }
    }

    const array = (a: Y.Array<unknown>): void => {
      for (let i = 0; i < a.length; i++) {
        const v = a.get(i)
        if (v instanceof Y.Map) map(v)
        else if (v instanceof Y.Array) array(v)
        else if (v instanceof Y.Text) text(v)
        else if (!(v instanceof Y.AbstractType)) {
          const r = plain(v)
          if (r !== undefined) {
            a.delete(i, 1)
            a.insert(i, [r.value])
          }
        }
      }
    }

    map(slide)
  }
}
