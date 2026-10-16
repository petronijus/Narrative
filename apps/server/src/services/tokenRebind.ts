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
 *   2. Match by ORIGIN (A5.4): a token a style pack's compile made carries
 *      `origin { pack, key }` — `role:text`, `color:navy`,
 *      `textStyle:title`. The destination token made for the same key (by
 *      whichever pack: Fabrikam's `role:text` stands in for Contoso's) is the match;
 *      several → the smallest id. Compiled tokens share their names across
 *      packs ("Text", "Accent"), so the name alone would pair them by
 *      accident.
 *   3. Else match by NAME within the same category in the DESTINATION folder:
 *      names are compared trimmed, with runs of whitespace collapsed and case
 *      ignored ("Brand  Blue" = "brand blue"). Several destination tokens
 *      with that name → the one with the smallest id (deterministic).
 *      A match → the reference now points at the destination token
 *      (`rebound`). The same id in both folders with the same name is a match
 *      that changes nothing.
 *   4. No match:
 *      - a colour reference (`colors.*`, or a `textStyles.*` reference used as
 *        a colour) becomes the LITERAL colour it resolved to in the source
 *        folder (`literalised`) — on the deck's variant and the slide's
 *        surface, as it was drawn — so the deck looks exactly as before;
 *      - a text-style link (`textStyleId`) is removed (`detached`): the text
 *        keeps the typography it already carries, it just no longer follows
 *        a style;
 *      - an effect-style reference has no literal form and is left as it is
 *        (`unmatched`).
 *
 * The walk itself (every place a deck holds a reference) is slide-model's
 * `rewriteTokenRefs`, shared with re-laying a slide onto another pack.
 */

import type * as Y from 'yjs'
import {
  readDeckMeta,
  readSlideLayout,
  resolveTokenValue,
  rewriteTokenRefs,
  type FolderTokensSnapshot,
  type TokenOrigin,
  type TokenResolveContext,
} from '@narrative/slide-model'
import type { TokenRebindReport } from '@narrative/commands'

type Category = keyof FolderTokensSnapshot

type Outcome = { kind: 'rebind'; to: string } | { kind: 'literal' } | { kind: 'keep' }

export interface RebindPlan {
  /** The source folder's tokens: a literal is what a reference resolved to there. */
  source: FolderTokensSnapshot
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

/**
 * Destination token ids by their compile origin's key (`role:text`): the
 * folder's current pack's first (a compile leaves an earlier pack's tokens
 * behind), then the smallest id.
 */
function indexByOriginKey(
  tokens: Record<string, { origin?: TokenOrigin | undefined }>,
  currentPack: string | undefined,
): Map<string, string> {
  const byKey = new Map<string, string>()
  const ids = Object.keys(tokens).sort()
  const current = ids.filter((id) => tokens[id]?.origin?.pack === currentPack)
  for (const id of [...current, ...ids]) {
    const key = tokens[id]?.origin?.key
    if (typeof key === 'string' && !byKey.has(key)) byKey.set(key, id)
  }
  return byKey
}

/** Build the rebinding plan from the two folders' token snapshots. */
export function planTokenRebinding(
  source: FolderTokensSnapshot,
  dest: FolderTokensSnapshot,
  /** The destination folder's pack now, whose tokens a match by origin prefers. */
  opts: { destPackId?: string | undefined } = {},
): RebindPlan {
  const refs = new Map<string, Outcome>()
  const textStyleLinks = new Map<string, string | null>()
  for (const category of ['colors', 'textStyles', 'effectStyles'] as const satisfies Category[]) {
    const destTokens = dest[category] as Record<string, { name?: unknown; origin?: TokenOrigin }>
    const destByName = indexByName(destTokens)
    const destByOrigin = indexByOriginKey(destTokens, opts.destPackId)
    for (const [id, token] of Object.entries(source[category])) {
      const t = token as { name?: unknown; origin?: TokenOrigin }
      const n = normaliseName(t.name)
      const match =
        (t.origin !== undefined ? destByOrigin.get(t.origin.key) : undefined) ??
        (n === null ? undefined : destByName.get(n))
      const key = `${category}.${id}`
      if (match !== undefined) {
        refs.set(key, { kind: 'rebind', to: `${category}.${match}` })
        if (category === 'textStyles') textStyleLinks.set(id, match)
        continue
      }
      if (category === 'textStyles') textStyleLinks.set(id, null)
      refs.set(key, category === 'effectStyles' ? { kind: 'keep' } : { kind: 'literal' })
    }
  }
  return { source, refs, textStyleLinks }
}

/**
 * Apply a plan to a deck document (in the caller's transaction) — to every
 * slide, or only to `slides` (slide maps of that document). A literal is
 * the colour on the document's variant and the slide's surface. Returns
 * what changed. Only values that change are written.
 */
export function applyTokenRebinding(
  doc: Y.Doc,
  plan: RebindPlan,
  slides?: ReadonlyArray<Y.Map<unknown>>,
): RebindCounts {
  const counts: RebindCounts = { rebound: 0, literalised: 0, detached: 0, unmatched: 0 }
  const variant = readDeckMeta(doc).variant
  const contextOf = (slide: Y.Map<unknown>): TokenResolveContext => {
    const surface = readSlideLayout(slide.get('layout'))?.surface
    return {
      ...(variant !== undefined ? { variant } : {}),
      ...(surface !== undefined ? { surface } : {}),
    }
  }
  rewriteTokenRefs(slides ?? doc.getArray<Y.Map<unknown>>('slides').toArray(), {
    ref(ref, slide) {
      const outcome = plan.refs.get(ref.$token)
      if (outcome === undefined || outcome.kind === 'keep') {
        counts.unmatched++
        return undefined
      }
      if (outcome.kind === 'literal') {
        const hex = resolveTokenValue(ref, plan.source, contextOf(slide))
        const digits = hex?.replace(/^#/, '') ?? ''
        if (!/^[0-9a-f]{6}$/i.test(digits)) {
          counts.unmatched++
          return undefined
        }
        counts.literalised++
        return parseInt(digits, 16)
      }
      counts.rebound++
      return outcome.to === ref.$token ? undefined : { $token: outcome.to }
    },
    link(id) {
      if (!plan.textStyleLinks.has(id)) {
        counts.unmatched++
        return undefined
      }
      const to = plan.textStyleLinks.get(id) ?? null
      if (to === null) {
        counts.detached++
        return null
      }
      counts.rebound++
      return to === id ? undefined : to
    },
  })
  return counts
}
