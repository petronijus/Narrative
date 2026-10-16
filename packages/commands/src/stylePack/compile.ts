/**
 * stylePack/compile.ts — a style pack made the folder's own building blocks
 * (agentic A4.4, `style.pack.edit { op: 'compile' }`): what the folder's
 * tokens and component masters must become. Pure — the server's service
 * (and the test fakes) write the result; compiling twice changes nothing.
 *
 *   - every pack colour → a colour token (`origin` color:<id>);
 *   - every colour role the pack uses → a colour token that takes its value
 *     per deck variant on the axis governing the role (`byVariant`) and per
 *     surface (`bySurface`) — "Text" is dark blue on one variant, white on
 *     another (decided 2026-10-12) (`origin` role:<role>);
 *   - a literal colour a style or component names → a colour token of its
 *     own (`origin` literal:<hex>);
 *   - every text style → a text-style token: family, weight and width from
 *     its font, list levels, its colour as a token reference (`origin`
 *     textStyle:<id>);
 *   - every component → a master (A4.4 masters carry `origin` in their
 *     document's `meta`).
 *
 * A token or master is the pack's when its `origin.pack` is the pack's id:
 * only those are updated; tokens and masters people made are never touched.
 * A pack text style whose name a hand-made style already has is named
 * "<name> (<pack name>)", since styles are applied by name.
 */

import type { ColorRef, ColorRole, PackComponent, SlideObject, StylePack } from '@narrative/shared'
import type {
  ColorTokenSnapshot,
  FolderTokensSnapshot,
  TextStyleLevel,
  TextStyleTokenSnapshot,
  TokenOrigin,
} from '@narrative/slide-model'
import type { FontFaceWeight } from '../text/fontWeights.js'
import { textStyleFields } from '../text/textStyle.js'

/** A token the compile writes. */
export interface CompiledToken {
  /** The token's id: the pack's earlier one, or the id to create it under. */
  id: string
  /** True: the folder holds it (an earlier compile made it) — update it. */
  exists: boolean
  origin: TokenOrigin
  fields: Record<string, unknown>
}

/** The id a compile creates a token under: stable per pack and key, so references can be made before it exists. */
export function compiledTokenId(packId: string, key: string): string {
  return `p-${packId}-${key}`.replace(/[^A-Za-z0-9_-]/g, '-')
}

export interface CompiledComponent {
  origin: TokenOrigin
  name: string
  /** The master's objects, ids local to it. */
  objects: SlideObject[]
}

export interface StylePackCompilation {
  colors: CompiledToken[]
  textStyles: CompiledToken[]
  components: CompiledComponent[]
  /** "Family weight" faces the pack names that the folder does not hold. */
  missingFonts: string[]
}

const ROLE_NAMES: Readonly<Record<ColorRole, string>> = {
  background: 'Background',
  surface: 'Surface',
  text: 'Text',
  textSecondary: 'Text secondary',
  textMuted: 'Text muted',
  line: 'Line',
  accent: 'Accent',
  onAccent: 'On accent',
}

function originKey(o: TokenOrigin | undefined): string | undefined {
  return o === undefined ? undefined : `${o.pack} ${o.key}`
}

/** Id of a token the folder holds for this origin (the pack made it before). */
function earlier<T extends { origin?: TokenOrigin }>(
  tokens: Record<string, T>,
  origin: TokenOrigin,
): string | undefined {
  const key = originKey(origin)
  return Object.entries(tokens).find(([, t]) => originKey(t.origin) === key)?.[0]
}

/** Every colour reference anywhere in a value. */
function collectRefs(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (/^(role:[A-Za-z]+|color:[a-z][a-z0-9-]*|#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?)$/.test(value))
      into.add(value)
  } else if (Array.isArray(value)) value.forEach((v) => collectRefs(v, into))
  else if (typeof value === 'object' && value !== null)
    Object.values(value).forEach((v) => collectRefs(v, into))
}

export function compileStylePack(
  pack: StylePack,
  current: { tokens: FolderTokensSnapshot; fonts: ReadonlyArray<FontFaceWeight> | null },
): StylePackCompilation {
  const id = pack.id
  const origin = (key: string): TokenOrigin => ({ pack: id, key })

  // ── Colours ─────────────────────────────────────────────────────────────
  /** A literal or pack colour as hex; a role is not a hex. */
  const hexOf = (ref: string): string | undefined =>
    ref.startsWith('#')
      ? ref.toLowerCase()
      : ref.startsWith('color:')
        ? pack.tokens.colors[ref.slice(6)]?.value.toLowerCase()
        : undefined

  const colors: CompiledToken[] = []
  const colorTokenIds = new Map<string, string>() // ref → token id (existing or planned)
  const plan = (o: TokenOrigin, fields: Record<string, unknown>): CompiledToken => {
    const existingId = earlier<ColorTokenSnapshot>(current.tokens.colors, o)
    return {
      id: existingId ?? compiledTokenId(id, o.key),
      exists: existingId !== undefined,
      origin: o,
      fields,
    }
  }
  const tokenIdFor = (t: CompiledToken): string => t.id

  for (const [cid, c] of Object.entries(pack.tokens.colors)) {
    const t = plan(origin(`color:${cid}`), { name: c.name, value: c.value.toLowerCase() })
    colors.push(t)
    colorTokenIds.set(`color:${cid}`, tokenIdFor(t))
  }

  // What a laid-out slide needs whether or not a style names it: its
  // background, the text colour, and the placeholder colour of empty slots.
  const used = new Set<string>(['role:background', 'role:text'])
  if (pack.tokens.axes.some((a) => a.values.some((v) => v.roles.textMuted !== undefined)))
    used.add('role:textMuted')
  collectRefs({ textStyles: pack.textStyles, components: pack.components }, used)
  collectRefs(pack.layouts, used)
  collectRefs(pack.furniture, used)
  // A logo per role value is chosen by the colour its keys name: they are drawn with.
  for (const asset of Object.values(pack.assets))
    for (const key of Object.keys(asset.byRole?.files ?? {})) collectRefs(key, used)

  // Axis values layouts pin as their surface (a declared surface of that id wins).
  const pinnedValues = new Set<string>()
  for (const layout of pack.layouts) {
    const surface = layout.surface
    if (surface === undefined) continue
    for (const id of 'fixed' in surface ? [surface.fixed] : surface.choose)
      if (pack.tokens.surfaces?.[id] === undefined) pinnedValues.add(id)
  }

  for (const ref of used) {
    if (ref.startsWith('role:')) {
      const role = ref.slice(5) as ColorRole
      const axis = pack.tokens.axes.find((a) => a.values.some((v) => v.roles[role] !== undefined))
      if (axis === undefined) continue
      const values: Record<string, string> = {}
      for (const v of axis.values) {
        const hex = v.roles[role] !== undefined ? hexOf(v.roles[role]!) : undefined
        if (hex !== undefined) values[v.id] = hex
      }
      const bySurface: Record<string, string> = {}
      for (const [sid, s] of Object.entries(pack.tokens.surfaces ?? {})) {
        const hex = s.roles[role] !== undefined ? hexOf(s.roles[role]!) : undefined
        if (hex !== undefined) bySurface[sid] = hex
      }
      // A layout may pin a value of this axis as its surface (Contoso's chart
      // slide is always Digital Cobalt): there the role takes that value's
      // colour, whatever the deck's variant. Declared surfaces win.
      for (const id of pinnedValues)
        if (bySurface[id] === undefined && values[id] !== undefined) bySurface[id] = values[id]
      const value = values[axis.default] ?? Object.values(values)[0]
      if (value === undefined) continue
      const t = plan(origin(`role:${role}`), {
        name: ROLE_NAMES[role],
        value,
        byVariant: { axis: axis.id, values },
        ...(Object.keys(bySurface).length > 0 ? { bySurface } : {}),
      })
      colors.push(t)
      colorTokenIds.set(ref, tokenIdFor(t))
    } else if (ref.startsWith('#')) {
      const hex = ref.toLowerCase()
      const t = plan(origin(`literal:${hex}`), { name: hex, value: hex })
      colors.push(t)
      colorTokenIds.set(ref, tokenIdFor(t))
    }
  }

  /** A pack colour reference as a token reference (`colors.<id>`; a new id is resolved by the writer). */
  const tokenRef = (ref: ColorRef | undefined): { $token: string } | undefined => {
    if (ref === undefined) return undefined
    const tid = colorTokenIds.get(ref)
    return tid === undefined ? undefined : { $token: `colors.${tid}` }
  }

  // ── Text styles ─────────────────────────────────────────────────────────
  const handMadeNames = new Set(
    Object.values(current.tokens.textStyles)
      .filter((s) => s.origin?.pack !== id)
      .map((s) => s.name.trim().toLowerCase()),
  )
  const textStyles: CompiledToken[] = []
  const styleTokenIds = new Map<string, string>()
  for (const [sid, s] of Object.entries(pack.textStyles)) {
    const font = pack.fonts[s.font]!
    const levels: TextStyleLevel[] | undefined = s.levels?.map((l) => {
      const level: TextStyleLevel = { list: l.list, indent: l.indent, hanging: l.hanging }
      if (l.bullet !== undefined) {
        level.bulletChar = l.bullet.glyph
        const bc = tokenRef(l.bullet.color)
        if (bc !== undefined) level.bulletColor = bc
        if (l.bullet.scale !== undefined) level.bulletScale = l.bullet.scale
      }
      if (l.numberFormat !== undefined) level.numberFormat = l.numberFormat
      if (l.spaceBefore !== undefined) level.spaceBefore = l.spaceBefore
      if (l.font !== undefined) level.fontFamily = pack.fonts[l.font]!.family
      if (l.weight !== undefined) level.fontWeight = l.weight
      else if (l.font !== undefined) level.fontWeight = pack.fonts[l.font]!.weight
      if (l.size !== undefined) level.fontSize = l.size
      const c = tokenRef(l.color)
      if (c !== undefined) level.color = c
      if (l.lineSpacing !== undefined) level.lineSpacing = l.lineSpacing
      return level
    })
    const name = handMadeNames.has(s.name.trim().toLowerCase())
      ? `${s.name} (${pack.name})`
      : s.name
    const stretch = s.stretch ?? font.stretch
    const color = tokenRef(s.color)
    const fields: Record<string, unknown> = {
      name,
      family: font.family,
      weight: s.weight ?? font.weight,
      size: s.size,
      ...(s.minSize !== undefined ? { minSize: s.minSize } : {}),
      ...(stretch !== undefined && stretch !== 100 ? { fontStretch: stretch } : {}),
      ...(s.lineHeight !== undefined ? { lineHeight: s.lineHeight } : {}),
      ...(s.lineSpacing !== undefined ? { lineSpacing: s.lineSpacing } : {}),
      ...(s.letterSpacing !== undefined ? { letterSpacing: s.letterSpacing } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(s.textTransform !== undefined ? { textTransform: s.textTransform } : {}),
      ...(s.align !== undefined ? { align: s.align } : {}),
      ...(s.spaceBefore !== undefined ? { paragraphSpaceBefore: s.spaceBefore } : {}),
      ...(s.spaceAfter !== undefined ? { paragraphSpaceAfter: s.spaceAfter } : {}),
      ...(levels !== undefined ? { levels } : {}),
    }
    const o = origin(`textStyle:${sid}`)
    const existingId = earlier<TextStyleTokenSnapshot>(current.tokens.textStyles, o)
    const t: CompiledToken = {
      id: existingId ?? compiledTokenId(id, o.key),
      exists: existingId !== undefined,
      origin: o,
      fields,
    }
    textStyles.push(t)
    styleTokenIds.set(sid, t.id)
  }

  // ── Components ──────────────────────────────────────────────────────────
  const components = pack.components.map((c) =>
    compileComponent(pack, c, origin(`component:${c.id}`), tokenRef, styleTokenIds),
  )

  // ── Fonts the folder lacks ──────────────────────────────────────────────
  const missingFonts: string[] = []
  for (const f of Object.values(pack.fonts)) {
    const faces = (current.fonts ?? []).filter((x) => x.family === f.family)
    const covers = faces.some((x) => {
      const wght = x.axes?.wght
      return wght !== undefined ? f.weight >= wght[0] && f.weight <= wght[1] : x.weight === f.weight
    })
    if (!covers) missingFonts.push(`${f.family} ${f.weight}`)
  }

  return { colors, textStyles, components, missingFonts: [...new Set(missingFonts)] }
}

/** A pack component as master objects (text linked to its compiled style). */
function compileComponent(
  pack: StylePack,
  c: PackComponent,
  origin: TokenOrigin,
  tokenRef: (ref: ColorRef | undefined) => { $token: string } | undefined,
  styleTokenIds: ReadonlyMap<string, string>,
): CompiledComponent {
  const objects = c.objects.map((o, i): SlideObject => {
    const [x, y, width, height] = o.rect
    const base = {
      id: `${c.id}-${i + 1}`,
      x,
      y,
      width,
      height,
      rotation: 0,
      opacity: 1,
      name: o.slot,
      slot: o.slot,
      role: o.role,
    }
    if (o.type === 'text') {
      const style = o.textStyle !== undefined ? pack.textStyles[o.textStyle] : undefined
      const font = style !== undefined ? pack.fonts[style.font] : undefined
      const styleId = o.textStyle !== undefined ? styleTokenIds.get(o.textStyle) : undefined
      return {
        ...base,
        type: 'text',
        text: o.text ?? (o.isSlideNumber === true ? '#' : o.slot),
        fontSize: style?.size ?? 32,
        fontWeight: (style?.weight ?? font?.weight ?? 400) as 400,
        color: tokenRef(style?.color) ?? 0,
        align: style?.align ?? 'left',
        ...(font !== undefined ? { fontFamily: font.family } : {}),
        ...(styleId !== undefined ? { textStyleId: styleId, textStyleOverrides: [] } : {}),
        ...(o.autofit === 'grow-down' ? { autofit: 'grow-down' } : {}),
        ...(o.isSlideNumber === true ? { isSlideNumber: true } : {}),
      } as SlideObject
    }
    const fill = tokenRef(o.fill)
    const stroke = o.stroke !== undefined ? tokenRef(o.stroke.color) : undefined
    return {
      ...base,
      type: 'rectangle',
      fill: fill ?? 0xcccccc,
      // A picture slot is a placeholder until a picture fills it.
      ...(o.type === 'image' ? { fillAlpha: 0.2 } : {}),
      ...(o.radius !== undefined && o.radius > 0 ? { cornerRadius: o.radius } : {}),
      ...(stroke !== undefined && o.stroke !== undefined
        ? { stroke, strokeWidth: o.stroke.width }
        : {}),
    } as SlideObject
  })
  return { origin, name: c.name, objects }
}

/**
 * The style fields a compiled master's linked text takes, once the style's
 * token ids are known: `textStyleFields` of the written style.
 */
export function linkedTextFields(
  style: TextStyleTokenSnapshot,
  tokens: FolderTokensSnapshot,
): Record<string, unknown> {
  return textStyleFields(style, tokens)
}
