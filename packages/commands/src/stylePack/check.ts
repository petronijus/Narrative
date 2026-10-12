/**
 * stylePack/check.ts — the brand checker behind `query.check` (agentic A4.5,
 * docs/plans/agentic-layer.md §7.5): a deck against its folder's style pack,
 * ported from Contoso's `check_deck.py` and the Fabrikam HTML checker. Pure: the
 * command hands it the slides as stored, the pack, the folder's tokens, the
 * deck's meta and the render worker's measurement of the text.
 *
 * Rules (`QA_RULE_IDS`), each at the level the pack's `qa.rules` gives it,
 * else its default (DEFAULT_LEVELS):
 *   - fit — text that runs below its box (measured with the real fonts); a
 *     growing box against the next object below it or the footer band,
 *     with `qa.fit.slackLines` of slack; `growWarnRatio` warns early.
 *   - font-missing — a face that did not load: the fit is not verified.
 *   - partial-overlap — two content objects that overlap without one
 *     holding the other; outside-grid — content outside the margins
 *     (pictures and shapes may bleed off the slide edge).
 *   - text-color — text in a colour the pack's whitelist does not have, on
 *     that slide's variant and surface; variant-mix — a slide background
 *     from another variant than the deck's.
 *   - furniture — a required item missing from a laid-out slide;
 *     missing-picture — a picture region still holding its placeholder;
 *     sentinel — placeholder text (`qa.sentinels`, furniture field
 *     sentinels) left in.
 *   - editorial: caps, italics, bullet-glyph, title-period (a title's
 *     period and length), accent-budget, typography (quotes, ranges,
 *     dashes, spaces before units, ellipses, the pack's replacements,
 *     underline, the minimum body size), emoji.
 *
 * Furniture is the pack's own: only its text's sentinels are checked.
 */

import * as Y from 'yjs'
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type ColorRef,
  type DeckMeta,
  type QaRuleId,
  type Slide,
  type SlideObject,
  type StylePack,
  type TextObject,
} from '@narrative/shared'
import {
  getParagraphDeltas,
  parseHexColor,
  resolveTokenValue,
  type FolderTokensSnapshot,
  type ParagraphDelta,
  type RichDeltaOp,
  type TokenResolveContext,
} from '@narrative/slide-model'

export type CheckLevel = 'error' | 'warn'

export interface CheckFinding {
  level: CheckLevel
  rule: QaRuleId
  /** Absent for a deck-wide finding (a font that did not load). */
  slideId?: string
  index?: number
  objectId?: string
  cell?: { row: number; col: number }
  message: string
}

/** What the render worker measured on the checked slides (services/render.ts `measure`). */
export interface CheckMeasurement {
  overflow: ReadonlyArray<{
    slideId: string
    objectId: string
    boxHeight: number
    textHeight: number
  }>
  /** Growing boxes as drawn; null when the renderer could not say (older than A4.5). */
  grown: ReadonlyArray<{ slideId: string; objectId: string; height: number }> | null
  failedFonts: readonly string[]
}

export interface CheckInput {
  pack: StylePack
  tokens: FolderTokensSnapshot | null
  meta: DeckMeta
  /** The slides to check, with their 0-based position in the deck. */
  slides: ReadonlyArray<{ slide: Slide; index: number }>
  /** null: the fit was not measured (asked off). */
  measurement: CheckMeasurement | null
}

export interface CheckReport {
  /** Text fit measured with every font loaded, on every checked slide. */
  fitVerified: boolean
  errors: number
  warnings: number
  findings: CheckFinding[]
}

const DEFAULT_LEVELS: Readonly<Record<QaRuleId, CheckLevel>> = {
  fit: 'error',
  'font-missing': 'error',
  'partial-overlap': 'error',
  'outside-grid': 'warn',
  'text-color': 'error',
  'variant-mix': 'error',
  furniture: 'error',
  sentinel: 'error',
  'missing-picture': 'error',
  caps: 'warn',
  italics: 'error',
  'bullet-glyph': 'warn',
  'title-period': 'warn',
  'accent-budget': 'warn',
  typography: 'warn',
  emoji: 'error',
}

/** Rounding of stored geometry (half pixels) and of the measurement. */
const TOLERANCE = 1

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One paragraph of a text body: its plain text, its runs, its list attributes. */
interface Paragraph {
  text: string
  runs: RichDeltaOp[]
  attrs: ParagraphDelta['attrs']
}

/** A text body the rules read: a text box, or one table cell. */
interface TextBody {
  object: SlideObject
  cell?: { row: number; col: number }
  paragraphs: Paragraph[]
}

function paragraphsOf(text: string | Y.Text | undefined): Paragraph[] {
  if (text === undefined) return []
  if (text instanceof Y.Text) {
    return getParagraphDeltas(text).map((p) => ({
      text: p.ops.map((o) => o.insert).join(''),
      runs: p.ops,
      attrs: p.attrs,
    }))
  }
  return text.split(' ').map((t) => ({ text: t, runs: [{ insert: t }], attrs: {} }))
}

function bodiesOf(object: SlideObject): TextBody[] {
  if (object.type === 'text') return [{ object, paragraphs: paragraphsOf(object.text) }]
  if (object.type === 'table') {
    const out: TextBody[] = []
    object.rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        if (cell.text === undefined) return
        out.push({ object, cell: { row: r, col: c }, paragraphs: paragraphsOf(cell.text) })
      }),
    )
    return out
  }
  return []
}

const contains = (a: Rect, b: Rect): boolean =>
  b.x >= a.x - TOLERANCE &&
  b.y >= a.y - TOLERANCE &&
  b.x + b.width <= a.x + a.width + TOLERANCE &&
  b.y + b.height <= a.y + a.height + TOLERANCE

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > TOLERANCE && h > TOLERANCE ? w * h : 0
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `needle` as a whole word (not inside a longer word). */
function hasWord(haystack: string, needle: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(
    haystack,
  )
}

const EMOJI = /\p{Extended_Pictographic}/u
/** Pictographic by Unicode, but ordinary in business text. */
const NOT_EMOJI = new Set(['©', '®', '™', '↔', '↕', '‼', '⁉'])

/** Three or more words in capitals in a row (abbreviations alone pass). */
const CAPS_RUN = /(?:\b\p{Lu}{2,}\b[\s,;:–-]+){2,}\b\p{Lu}{2,}\b/u
const UNIT_AFTER_SPACE = /\d (?:%|‰|€|\$|£|°C|°F|kg|km|cm|mm|ms|min|GB|MB|TB|px|m|s|h)(?![\p{L}])/u

/** A pack colour reference as hex on a variant and surface, straight from the pack. */
function packHex(
  pack: StylePack,
  ref: ColorRef,
  ctx: TokenResolveContext,
  depth = 0,
): string | null {
  if (depth > 4) return null
  if (ref.startsWith('#')) return ref.slice(0, 7).toLowerCase()
  if (ref.startsWith('color:')) {
    const c = pack.tokens.colors[ref.slice(6)]
    return c === undefined ? null : c.value.slice(0, 7).toLowerCase()
  }
  const role = ref.slice(5) as keyof NonNullable<StylePack['tokens']['surfaces']>[string]['roles']
  const onSurface =
    ctx.surface === undefined ? undefined : pack.tokens.surfaces?.[ctx.surface]?.roles[role]
  if (onSurface !== undefined) return packHex(pack, onSurface, ctx, depth + 1)
  for (const axis of pack.tokens.axes) {
    if (!axis.values.some((v) => role in v.roles)) continue
    // A surface that is a value of this axis pins it (compile.ts does the same).
    const pinned = axis.values.some((v) => v.id === ctx.surface) ? ctx.surface : undefined
    const valueId = pinned ?? ctx.variant?.[axis.id] ?? axis.default
    const value = axis.values.find((v) => v.id === valueId) ?? axis.values[0]!
    const r = value.roles[role]
    return r === undefined ? null : packHex(pack, r, ctx, depth + 1)
  }
  return null
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`

export function checkDeck(input: CheckInput): CheckReport {
  const { pack, tokens, meta, measurement } = input
  const { editorial, qa } = pack
  const findings: CheckFinding[] = []
  const levelOf = (rule: QaRuleId): CheckLevel | null => {
    const set = qa.rules?.[rule]
    if (set === 'off') return null
    return set ?? DEFAULT_LEVELS[rule]
  }
  const report = (rule: QaRuleId, f: Omit<CheckFinding, 'rule' | 'level'>, level?: CheckLevel) => {
    const l = level ?? levelOf(rule)
    if (l === null) return
    findings.push({ level: l, rule, ...f })
  }

  // ── Deck-wide: the fonts the measurement needed ────────────────────────
  let fitVerified = measurement !== null
  if (measurement !== null) {
    for (const family of measurement.failedFonts) {
      fitVerified = false
      report('font-missing', {
        message: `The font ${family} did not load: the fit of its text is not verified`,
      })
    }
  }

  const variant: Record<string, string> = {}
  for (const axis of pack.tokens.axes) variant[axis.id] = meta.variant?.[axis.id] ?? axis.default
  const backgroundAxis = pack.tokens.axes.find((a) => a.values.some((v) => 'background' in v.roles))

  // Sentinels: the pack's, and the placeholder text of its furniture fields.
  const sentinels = new Set(qa.sentinels)
  for (const item of Object.values(pack.furniture.items)) {
    if (item.kind !== 'text') continue
    for (const field of Object.values(item.fields ?? {}))
      if (field.sentinel !== undefined && field.sentinel !== '') sentinels.add(field.sentinel)
  }
  const replacements = (editorial.replace ?? []).flatMap((r) => {
    try {
      return [{ ...r, re: new RegExp(r.pattern, 'u') }]
    } catch {
      return []
    }
  })

  const grownOf = new Map<string, number>()
  for (const g of measurement?.grown ?? []) grownOf.set(`${g.slideId}/${g.objectId}`, g.height)
  const overflowOf = new Map<string, { boxHeight: number; textHeight: number }>()
  for (const o of measurement?.overflow ?? []) overflowOf.set(`${o.slideId}/${o.objectId}`, o)

  for (const { slide, index } of input.slides) {
    const at = { slideId: slide.id, index }
    const layoutRef = slide.layout?.packId === pack.id ? slide.layout : undefined
    const layout =
      layoutRef === undefined ? undefined : pack.layouts.find((l) => l.id === layoutRef.layoutId)
    const ctx: TokenResolveContext = {
      variant,
      ...(slide.layout?.surface !== undefined ? { surface: slide.layout.surface } : {}),
    }
    const colorOf = (c: number | { $token: string } | undefined): number | null => {
      if (c === undefined) return null
      if (typeof c === 'number') return c
      if (tokens === null) return null
      const v = resolveTokenValue(c, tokens, ctx)
      return v === null ? null : (parseHexColor(v)?.color ?? null)
    }
    const allowed = new Set(
      qa.textColors.map((ref) => packHex(pack, ref, ctx)).filter((h): h is string => h !== null),
    )
    const accent =
      editorial.accentBudget === undefined ? null : packHex(pack, editorial.accentBudget.color, ctx)

    const objects = slide.objects.filter((o) => o.groupId === undefined && o.opacity > 0)
    const content = objects.filter((o) => o.role !== 'furniture')

    // ── Fit ─────────────────────────────────────────────────────────────
    if (measurement !== null) {
      for (const o of objects) {
        if (o.type !== 'text') continue
        const key = `${slide.id}/${o.id}`
        const over = overflowOf.get(key)
        if (over !== undefined) {
          report('fit', {
            ...at,
            objectId: o.id,
            message: `The text runs ${Math.round(over.textHeight - over.boxHeight)} px below its box (${Math.round(over.boxHeight)} px tall)`,
          })
        }
        if (o.autofit !== 'grow-down') continue
        if (measurement.grown === null) {
          fitVerified = false
          report('fit', {
            ...at,
            objectId: o.id,
            message: 'The renderer did not measure this growing box: its fit is not verified',
          })
          continue
        }
        const height = grownOf.get(key)
        if (height === undefined) continue
        const bottom = o.y + height
        // The next object below the box as laid out, else the footer band.
        let limit = Math.min(pack.grid.bands.footer, SLIDE_HEIGHT - pack.grid.margins.bottom)
        let limitName = 'the footer'
        for (const other of objects) {
          if (other.id === o.id) continue
          if (other.y < o.y + o.height - TOLERANCE) continue
          if (other.x >= o.x + o.width || other.x + other.width <= o.x) continue
          if (other.y < limit) {
            limit = other.y
            limitName = other.slot ?? other.name ?? other.id
          }
        }
        const line = lineHeightPx(o)
        const slack = qa.fit.slackLines * line
        if (bottom > limit + slack + TOLERANCE) {
          report('fit', {
            ...at,
            objectId: o.id,
            message: `The growing text reaches y ${Math.round(bottom)}, ${Math.round(bottom - limit)} px over ${limitName} (slack ${Math.round(slack)} px)`,
          })
        } else if (qa.fit.growWarnRatio !== undefined && height > o.height * qa.fit.growWarnRatio) {
          report(
            'fit',
            {
              ...at,
              objectId: o.id,
              message: `The text grew to ${Math.round(height)} px, over ${qa.fit.growWarnRatio}× its box (${Math.round(o.height)} px)`,
            },
            'warn',
          )
        }
      }
    }

    // ── Collisions and the grid ─────────────────────────────────────────
    for (let i = 0; i < content.length; i++) {
      for (let j = i + 1; j < content.length; j++) {
        const a = content[i]!
        const b = content[j]!
        if (overlapArea(a, b) === 0 || contains(a, b) || contains(b, a)) continue
        report('partial-overlap', {
          ...at,
          objectId: b.id,
          message: `Overlaps ${a.slot ?? a.name ?? a.id} partly (one should hold the other, or neither touch)`,
        })
      }
    }
    const m = pack.grid.margins
    const safe: Rect = {
      x: m.left,
      y: m.top,
      width: SLIDE_WIDTH - m.left - m.right,
      height: SLIDE_HEIGHT - m.top - m.bottom,
    }
    for (const o of content) {
      if (contains(safe, o)) continue
      // A picture or a shape may bleed off the slide edge on purpose.
      const bleeds =
        o.x <= TOLERANCE ||
        o.y <= TOLERANCE ||
        o.x + o.width >= SLIDE_WIDTH - TOLERANCE ||
        o.y + o.height >= SLIDE_HEIGHT - TOLERANCE
      if (bleeds && o.type !== 'text' && o.type !== 'table') continue
      report('outside-grid', {
        ...at,
        objectId: o.id,
        message: `Outside the margins (${m.left}/${m.top}/${m.right}/${m.bottom} px)`,
      })
    }

    // ── Variant ─────────────────────────────────────────────────────────
    if (
      qa.oneVariantPerDeck &&
      backgroundAxis !== undefined &&
      slide.background?.kind === 'color'
    ) {
      const own = packHex(pack, 'role:background', { variant })
      const bg = hex(slide.background.color)
      if (layoutRef?.surface === undefined && bg !== own) {
        const other = backgroundAxis.values.find(
          (v) =>
            v.id !== variant[backgroundAxis.id] &&
            packHex(pack, 'role:background', {
              variant: { ...variant, [backgroundAxis.id]: v.id },
            }) === bg,
        )
        if (other !== undefined)
          report('variant-mix', {
            ...at,
            message: `The background is the ${other.name} variant's (${bg}); the deck is ${variant[backgroundAxis.id]}`,
          })
      }
    }

    // ── What the layout requires ────────────────────────────────────────
    if (layout !== undefined) {
      const placed = (slot: string) => objects.find((o) => o.slot === slot)
      for (const fid of layout.furniture ?? pack.furniture.defaultSet) {
        if (!qa.requiredFurniture.includes(fid) || placed(fid) !== undefined) continue
        report('furniture', { ...at, message: `The ${fid} is missing (re-apply the layout)` })
      }
      for (const region of layout.regions) {
        if (region.type !== 'image' || region.required === false) continue
        const o = placed(region.slot)
        if (o?.type === 'image') continue
        report('missing-picture', {
          ...at,
          ...(o !== undefined ? { objectId: o.id } : {}),
          message: `The ${region.slot} region has no picture yet`,
        })
      }
    }

    // ── Text ────────────────────────────────────────────────────────────
    let accentUses = 0
    let emDashes = 0
    for (const o of objects) {
      for (const body of bodiesOf(o)) {
        const where = {
          ...at,
          objectId: o.id,
          ...(body.cell !== undefined ? { cell: body.cell } : {}),
        }
        const all = body.paragraphs.map((p) => p.text).join('\n')
        for (const s of sentinels)
          if (hasWord(all, s))
            report('sentinel', { ...where, message: `Placeholder text "${s}" is still in` })
        // The pack's furniture is the pack's own: only its sentinels are the deck's business.
        if (o.role === 'furniture') continue

        const text = o.type === 'text' ? (o as TextObject) : undefined
        if ([...all].some((ch) => EMOJI.test(ch) && !NOT_EMOJI.has(ch)))
          report('emoji', { ...where, message: 'Contains an emoji' })

        // Colours: the box's and every run's.
        const colours = new Set<number>()
        const boxColour = text === undefined ? null : colorOf(text.color)
        if (boxColour !== null) colours.add(boxColour)
        let usesAccent = false
        for (const p of body.paragraphs)
          for (const r of p.runs) {
            const c = r.attributes?.color
            if (c !== undefined) colours.add(c)
          }
        for (const c of colours) {
          if (accent !== null && hex(c) === accent) usesAccent = true
          if (allowed.size > 0 && !allowed.has(hex(c)))
            report('text-color', {
              ...where,
              message: `Text in ${hex(c)}, not a text colour of the pack (${[...allowed].join(', ')})`,
            })
        }
        if (usesAccent) accentUses++

        // Caps, italics, underline.
        const styled = text?.textStyleId !== undefined
        if (text?.textTransform === 'uppercase' && (editorial.allCaps === 'forbid' || !styled))
          report('caps', {
            ...where,
            message:
              editorial.allCaps === 'forbid'
                ? 'Set in capitals; the pack has no capitals'
                : 'Set in capitals by hand; only the pack’s text styles set capitals',
          })
        if (CAPS_RUN.test(all))
          report('caps', { ...where, message: 'Typed in capitals; write it in normal case' })
        const italic =
          text?.italic === true ||
          body.paragraphs.some((p) => p.runs.some((r) => r.attributes?.italic))
        if (italic)
          report('italics', { ...where, message: 'Italic text; the pack sets no italics' })
        const underline =
          text?.underline === true ||
          body.paragraphs.some((p) => p.runs.some((r) => r.attributes?.underline))
        if (editorial.underline === 'forbid' && underline && o.hyperlink === undefined)
          report('typography', {
            ...where,
            message: 'Underlined text; the pack underlines nothing',
          })

        // Bullets: a paragraph's own glyph against its level's.
        if (text !== undefined)
          for (const p of body.paragraphs) {
            if (p.attrs.list !== 'bullet' || p.attrs.bulletChar === undefined) continue
            const expected = text.listLevels?.[p.attrs.level ?? 0]?.bulletChar
            if (expected !== undefined && expected !== p.attrs.bulletChar)
              report('bullet-glyph', {
                ...where,
                message: `Bullet "${p.attrs.bulletChar}"; the pack's is "${expected}"`,
              })
          }

        // Titles.
        if (o.role === 'title' || o.slot === 'title') {
          const t = all.trim()
          if (editorial.title.trailingPeriod === 'forbid' && /[^.]\.$/u.test(t))
            report('title-period', { ...where, message: 'The title ends with a period' })
          const words = t.split(/\s+/u).filter((w) => w.length > 0).length
          if (editorial.title.maxWords !== undefined && words > editorial.title.maxWords)
            report('title-period', {
              ...where,
              message: `The title has ${words} words; at most ${editorial.title.maxWords}`,
            })
        }

        // Size.
        if (
          text !== undefined &&
          editorial.minBodySize !== undefined &&
          o.role === 'body' &&
          [
            text.fontSize,
            ...body.paragraphs.flatMap((p) => p.runs.map((r) => r.attributes?.fontSize)),
          ]
            .filter((s): s is number => s !== undefined)
            .some((s) => s < editorial.minBodySize! - 0.5)
        )
          report('typography', {
            ...where,
            message: `Body text under ${editorial.minBodySize} px`,
          })

        // Typography.
        const ty = editorial.typography
        const issues: string[] = []
        if (/"/u.test(all) || /(?<![\p{L}])'|'(?![\p{L}])/u.test(all))
          issues.push(
            ty.quotes === 'de' ? 'straight quotes (use „…“)' : 'straight quotes (use “…”)',
          )
        if (ty.enDashRanges && /\d\s?-\s?\d/u.test(all)) issues.push('a hyphen in a range (use –)')
        if (ty.nbspBeforeUnits && UNIT_AFTER_SPACE.test(all))
          issues.push('a normal space before a unit (use a no-break space)')
        if (ty.ellipsis && all.includes('...')) issues.push('three dots (use …)')
        const dashes = (all.match(/—/gu) ?? []).length
        if (ty.emDash === 'forbid' && dashes > 0) issues.push('an em dash')
        emDashes += dashes
        if (issues.length > 0)
          report('typography', { ...where, message: `Has ${issues.join(', ')}` })
        for (const r of replacements)
          if (r.re.test(all))
            report(
              'typography',
              {
                ...where,
                message:
                  `Matches "${r.pattern}"` +
                  (r.with !== undefined ? ` (write "${r.with}")` : '') +
                  (r.note !== undefined ? `: ${r.note}` : ''),
              },
              r.level,
            )
      }
    }
    if (editorial.typography.emDash === 'sparingly' && emDashes > 1)
      report('typography', {
        ...at,
        message: `${emDashes} em dashes on one slide; use them sparingly`,
      })
    if (editorial.accentBudget !== undefined && accentUses > editorial.accentBudget.perSlide)
      report('accent-budget', {
        ...at,
        message: `${accentUses} text boxes in the accent colour; at most ${editorial.accentBudget.perSlide} per slide`,
      })
  }

  return {
    fitVerified,
    errors: findings.filter((f) => f.level === 'error').length,
    warnings: findings.filter((f) => f.level === 'warn').length,
    findings,
  }
}

/** A text box's line in px: its line height, else its line spacing on a normal line. */
function lineHeightPx(o: TextObject): number {
  if (o.lineHeight !== undefined) return o.fontSize * o.lineHeight
  return o.fontSize * 1.2 * (o.lineSpacing ?? 1)
}
