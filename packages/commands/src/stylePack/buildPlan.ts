/**
 * stylePack/buildPlan.ts — a deck spec (deckSpec.ts) as a plan per slide
 * (agentic A5.2): what `style.deck.apply { spec }` writes (A5.3). Pure: the
 * command hands it the spec, the folder's pack and tokens and the deck's
 * slides as stored; it returns the deck's meta, a layout plan per spec
 * slide (planLayout, with what the spec draws on the grid added), its notes
 * and brief, and which of the deck's slides the build cannot reuse.
 *
 *   - The spec is checked against the pack first (`validateDeckSpec`); one
 *     error names every problem by path.
 *   - Which deck slide a spec slide is built on: the one an earlier build
 *     made from the very same spec slide (`Slide.specKey`, a digest of the
 *     spec slide, the pack and the language) — kept, ids, animations and
 *     people's edits with it, its layout planned again (a new variant, new
 *     footer fields); else an empty slide (a new deck's first); else a new
 *     slide. A spec slide that changed is built fresh, so nothing of what
 *     it was (text a layout has no place for, notes) stays behind.
 *   - The deck's other slides go: an earlier build's (`superseded`) freely,
 *     slides made by hand (`handMade`) only when the command is told so.
 *   - Each slide is numbered by its place in the spec, so a footer's
 *     `{page}` reads the final order.
 *   - Text in every slot, drawn text, notes, the message and the claims is
 *     taken in the deck's language (`inLanguage`).
 *   - What the spec draws (`drawn`) becomes objects at the pack's grid
 *     columns and bands, slot `drawn-<n>`, linked to the pack's colour and
 *     text-style tokens.
 */

import type * as Y from 'yjs'
import { nanoid } from 'nanoid'
import {
  type Archetype,
  type ColorRef,
  type DeckMeta,
  type SlideBrief,
  type SlideLayoutRef,
  type SlideObject,
  type StylePack,
} from '@narrative/shared'
import { getObjectTypeDef, type FolderTokensSnapshot } from '@narrative/slide-model'
import { CommandError } from '../errors.js'
import { planFromBody, planText, planToDelta, type TextBodyInput } from '../text/body.js'
import { textStyleFields } from '../text/textStyle.js'
import {
  DRAWN_SLOT_PREFIX,
  packTokens,
  planLayout,
  type LayoutPlan,
  type SlotContent,
} from './layout.js'
import {
  inLanguage,
  refuseIssues,
  specSlideLayout,
  validateDeckSpec,
  type DeckSpec,
  type SpecPrimitive,
  type SpecSlide,
} from './deckSpec.js'

/** A deck slide as the build sees it. */
export interface BuildDeckSlide {
  id: string
  layout?: SlideLayoutRef
  /** Its objects as stored (Y.Maps, so text bodies keep their formatting). */
  objects: ReadonlyArray<Y.Map<unknown>>
  /** The spec slide an earlier build made it from (`Slide.specKey`). */
  specKey?: string
}

/** A digest of a spec slide as built with `packId` in `lang` (`Slide.specKey`). */
export function specSlideKey(slide: SpecSlide, packId: string, lang: string | undefined): string {
  const text = canonicalJson({ packId, lang: lang ?? null, slide })
  // cyrb53: two 32-bit FNV-like lanes, 53 bits of digest — a key, not a secret.
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** JSON with object keys sorted, so a spec slide's digest does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  return `{${Object.keys(value)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',')}}`
}

export interface BuiltSlide {
  /** 0-based place in the spec, and so in the deck after the build. */
  index: number
  /** The deck slide it is built on; undefined: a new slide. */
  slideId?: string
  /** What it records as `Slide.specKey`. */
  specKey: string
  /**
   * Built before from the very same spec slide: only re-laid (the variant,
   * the footer), its content, drawing and notes left as they are — with
   * whatever people changed on it since.
   */
  kept: boolean
  layoutId: string
  archetype?: Archetype
  plan: LayoutPlan
  /** Speaker notes, Markdown, in the deck's language. */
  notes?: string
  brief?: SlideBrief
}

export interface BuildPlan {
  /** The deck's meta after the build: the spec's, whole (an absent value clears it). */
  meta: {
    variant: Record<string, string> | null
    fields: Record<string, string> | null
    lang: string | null
  }
  slides: BuiltSlide[]
  /** Slides an earlier build made that this one does not keep: they go. */
  superseded: string[]
  /** Slides made by hand (no spec slide built them, not empty): they go only when allowed. */
  handMade: string[]
}

interface BuildArgs {
  spec: DeckSpec
  pack: StylePack
  tokens: FolderTokensSnapshot
  slides: ReadonlyArray<BuildDeckSlide>
}

/** A text body in the deck's language, its shape kept. */
function localized(body: TextBodyInput, lang: string | undefined): TextBodyInput {
  if (typeof body === 'string') return inLanguage(body, lang)
  return {
    ...body,
    paragraphs: body.paragraphs.map((p) => ({
      ...p,
      ...(p.text !== undefined ? { text: inLanguage(p.text, lang) } : {}),
      ...(p.runs !== undefined
        ? { runs: p.runs.map((r) => ({ ...r, text: inLanguage(r.text, lang) })) }
        : {}),
    })),
  } as TextBodyInput
}

export function planBuild(args: BuildArgs): BuildPlan {
  const { spec, pack, tokens } = args
  const issues = validateDeckSpec(spec, pack)
  refuseIssues(issues, pack.id)
  const lang = spec.lang
  const meta: DeckMeta = {
    ...(spec.variant !== undefined ? { variant: spec.variant } : {}),
    ...(spec.fields !== undefined ? { fields: spec.fields } : {}),
    ...(lang !== undefined ? { lang } : {}),
  }
  const variant: Record<string, string> = {}
  for (const axis of pack.tokens.axes) variant[axis.id] = spec.variant?.[axis.id] ?? axis.default

  // Each spec slide finds the deck slide built from it, else an empty one.
  const keys = spec.slides.map((slide) => specSlideKey(slide, spec.packId, lang))
  const taken = new Set<string>()
  const built = keys.map((key) => {
    const same = args.slides.find((s) => !taken.has(s.id) && s.specKey === key)
    if (same !== undefined) taken.add(same.id)
    return same
  })
  const reused = built.map((same) => {
    if (same !== undefined) return same
    const empty = args.slides.find(
      (s) => !taken.has(s.id) && s.specKey === undefined && s.objects.length === 0,
    )
    if (empty !== undefined) taken.add(empty.id)
    return empty
  })
  const slides = spec.slides.map((slide, index): BuiltSlide => {
    const layout = specSlideLayout(pack, slide)!
    const deckSlide = reused[index]
    const reuse = deckSlide !== undefined
    const kept = built[index] !== undefined
    // A kept slide keeps everything on it, its drawing too; any other slide
    // the build takes is empty.
    const held = reuse ? deckSlide.objects : []
    const content: Record<string, SlotContent> = {}
    for (const [slot, value] of Object.entries(slide.slots ?? {}))
      content[slot] =
        typeof value === 'object' && 'assetId' in value
          ? { assetId: value.assetId, ...(value.focus !== undefined ? { focus: value.focus } : {}) }
          : localized(value, lang)
    const plan = planLayout({
      pack,
      layoutId: layout.id,
      ...(slide.archetype !== undefined ? { archetype: slide.archetype } : {}),
      tokens,
      meta,
      objects: held,
      current: reuse ? deckSlide.layout : undefined,
      ...(kept ? {} : { content }),
      ...(slide.surface !== undefined ? { surface: slide.surface } : {}),
      slideNumber: index + 1,
    })
    const surface = plan.layout.surface
    plan.add.push(
      ...(kept ? [] : (slide.drawn ?? [])).map((p, j) =>
        drawnObject(
          pack,
          tokens,
          p,
          j,
          lang,
          {
            variant,
            ...(surface !== undefined ? { surface } : {}),
          },
          `slides.${index}.drawn.${j}`,
        ),
      ),
    )
    const message = slide.message !== undefined ? inLanguage(slide.message, lang) : undefined
    const claims = slide.claims?.map((c) => ({
      kind: c.kind,
      text: inLanguage(c.text, lang),
      ...(c.source !== undefined ? { source: c.source } : {}),
    }))
    return {
      index,
      ...(reuse ? { slideId: deckSlide.id } : {}),
      specKey: keys[index]!,
      kept,
      layoutId: layout.id,
      ...(plan.layout.archetype !== undefined ? { archetype: plan.layout.archetype } : {}),
      plan,
      ...(slide.notes !== undefined ? { notes: inLanguage(slide.notes, lang) } : {}),
      ...(message !== undefined || claims !== undefined
        ? {
            brief: {
              ...(message !== undefined ? { message } : {}),
              ...(claims !== undefined ? { claims } : {}),
            },
          }
        : {}),
    }
  })
  return {
    meta: {
      variant: spec.variant ?? null,
      fields: spec.fields ?? null,
      lang: lang ?? null,
    },
    slides,
    superseded: args.slides
      .filter((s) => !taken.has(s.id) && (s.specKey !== undefined || s.objects.length === 0))
      .map((s) => s.id),
    handMade: args.slides
      .filter((s) => !taken.has(s.id) && s.specKey === undefined && s.objects.length > 0)
      .map((s) => s.id),
  }
}

/** One thing a spec draws, as an object on the pack's grid. */
function drawnObject(
  pack: StylePack,
  tokens: FolderTokensSnapshot,
  p: SpecPrimitive,
  j: number,
  lang: string | undefined,
  ctx: { variant: Record<string, string>; surface?: string },
  path: string,
): SlideObject {
  const { grid } = pack
  const left = grid.columns[p.x[0]]![0]
  const right = grid.columns[p.x[1]]![1]
  const band = grid.bands[p.y.band] ?? grid.bands.content
  const box = { x: left, y: band + (p.y.offset ?? 0), width: right - left }
  const base = {
    id: nanoid(),
    slot: `${DRAWN_SLOT_PREFIX}${j + 1}`,
    name: `${DRAWN_SLOT_PREFIX}${j + 1}`,
    rotation: 0,
    opacity: 1,
  }
  const t = packTokens(pack, tokens, ctx)
  // A colour the compile made no token for is the spec's to change.
  const color = (ref: ColorRef, key: string) => {
    try {
      return t.colorToken(ref)
    } catch {
      throw new CommandError(
        'invalid_input',
        `${path}.${key}: the pack's compile has no token for ${ref}; use a colour the pack's styles use (role:text, a color: of the pack)`,
      )
    }
  }
  const textObject = (body: TextBodyInput, styleId: string, height: number | undefined) => {
    const style = t.styleToken(styleId)
    const plan = planFromBody(localized(body, lang))
    const defaults = getObjectTypeDef('text')?.defaultProps() ?? {}
    return {
      ...defaults,
      ...base,
      ...box,
      height: height ?? Math.ceil((style.size ?? 32) * 1.3),
      ...textStyleFields(style, tokens),
      textStyleId: style.id,
      textStyleOverrides: [],
      ...(height === undefined ? { autofit: 'grow-down' } : {}),
      type: 'text',
      text: planText(plan),
      _richTextOps: planToDelta(plan),
    }
  }
  switch (p.kind) {
    case 'box':
      return {
        ...(getObjectTypeDef('rectangle')?.defaultProps() ?? {}),
        ...base,
        ...box,
        height: p.height,
        type: 'rectangle',
        ...(p.fill !== undefined ? { fill: color(p.fill, 'fill') } : { fill: 0, fillAlpha: 0 }),
        ...(p.stroke !== undefined || p.fill === undefined
          ? { stroke: color(p.stroke ?? 'role:text', 'stroke'), strokeWidth: 2 }
          : {}),
        ...(p.radius !== undefined ? { cornerRadius: p.radius } : {}),
      } as unknown as SlideObject
    case 'rule':
    case 'arrow':
      return {
        ...(getObjectTypeDef('line')?.defaultProps() ?? {}),
        ...base,
        ...box,
        height: 0,
        type: 'line',
        p1: { x: 0, y: 0 },
        p2: { x: box.width, y: 0 },
        stroke: color(p.color ?? 'role:text', 'color'),
        strokeWidth: p.width ?? 2,
        ...(p.kind === 'arrow' ? { endCap: 'arrow' } : {}),
      } as unknown as SlideObject
    case 'text':
      return textObject(p.text, p.style, p.height) as unknown as SlideObject
    case 'number': {
      const styleId =
        p.style ??
        (Object.hasOwn(pack.textStyles, 'title') ? 'title' : Object.keys(pack.textStyles)[0]!)
      const obj = textObject(p.value, styleId, undefined) as Record<string, unknown>
      if (p.color !== undefined) {
        obj['color'] = color(p.color, 'color')
        obj['textStyleOverrides'] = ['color']
      }
      return obj as unknown as SlideObject
    }
  }
}
