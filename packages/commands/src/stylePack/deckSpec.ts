/**
 * stylePack/deckSpec.ts — a deck described as data (agentic A5.2,
 * docs/plans/a5-deck-builder.md "The deck spec"): which pack, the deck's
 * variant, footer fields and language, and per slide a layout (or the
 * archetype the pack maps to one), the content of its slots, what is drawn
 * on the pack's grid, its notes, its message and its claims.
 * `style.deck.apply { spec }` builds it (A5.3); the deck keeps it in its
 * meta, so the same spec builds again with another variant or another pack.
 *
 * It lives next to the commands rather than in `shared` because its slot
 * text is the commands' text body (text/body.ts).
 *
 * `validateDeckSpec` checks a spec against the pack as a whole, before
 * anything is written, and reports every problem with its path
 * (`slides.3.slots.title`), as `validateStylePack` does for a pack.
 *
 * Languages: any text may hold `"Umsatz{de|en}Revenue"` — the part before
 * the marker in its first language, after it in its second (the Contoso decks'
 * convention); the deck's `lang` picks one, without it the first.
 */

import { z } from 'zod'
import {
  ArchetypeSchema,
  ColorRefSchema,
  PackIdSchema,
  PackRegionSchema,
  type ColorRef,
  type PackLayout,
  type StylePack,
} from '@narrative/shared'
import { TextBodyInputSchema } from '../text/body.js'
import { CommandError } from '../errors.js'

/** At most this many slides in one spec; one build is one transaction. */
export const MAX_SPEC_SLIDES = 60
/** At most this many bytes of JSON: the deck keeps the spec in its meta. */
export const MAX_SPEC_BYTES = 256 * 1024
/** At most this many drawn primitives in one spec: drawing is most of a build's work. */
export const MAX_SPEC_DRAWN = 300
/** A refusal names at most this many problems. */
const MAX_REPORTED_ISSUES = 50

const LangSchema = z.string().regex(/^[a-z]{2}$/)
const Px = z.number().finite().min(-4000).max(4000)

export const SpecPictureSchema = z.strictObject({
  assetId: z.string().min(1).max(64),
  focus: PackRegionSchema.shape.focus.describe(
    "The side of the picture kept in view (default: the layout's)",
  ),
})

/** A slot's content: text (a string or { paragraphs }), or a picture. */
export const SpecSlotSchema = z.union([SpecPictureSchema, TextBodyInputSchema])

/** Columns of the pack's grid, 0-based and inclusive: [0, 0] is the first, [0, 1] the first two. */
const GridXSchema = z
  .tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)])
  .refine(([a, b]) => a <= b, { message: 'the first column comes before the last' })
  .describe("Grid columns [first, last], 0-based, inclusive (style.pack.get 'summary' lists them)")

/** A band of the pack's grid plus an offset below it, px. */
const GridYSchema = z
  .strictObject({
    band: z.enum(['title', 'subtitle', 'content', 'footer']),
    offset: Px.optional(),
  })
  .describe('The top of a grid band (title, subtitle, content, footer), plus `offset` px down')

const DrawnBase = { x: GridXSchema, y: GridYSchema }
const StyleIdSchema = PackIdSchema.describe("A text style of the pack (style.pack.get 'summary')")

export const SpecPrimitiveSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('box'),
    ...DrawnBase,
    height: z.number().positive().max(1080),
    fill: ColorRefSchema.optional(),
    stroke: ColorRefSchema.optional(),
    radius: z.number().min(0).max(540).optional(),
  }),
  z.strictObject({
    kind: z.literal('text'),
    ...DrawnBase,
    height: z.number().positive().max(1080).optional(),
    text: TextBodyInputSchema,
    style: StyleIdSchema,
  }),
  z.strictObject({
    kind: z.literal('rule'),
    ...DrawnBase,
    color: ColorRefSchema.optional(),
    width: z.number().positive().max(40).optional(),
  }),
  z.strictObject({
    kind: z.literal('arrow'),
    ...DrawnBase,
    color: ColorRefSchema.optional(),
    width: z.number().positive().max(40).optional(),
  }),
  z.strictObject({
    kind: z.literal('number'),
    ...DrawnBase,
    value: z.string().min(1).max(12),
    style: StyleIdSchema.optional(),
    color: ColorRefSchema.optional(),
  }),
])
export type SpecPrimitive = z.infer<typeof SpecPrimitiveSchema>

export const SpecClaimSchema = z
  .strictObject({
    kind: z.enum(['sourced', 'source-needed', 'illustrative']),
    text: z.string().min(1).max(1000),
    source: z.string().min(1).max(500).optional(),
  })
  .refine((c) => c.kind !== 'sourced' || c.source !== undefined, {
    message: 'a sourced claim names its source',
    path: ['source'],
  })

export const SpecSlideSchema = z
  .strictObject({
    layout: PackIdSchema.optional().describe('A layout of the pack…'),
    archetype: ArchetypeSchema.optional().describe(
      '…or the kind of slide; the pack maps it to its layout',
    ),
    message: z.string().min(1).max(300).optional().describe("The slide's one-line job"),
    slots: z
      .record(z.string().min(1).max(200), SpecSlotSchema)
      .refine((r) => Object.keys(r).length <= 32, { message: 'at most 32 slots on a slide' })
      .optional(),
    drawn: z.array(SpecPrimitiveSchema).max(40).optional(),
    notes: z.string().max(20_000).optional().describe('Speaker notes, Markdown'),
    claims: z.array(SpecClaimSchema).max(20).optional(),
    surface: PackIdSchema.optional().describe('Where the layout offers a choice'),
  })
  .refine((s) => (s.layout === undefined) !== (s.archetype === undefined), {
    message: 'give exactly one of layout and archetype',
  })
export type SpecSlide = z.infer<typeof SpecSlideSchema>

export const DeckSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  packId: PackIdSchema.describe("The folder's pack (style.pack.get)"),
  variant: z.record(z.string().min(1).max(48), z.string().min(1).max(48)).optional(),
  lang: LangSchema.optional(),
  fields: z.record(z.string().min(1).max(48), z.string().max(400)).optional(),
  slides: z
    .array(SpecSlideSchema)
    .min(1)
    .max(MAX_SPEC_SLIDES)
    .refine((slides) => slides.reduce((n, s) => n + (s.drawn?.length ?? 0), 0) <= MAX_SPEC_DRAWN, {
      message: `at most ${MAX_SPEC_DRAWN} drawn primitives in a spec`,
    }),
})
export type DeckSpec = z.infer<typeof DeckSpecSchema>

export interface SpecIssue {
  path: string
  message: string
}

/**
 * The layout a spec slide is built with: the one it names, or of the
 * layouts the pack maps to its archetype (preferred first) the first whose
 * required text the slide's slots give — a required picture may come later —
 * else the first. Undefined when there is none.
 */
export function specSlideLayout(pack: StylePack, slide: SpecSlide): PackLayout | undefined {
  if (slide.layout !== undefined) return pack.layouts.find((x) => x.id === slide.layout)
  const candidates = (pack.archetypeMap[slide.archetype!] ?? [])
    .map((id) => pack.layouts.find((l) => l.id === id))
    .filter((l): l is PackLayout => l !== undefined)
  const given = new Set(Object.keys(slide.slots ?? {}))
  return (
    candidates.find((l) =>
      l.regions.every((r) => r.required !== true || r.type === 'image' || given.has(r.slot)),
    ) ?? candidates[0]
  )
}

/** Whether a colour reference names something the pack has. */
function colorKnown(pack: StylePack, ref: ColorRef): boolean {
  if (ref.startsWith('#')) return true
  if (ref.startsWith('color:')) return Object.hasOwn(pack.tokens.colors, ref.slice(6))
  const role = ref.slice(5)
  return pack.tokens.axes.some((a) => a.values.some((v) => role in v.roles))
}

const isPicture = (v: unknown): boolean => typeof v === 'object' && v !== null && 'assetId' in v

/**
 * Every problem of a spec against `pack`, by path; empty when the spec
 * builds. The spec must already have the shape (`DeckSpecSchema`).
 */
export function validateDeckSpec(spec: DeckSpec, pack: StylePack): SpecIssue[] {
  const issues: SpecIssue[] = []
  const issue = (path: string, message: string): void => void issues.push({ path, message })

  if (spec.packId !== pack.id)
    issue('packId', `the spec is for pack '${spec.packId}'; the folder's pack is '${pack.id}'`)
  for (const [axis, value] of Object.entries(spec.variant ?? {})) {
    const a = pack.tokens.axes.find((x) => x.id === axis)
    if (a === undefined)
      issue(
        `variant.${axis}`,
        `the pack has no axis '${axis}'; it has ${pack.tokens.axes.map((x) => x.id).join(', ')}`,
      )
    else if (!a.values.some((v) => v.id === value))
      issue(
        `variant.${axis}`,
        `axis '${axis}' has no value '${value}'; it has ${a.values.map((v) => v.id).join(', ')}`,
      )
  }
  const languages = pack.editorial.languages
  if (spec.lang !== undefined && languages.length > 0 && !languages.includes(spec.lang))
    issue('lang', `the pack writes ${languages.join(', ')}, not '${spec.lang}'`)
  const fieldNames = new Set(
    Object.values(pack.furniture.items).flatMap((i) =>
      i.kind === 'text' ? Object.keys(i.fields ?? {}) : [],
    ),
  )
  for (const field of Object.keys(spec.fields ?? {}))
    if (!fieldNames.has(field))
      issue(
        `fields.${field}`,
        fieldNames.size === 0
          ? "the pack's furniture has no fields"
          : `the pack's furniture has the fields ${[...fieldNames].join(', ')}`,
      )

  const columns = pack.grid.columns.length
  spec.slides.forEach((slide, i) => {
    const at = `slides.${i}`
    const layout = specSlideLayout(pack, slide)
    if (layout === undefined) {
      if (slide.layout !== undefined)
        issue(
          `${at}.layout`,
          `the pack has no layout '${slide.layout}'; it has ${pack.layouts.map((l) => l.id).join(', ')}`,
        )
      else issue(`${at}.archetype`, `the pack maps no layout to '${slide.archetype}'`)
      return
    }
    const given = new Set(Object.keys(slide.slots ?? {}))
    for (const [slot, content] of Object.entries(slide.slots ?? {})) {
      const region = layout.regions.find((r) => r.slot === slot)
      if (region === undefined) {
        issue(
          `${at}.slots.${slot}`,
          `layout '${layout.id}' has no slot '${slot}'; it has ${layout.regions.map((r) => r.slot).join(', ')}`,
        )
        continue
      }
      const takesPicture = region.type === 'image' && region.component === undefined
      if (isPicture(content) !== takesPicture)
        issue(
          `${at}.slots.${slot}`,
          takesPicture
            ? `slot '${slot}' takes a picture { assetId }`
            : region.type === 'text' || region.component !== undefined
              ? `slot '${slot}' takes text`
              : `slot '${slot}' (a ${region.type}) takes no content yet`,
        )
    }
    // Required text must be given; a required picture may come later (the
    // check reports its placeholder).
    for (const r of layout.regions)
      if (r.required === true && r.type !== 'image' && !given.has(r.slot))
        issue(`${at}.slots.${r.slot}`, `layout '${layout.id}' needs '${r.slot}'`)
    if (slide.surface !== undefined) {
      const s = layout.surface
      const offered = s === undefined ? [] : 'fixed' in s ? [s.fixed] : s.choose
      if (!offered.includes(slide.surface))
        issue(
          `${at}.surface`,
          offered.length === 0
            ? `layout '${layout.id}' offers no surface`
            : `layout '${layout.id}' offers ${offered.join(', ')}`,
        )
    }
    slide.drawn?.forEach((p, j) => {
      const pat = `${at}.drawn.${j}`
      if (p.x[1] >= columns)
        issue(`${pat}.x`, `the pack's grid has ${columns} columns (0 to ${columns - 1})`)
      if (p.y.band === 'subtitle' && pack.grid.bands.subtitle === undefined)
        issue(`${pat}.y.band`, "the pack's grid has no subtitle band")
      const style = 'style' in p ? p.style : undefined
      if (style !== undefined && !Object.hasOwn(pack.textStyles, style))
        issue(
          `${pat}.style`,
          `the pack has no text style '${style}'; it has ${Object.keys(pack.textStyles).join(', ')}`,
        )
      for (const key of ['fill', 'stroke', 'color'] as const) {
        const ref = (p as Record<string, unknown>)[key]
        if (typeof ref === 'string' && !colorKnown(pack, ref as ColorRef))
          issue(`${pat}.${key}`, `the pack has no colour ${ref}`)
      }
    })
  })
  return issues
}

/** Refuse a spec with problems: the first ones named by path, the rest counted. */
export function refuseIssues(issues: readonly SpecIssue[], packId: string): void {
  if (issues.length === 0) return
  const shown = issues.slice(0, MAX_REPORTED_ISSUES)
  throw new CommandError(
    'invalid_input',
    `the spec does not build with pack '${packId}': ` +
      shown.map((i) => `${i.path}: ${i.message}`).join('; ') +
      (issues.length > shown.length ? `; and ${issues.length - shown.length} more` : ''),
    { issues: shown.map((i) => ({ path: i.path.split('.'), message: i.message })) },
  )
}

const LANGUAGE_MARKER = /\{([a-z]{2})\|([a-z]{2})\}/

/**
 * A text in the deck's language: `"Umsatz{de|en}Revenue"` is "Umsatz" in
 * German and "Revenue" in English; without a language the first. Each
 * line and paragraph is its own (`"A{de|en}B\n\nC{de|en}D"`); text without
 * the marker is returned as it is.
 */
export function inLanguage(text: string, lang: string | undefined): string {
  return text
    .split(/(\n|\u2029)/)
    .map((segment) => {
      const m = LANGUAGE_MARKER.exec(segment)
      if (m === null) return segment
      return lang === m[2] ? segment.slice(m.index + m[0].length) : segment.slice(0, m.index)
    })
    .join('')
}

/** The example spec: a six-slide deck built with the rich example pack (`richExampleStylePack`). */
export function exampleDeckSpec(): DeckSpec {
  return {
    schemaVersion: 1,
    packId: 'example-rich',
    variant: { background: 'light' },
    lang: 'en',
    fields: { client: 'Acme' },
    slides: [
      {
        archetype: 'cover',
        message: 'Open with the result',
        slots: { title: 'Q3 review', subtitle: 'Vorstandssitzung{de|en}Board meeting' },
      },
      {
        archetype: 'agenda',
        slots: {
          title: 'Agenda',
          items: {
            paragraphs: [
              { text: 'Results', list: 'number' },
              { text: 'Regions', list: 'number' },
              { text: 'Next steps', list: 'number' },
            ],
          },
        },
      },
      {
        archetype: 'content',
        message: 'Every region grew',
        slots: {
          title: 'Revenue grew in every region',
          bullets: 'Europe +12 %\n\nAmericas +8 %\n\nAsia +15 %',
        },
        claims: [{ kind: 'sourced', text: 'Europe +12 %', source: 'Q3 finance report' }],
        notes: 'Start with **Asia**: the fastest growth.',
      },
      {
        layout: 'two-columns',
        slots: {
          title: 'Two markets, two speeds',
          left: 'Europe: steady, price-led',
          right: 'Asia: new customers, volume-led',
        },
        drawn: [{ kind: 'rule', x: [0, 1], y: { band: 'content', offset: -20 } }],
      },
      {
        archetype: 'statement',
        slots: {
          quote: 'Growth came from the customers we did not have a year ago.',
          attribution: 'CFO',
        },
      },
      {
        archetype: 'closer',
        slots: { title: 'Approve the Asia plan', contact: 'jane@acme.example' },
      },
    ],
  }
}
