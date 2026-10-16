/**
 * stylePack/restyle.ts — a slide drawn with one style pack, restyled into
 * another (agentic A5.4, `style.deck.apply { relayout: 'archetype' }`).
 *
 *   - Which layout of the new pack: the one it maps to the slide's
 *     archetype (recorded on the slide by slide.applyLayout, the build, or
 *     deck.insertFrom while it still read the source pack); else a layout of
 *     the same id. Neither: the slide is left as it is, and listed.
 *   - Its colours and text styles: a reference to a token another pack's
 *     compile made is re-pointed at the token the new pack's compile made
 *     for the same purpose (`origin.key`: `role:text` → the new pack's text
 *     colour, `color:navy` → its navy if it has one, `textStyle:title` → its
 *     title style). A colour with no counterpart becomes the colour it was,
 *     on the deck's variant and the slide's surface as it was drawn; a text
 *     style with none is unlinked (the text keeps its typography). The
 *     slide's objects are then laid into the new layout by slot and role
 *     (planLayout).
 */

import type * as Y from 'yjs'
import type { Archetype, PackLayout, SlideLayoutRef, StylePack } from '@narrative/shared'
import {
  parseHexColor,
  resolveTokenValue,
  rewriteTokenRefs,
  type FolderTokensSnapshot,
  type TokenResolveContext,
} from '@narrative/slide-model'
import { compiledTokenId } from './compile.js'
import { layoutForArchetype } from './layout.js'

/** The new pack's layout for a slide that follows `ref` (another pack's layout), or undefined. */
export function restyleLayout(pack: StylePack, ref: SlideLayoutRef): PackLayout | undefined {
  if (ref.archetype !== undefined) {
    const mapped = (pack.archetypeMap[ref.archetype] ?? []).length > 0
    if (mapped) return layoutForArchetype(pack, ref.archetype as Archetype)
  }
  return pack.layouts.find((l) => l.id === ref.layoutId)
}

export interface RebindCounts {
  rebound: number
  literalised: number
  detached: number
}

/**
 * Re-point `slide`'s references to other packs' compiled tokens at `pack`'s
 * (in the caller's transaction). `drawnWith` is where the slide's colours
 * resolved before: the deck's variant and the slide's surface then.
 */
export function rebindToPack(
  slide: Y.Map<unknown>,
  pack: StylePack,
  tokens: FolderTokensSnapshot,
  drawnWith: TokenResolveContext,
): RebindCounts {
  const counts: RebindCounts = { rebound: 0, literalised: 0, detached: 0 }
  /** The new pack's token for another pack's compiled one, by purpose; null: none; undefined: not another pack's. */
  const counterpart = (
    category: 'colors' | 'textStyles',
    id: string,
  ): string | null | undefined => {
    const origin = tokens[category][id]?.origin
    if (origin === undefined || origin.pack === pack.id) return undefined
    const target = compiledTokenId(pack.id, origin.key)
    return Object.hasOwn(tokens[category], target) ? target : null
  }
  rewriteTokenRefs([slide], {
    ref(ref) {
      const dot = ref.$token.indexOf('.')
      const category = ref.$token.slice(0, dot)
      if (category !== 'colors' && category !== 'textStyles') return undefined
      const to = counterpart(category, ref.$token.slice(dot + 1))
      if (to === undefined) return undefined
      if (to !== null) {
        counts.rebound++
        return { $token: `${category}.${to}` }
      }
      const hex = resolveTokenValue(ref, tokens, drawnWith)
      const color = hex === null ? null : parseHexColor(hex)
      if (color === null) return undefined
      counts.literalised++
      return color.color
    },
    link(id) {
      const to = counterpart('textStyles', id)
      if (to === undefined) return undefined
      if (to === null) counts.detached++
      else counts.rebound++
      return to
    },
  })
  return counts
}
