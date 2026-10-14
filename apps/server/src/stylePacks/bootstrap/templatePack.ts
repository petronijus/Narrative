/**
 * stylePacks/bootstrap/templatePack.ts — a style pack from a PowerPoint
 * template's masters (agentic A4.7): what the Fabrikam and Tailspin bootstraps share;
 * each brand configures it (`TemplateBrand`) with what a master cannot say —
 * which colour slot is which role, which typeface is which font, what each
 * layout is for.
 *
 *   - The first master is the canonical one; every further master is a
 *     value of the `theme` axis (Fabrikam: light and dark), its layouts paired
 *     by name. Colours stay scheme references: `tx1` is `role:text`, and
 *     the role resolves per variant — on Fabrikam's dark master `tx1` is white.
 *   - Each layout's placeholders become regions; `dt` / `ftr` / `sldNum`
 *     and the master's own shapes become furniture, a layout's own shapes
 *     its decor. Repeated placeholder groups (an agenda's ten rows, three
 *     cards) become numbered items.
 *   - Text levels (layout → master placeholder → `txStyles`) become text
 *     styles with list levels, deduplicated; points and EMU become canvas
 *     px.
 *   - Pictures the template draws (logos) are extracted into the pack's
 *     asset folder in the private overlay; formats a browser cannot draw
 *     (WMF, EMF) are recorded in `calls` instead.
 */

import type { ColorRef, FurnitureItem, PackLayout, PackRegion, StylePack } from '@narrative/shared'
import type {
  MasterLayout,
  MasterLevel,
  MasterPlaceholder,
  MasterReading,
  MasterShape,
  ReadColour,
  TemplateReading,
} from '../../pptx/masterReader.js'
import { CANVAS_H, CANVAS_W, StyleBook, frac, packId, px } from './common.js'

type ColorRole = NonNullable<
  keyof NonNullable<StylePack['tokens']['axes'][number]['values'][number]['roles']>
>

export interface TemplateBrand {
  id: string
  name: string
  /** Scheme slot → colour role (`tx1` → `text`, `accent6` → `accent`). */
  schemeRoles: Readonly<Record<string, ColorRole>>
  /** Names for the theme's colour slots that are pack colours (`accent6` → `red`). */
  colourNames: Readonly<
    Record<
      string,
      {
        id: string
        name: string
        group?: 'primary' | 'secondary' | 'accent' | 'neutral' | 'status'
      }
    >
  >
  /** Extra brand colours the theme does not hold. */
  extraColours?: StylePack['tokens']['colors']
  /** The theme axis's values, one per master in order. */
  variants: ReadonlyArray<{ id: string; name: string }>
  surfaces?: StylePack['tokens']['surfaces']
  /** A layout background (hex) that means a surface (Tailspin's blue cover). */
  surfaceByBackground?: Readonly<Record<string, string>>
  fonts: StylePack['fonts']
  /** Typeface (as the template names it, theme references resolved) → font id; bold variants via `boldFont`. */
  typefaces: Readonly<Record<string, string>>
  /** The font a bold level takes, per regular font id. */
  boldFont?: Readonly<Record<string, string>>
  /**
   * Bullet glyphs as a browser draws them: a symbol-font character (Tailspin's
   * Wingdings `§`, a square) → the Unicode glyph it shows.
   */
  glyphs?: Readonly<Record<string, string>>
  /** Layout name → pack layout id; names that map to the same id are one layout (variants of it). */
  layoutId: (name: string) => string | null
  /** Per pack layout id: its purpose sentence, family, and emphasis for items. */
  layouts: Readonly<
    Record<
      string,
      {
        purpose: string
        family?: string
        name?: string
        emphasis?: NonNullable<PackLayout['items']>['emphasis']
      }
    >
  >
  /** Placeholder text sizes at or under this (pt) mark a picture placeholder in a body (a logo slot). */
  logoSizePt?: number
  footer?: {
    template: string | Record<string, string>
    fields?: NonNullable<Extract<FurnitureItem, { kind: 'text' }>['fields']>
  }
  /** Shapes left out by name (markers, tool artefacts). */
  skipShape?: (shape: MasterShape) => boolean
  /** The grid, or how to measure it from the template's own layouts. */
  grid: StylePack['grid'] | ((reading: TemplateReading) => StylePack['grid'])
  chart: StylePack['tokens']['chart']
  editorial: StylePack['editorial']
  qa: Omit<StylePack['qa'], 'requiredFurniture'> & { requiredFurniture?: string[] }
  imagery?: StylePack['imagery']
  archetypeMap: StylePack['archetypeMap']
  provenance: StylePack['provenance']
}

export interface BootstrapResult {
  pack: StylePack
  /** Files the pack's assets name, relative to the private overlay root. */
  files: Record<string, Uint8Array>
}

const isPicture = (p: MasterPlaceholder, logoSizePt: number): boolean =>
  p.type === 'pic' || (p.type === 'body' && (p.levels[0]?.sizePt ?? 99) <= logoSizePt)

export async function templatePack(
  reading: TemplateReading,
  brand: TemplateBrand,
  media: (part: string) => Promise<Uint8Array | null>,
): Promise<BootstrapResult> {
  const { size } = reading
  const ptPx = CANVAS_W / (size.cx / 12_700)
  const emuPx = CANVAS_W / size.cx
  const files: Record<string, Uint8Array> = {}
  const calls: StylePack['provenance']['calls'] = [...brand.provenance.calls]
  const canonical = reading.masters[0]!
  if (reading.masters.length !== brand.variants.length)
    throw new Error(
      `${brand.id}: the template has ${reading.masters.length} masters, the brand names ${brand.variants.length} variants`,
    )

  // ── Colours: the canonical theme's named slots, plus the brand's extras ─
  const colors: StylePack['tokens']['colors'] = { ...brand.extraColours }
  const byHex = new Map<string, string>()
  for (const [id, c] of Object.entries(colors)) byHex.set(c.value.toLowerCase(), id)
  reading.masters.forEach((m, mi) => {
    for (const [slot, named] of Object.entries(brand.colourNames)) {
      const value = m.colours[slot]
      if (value === undefined || byHex.has(value)) continue
      // A slot another master fills with another colour (Fabrikam dark's accent1): named after its variant.
      const variant = brand.variants[mi]!
      const id = colors[named.id] === undefined ? named.id : `${named.id}-${packId(variant.id)}`
      const name = colors[named.id] === undefined ? named.name : `${named.name} (${variant.name})`
      colors[id] = { name, value, ...(named.group !== undefined ? { group: named.group } : {}) }
      byHex.set(value, id)
    }
  })
  const literal = (hex: string): ColorRef => {
    const id = byHex.get(hex.toLowerCase())
    if (id !== undefined) return `color:${id}` as ColorRef
    const nid = `c-${hex.slice(1).toLowerCase()}`
    colors[nid] = { name: hex.toUpperCase(), value: hex.toLowerCase() }
    byHex.set(hex.toLowerCase(), nid)
    return `color:${nid}` as ColorRef
  }
  /** A colour as the pack refers to it: its role when its slot is one, else a pack colour. */
  const colourRef = (c: ReadColour | undefined): ColorRef | undefined => {
    if (c === undefined) return undefined
    const role = c.scheme === undefined ? undefined : brand.schemeRoles[c.scheme]
    if (role !== undefined && c.alpha === undefined) return `role:${role}` as ColorRef
    return literal(c.hex)
  }
  /**
   * A text colour: as `colourRef`, except text set in the background slot
   * (white words on Tailspin's blue cover) — on a surface that redefines the
   * background it would vanish into it, so it keeps its colour.
   */
  const textRef = (c: ReadColour | undefined): ColorRef | undefined =>
    c?.scheme !== undefined && brand.schemeRoles[c.scheme] === 'background'
      ? literal(c.hex)
      : colourRef(c)

  // ── Variants: one per master ────────────────────────────────────────────
  const roleValues = (m: MasterReading) => {
    const roles: Partial<Record<ColorRole, ColorRef>> = {}
    for (const [slot, role] of Object.entries(brand.schemeRoles)) {
      if (roles[role] !== undefined) continue
      const hex = m.colours[slot]
      if (hex !== undefined) roles[role] = literal(hex)
    }
    return roles
  }
  const tokens: StylePack['tokens'] = {
    colors,
    axes: [
      {
        id: 'theme',
        name: 'Theme',
        default: brand.variants[0]!.id,
        values: reading.masters.map((m, i) => ({
          id: brand.variants[i]!.id,
          name: brand.variants[i]!.name,
          roles: roleValues(m),
        })),
      },
    ],
    ...(brand.surfaces !== undefined ? { surfaces: brand.surfaces } : {}),
    chart: brand.chart,
  }

  // ── Text styles ─────────────────────────────────────────────────────────
  const book = new StyleBook()
  const fontFor = (level: MasterLevel): string => {
    const tf = level.typeface ?? canonical.fonts.minor ?? ''
    const base = brand.typefaces[tf] ?? brand.typefaces['*'] ?? 'text'
    return level.bold === true ? (brand.boldFont?.[base] ?? base) : base
  }
  const styleOf = (base: string, levels: MasterLevel[], listed: boolean): string => {
    const l0 = levels[0] ?? {}
    const sizePt = l0.sizePt ?? 18
    const color = textRef(l0.colour) ?? 'role:text'
    const style: StylePack['textStyles'][string] = {
      name: base[0]!.toUpperCase() + base.slice(1).replace(/-/g, ' '),
      font: fontFor(l0),
      size: px(sizePt * ptPx),
      color,
      ...(l0.lineSpacing?.kind === 'pct'
        ? { lineSpacing: Math.round(l0.lineSpacing.value * 1000) / 1000 }
        : {}),
      ...(l0.lineSpacing?.kind === 'pts'
        ? { lineHeight: Math.round((l0.lineSpacing.value100 / 100 / sizePt) * 1000) / 1000 }
        : {}),
      ...(l0.caps === true ? { textTransform: 'uppercase' as const } : {}),
      ...(l0.align === 'center' || l0.align === 'right' ? { align: l0.align } : {}),
      ...(l0.spaceBeforePt ? { spaceBefore: px(l0.spaceBeforePt * ptPx) } : {}),
      ...(l0.spaceAfterPt ? { spaceAfter: px(l0.spaceAfterPt * ptPx) } : {}),
    }
    if (listed) {
      const count = Math.min(5, Math.max(1, levels.length))
      style.levels = []
      for (let i = 0; i < count; i++) {
        const l = levels[i] ?? levels[levels.length - 1] ?? {}
        const indent = px(Math.max(0, (l.marL ?? 0) * emuPx))
        const hanging = Math.min(indent, px(Math.max(0, -(l.indent ?? 0)) * emuPx))
        const kind =
          l.bullet?.kind === 'bullet' ? 'bullet' : l.bullet?.kind === 'numbered' ? 'number' : 'none'
        const bcolour = textRef(l.bullet?.colour)
        const font = fontFor(l)
        const lsize = l.sizePt === undefined ? undefined : px(l.sizePt * ptPx)
        const lcolour = textRef(l.colour)
        style.levels.push({
          list: kind,
          ...(kind === 'bullet'
            ? {
                bullet: {
                  glyph: brand.glyphs?.[l.bullet?.bulletChar ?? ''] ?? l.bullet?.bulletChar ?? '•',
                  ...(bcolour !== undefined && bcolour !== (lcolour ?? color)
                    ? { color: bcolour }
                    : {}),
                  ...(l.bullet?.sizePct !== undefined && l.bullet.sizePct !== 100
                    ? { scale: l.bullet.sizePct / 100 }
                    : {}),
                },
              }
            : {}),
          ...(kind === 'number' && l.bullet?.numberFormat !== undefined
            ? { numberFormat: l.bullet.numberFormat }
            : {}),
          indent,
          hanging,
          ...(l.spaceBeforePt !== undefined ? { spaceBefore: px(l.spaceBeforePt * ptPx) } : {}),
          ...(font !== style.font ? { font } : {}),
          ...(lsize !== undefined && lsize !== style.size ? { size: lsize } : {}),
          ...(lcolour !== undefined && lcolour !== color ? { color: lcolour } : {}),
        })
      }
      // A list whose levels say nothing is no list.
      if (style.levels.every((l) => l.list === 'none' && l.indent === 0)) delete style.levels
    }
    return book.add(base, style)
  }

  // ── Furniture: the canonical master's placeholders and shapes ───────────
  const items: StylePack['furniture']['items'] = {}
  const defaultSet: string[] = []
  const assets: StylePack['assets'] = {}
  const extracted = new Map<string, string>()
  const assetFor = async (shape: MasterShape): Promise<string | null> => {
    if (shape.image === undefined) return null
    const known = extracted.get(shape.image)
    if (known !== undefined) return known
    const ext = shape.image.split('.').pop()?.toLowerCase() ?? ''
    if (!['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      calls.push({
        topic: `Picture ${shape.name} (${shape.image})`,
        decision:
          'Left out: a browser cannot draw this format; upload a PNG or SVG of it into the folder',
      })
      return null
    }
    const bytes = await media(shape.image)
    if (bytes === null) return null
    const id = packId(`logo-${shape.name}`)
    const file = `packs/${brand.id}/${id}.${ext}`
    files[file] = bytes
    assets[id] = { name: shape.name, file: { file } }
    extracted.set(shape.image, id)
    return id
  }
  const furnitureItemFor = async (shape: MasterShape): Promise<FurnitureItem | null> => {
    if (brand.skipShape?.(shape) === true) return null
    if (shape.rect[2] <= 0 && shape.rect[3] <= 0) return null
    const rect = shape.rect.map(frac) as [number, number, number, number]
    if (shape.kind === 'pic') {
      const asset = await assetFor(shape)
      return asset === null ? null : { kind: 'image', rect, asset }
    }
    if (shape.geometry === 'line' || shape.kind === 'cxnSp') {
      const color = colourRef(shape.line?.colour)
      if (color === undefined) return null
      return {
        kind: 'rule',
        rect,
        color,
        width: Math.max(1, px((shape.line?.widthEmu ?? 12_700) * emuPx)),
      }
    }
    if (shape.text !== undefined) return null // text shapes: handled by the caller
    if (shape.geometry === undefined) {
      // A freeform (custGeom): no pack shape draws it; its outline would be a lie.
      if (!freeforms.includes(shape.name)) freeforms.push(shape.name)
      return null
    }
    const fill = colourRef(shape.fill)
    const stroke = colourRef(shape.line?.colour)
    if (fill === undefined && stroke === undefined) return null
    return {
      kind: 'shape',
      shape: shape.geometry === 'ellipse' ? 'ellipse' : 'rect',
      rect,
      ...(fill !== undefined ? { fill } : {}),
      ...(stroke !== undefined
        ? {
            stroke: {
              color: stroke,
              width: Math.max(1, px((shape.line?.widthEmu ?? 12_700) * emuPx)),
            },
          }
        : {}),
    }
  }

  const freeforms: string[] = []
  let pagination: StylePack['components'][number] | undefined
  const addFurniturePlaceholder = (p: MasterPlaceholder): string | null => {
    const rect = p.rect.map(frac) as [number, number, number, number]
    if (p.type === 'sldNum') {
      if (pagination === undefined) {
        pagination = {
          id: 'pagination',
          kind: 'pagination',
          name: 'Page number',
          objects: [
            {
              slot: 'pagenum',
              role: 'furniture',
              type: 'text',
              rect: [
                px(p.rect[0] * CANVAS_W),
                px(p.rect[1] * CANVAS_H),
                px(p.rect[2] * CANVAS_W),
                px(p.rect[3] * CANVAS_H),
              ],
              textStyle: styleOf('page-number', p.levels, false),
              isSlideNumber: true,
            },
          ],
        }
        items['pagenum'] = { kind: 'pageNumber', component: 'pagination' }
      }
      return 'pagenum'
    }
    if (p.type === 'ftr') {
      items['footer'] ??= {
        kind: 'text',
        rect,
        textStyle: styleOf('footer', p.levels, false),
        template: brand.footer?.template ?? '{footer}',
        fields: brand.footer?.fields ?? { footer: { required: true } },
      }
      return 'footer'
    }
    if (p.type === 'dt') {
      items['date'] ??= {
        kind: 'text',
        rect,
        textStyle: styleOf('footer', p.levels, false),
        template: '{date}',
        fields: { date: { required: true } },
      }
      return 'date'
    }
    return null
  }
  for (const p of canonical.placeholders) {
    const id = addFurniturePlaceholder(p)
    if (id !== null && !defaultSet.includes(id)) defaultSet.push(id)
  }
  // The master's own shapes: a page-number text, a classification mark, logos.
  for (const shape of canonical.shapes) {
    if (brand.skipShape?.(shape) === true) continue
    if (shape.text !== undefined) {
      const rect = shape.rect.map(frac) as [number, number, number, number]
      if (/‹(Nr\.|#)›|<#>/.test(shape.text)) {
        if (pagination === undefined) {
          pagination = {
            id: 'pagination',
            kind: 'pagination',
            name: 'Page number',
            objects: [
              {
                slot: 'pagenum',
                role: 'furniture',
                type: 'text',
                rect: [
                  px(shape.rect[0] * CANVAS_W),
                  px(shape.rect[1] * CANVAS_H),
                  px(shape.rect[2] * CANVAS_W),
                  px(shape.rect[3] * CANVAS_H),
                ],
                textStyle: styleOf('page-number', shape.levels ?? canonical.txStyles.other, false),
                isSlideNumber: true,
              },
            ],
          }
          items['pagenum'] = { kind: 'pageNumber', component: 'pagination' }
        }
        if (!defaultSet.includes('pagenum')) defaultSet.push('pagenum')
        continue
      }
      // A fixed text the master prints (a classification mark): a field with that default.
      const id = packId(shape.name.replace(/^MSIPCM.*/, 'classification'))
      items[id] = {
        kind: 'text',
        rect,
        textStyle: styleOf('classification', shape.levels ?? canonical.txStyles.other, false),
        template: `{${id.replace(/-/g, '')}}`,
        fields: { [id.replace(/-/g, '')]: { default: shape.text } },
      }
      defaultSet.push(id)
      continue
    }
    const item = await furnitureItemFor(shape)
    if (item === null) continue
    const id = packId(item.kind === 'image' ? 'logo' : shape.name)
    items[id] = item
    defaultSet.push(id)
  }

  // ── Layouts ─────────────────────────────────────────────────────────────
  const logoSize = brand.logoSizePt ?? 2
  const swappedLayouts: string[] = []
  const layouts: PackLayout[] = []
  const seen = new Map<string, PackLayout>()
  for (const ml of canonical.layouts) {
    const id = brand.layoutId(ml.name)
    if (id === null) continue
    if (seen.has(id)) {
      seen.get(id)!.aliases = [...new Set([...(seen.get(id)!.aliases ?? []), ml.name])].slice(0, 16)
      continue
    }
    const config = brand.layouts[id]
    if (config === undefined)
      throw new Error(`${brand.id}: no purpose for layout '${id}' (${ml.name})`)
    const layout = await layoutOf(ml, id, config)
    seen.set(id, layout)
    layouts.push(layout)
  }
  // Pair names across masters, for the record.
  for (const m of reading.masters.slice(1))
    for (const ml of m.layouts) {
      const id = brand.layoutId(ml.name)
      const l = id === null ? undefined : seen.get(id)
      if (l !== undefined && !(l.aliases ?? []).includes(ml.name))
        l.aliases = [...(l.aliases ?? []), ml.name].slice(0, 16)
    }

  async function layoutOf(
    ml: MasterLayout,
    id: string,
    config: TemplateBrand['layouts'][string],
  ): Promise<PackLayout> {
    const furniture: string[] = ml.showMasterShapes
      ? defaultSet.filter((f) => !['pagenum', 'footer', 'date'].includes(f))
      : []
    const content: MasterPlaceholder[] = []
    for (const p of ml.placeholders) {
      const fid = addFurniturePlaceholder(p)
      if (fid !== null) {
        if (!furniture.includes(fid)) furniture.push(fid)
        continue
      }
      content.push(p)
    }
    // A master that prints its page number as a shape puts it on every layout that shows master shapes.
    if (
      ml.showMasterShapes &&
      defaultSet.includes('pagenum') &&
      !furniture.includes('pagenum') &&
      canonical.placeholders.every((p) => p.type !== 'sldNum')
    )
      furniture.push('pagenum')

    // A divider that sets its small line as the title and its big words as
    // the subtitle (Fabrikam's divider): the big text is the slide's title.
    const titlePh = content.find((p) => p.type === 'title' || p.type === 'ctrTitle')
    const subPh = content.find((p) => p.type === 'subTitle')
    const swapped =
      titlePh !== undefined &&
      subPh !== undefined &&
      (subPh.levels[0]?.sizePt ?? 0) > 1.5 * (titlePh.levels[0]?.sizePt ?? 0)
    if (swapped && !swappedLayouts.includes(ml.name)) swappedLayouts.push(ml.name)
    const typeOf = (p: MasterPlaceholder): string =>
      swapped && p === titlePh ? 'subTitle' : swapped && p === subPh ? 'title' : p.type

    // Repeated groups: placeholders of one kind and text size whose boxes
    // match within ~1 % of the canvas (masters round their widths
    // differently from column to column), occurring k ≥ 2 times in step
    // with others → k items.
    const groups = new Map<string, MasterPlaceholder[]>()
    const groupOf: Array<{ key: string; pic: boolean; size: number; w: number; h: number }> = []
    for (const p of content) {
      if (p.type === 'title' || p.type === 'ctrTitle') continue
      const pic = isPicture(p, logoSize)
      const size = p.levels[0]?.sizePt ?? 0
      let g = groupOf.find(
        (x) =>
          x.pic === pic &&
          x.size === size &&
          Math.abs(x.w - p.rect[2]) <= 0.012 &&
          Math.abs(x.h - p.rect[3]) <= 0.012,
      )
      if (g === undefined) {
        g = {
          key: `${pic ? 'pic' : 'txt'}:${groupOf.length}`,
          pic,
          size,
          w: p.rect[2],
          h: p.rect[3],
        }
        groupOf.push(g)
      }
      groups.set(g.key, [...(groups.get(g.key) ?? []), p])
    }
    const counts = [...groups.values()].map((g) => g.length).filter((n) => n >= 2)
    const itemCount = counts.length === 0 ? 0 : Math.max(...counts)
    const itemGroups = [...groups.entries()].filter(
      ([, g]) => g.length === itemCount && itemCount >= 2,
    )
    const item = new Map<MasterPlaceholder, number>()
    const part = new Map<MasterPlaceholder, string>()
    if (itemGroups.length > 0) {
      // Anchor: the group read first; items in reading order (columns of a
      // long two-column list read down, everything else across).
      const [, anchor] = itemGroups.reduce((a, b) =>
        Math.min(...a[1].map((p) => p.rect[1] * 10 + p.rect[0])) <=
        Math.min(...b[1].map((p) => p.rect[1] * 10 + p.rect[0]))
          ? a
          : b,
      )
      const xs = [...new Set(anchor.map((p) => Math.round(p.rect[0] * 50)))]
      const ys = [...new Set(anchor.map((p) => Math.round(p.rect[1] * 50)))]
      const columnMajor = xs.length <= 2 && ys.length >= 3
      const ordered = [...anchor].sort((a, b) =>
        columnMajor
          ? a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1]
          : Math.round(a.rect[1] * 50) - Math.round(b.rect[1] * 50) || a.rect[0] - b.rect[0],
      )
      ordered.forEach((p, i) => item.set(p, i + 1))
      const centre = (p: MasterPlaceholder) => [
        p.rect[0] + p.rect[2] / 2,
        p.rect[1] + p.rect[3] / 2,
      ]
      for (const [, g] of itemGroups) {
        if (g === anchor) continue
        const free = new Set(ordered)
        for (const p of [...g].sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
          let best: MasterPlaceholder | undefined
          let dist = Infinity
          const [cx, cy] = centre(p)
          for (const a of free) {
            const [ax, ay] = centre(a)
            const d = (ax! - cx!) ** 2 + (ay! - cy!) ** 2
            if (d < dist) {
              dist = d
              best = a
            }
          }
          if (best === undefined) continue
          free.delete(best)
          item.set(p, item.get(best)!)
        }
      }
      // Part names: pictures; then text by size and height.
      const textGroups = itemGroups.filter(([k]) => k.startsWith('txt')).map(([, g]) => g)
      const meta = textGroups.map((g) => ({
        g,
        size: g[0]!.levels[0]?.sizePt ?? 0,
        h: g[0]!.rect[3],
        w: g[0]!.rect[2],
      }))
      const maxRest = (m: (typeof meta)[number]) =>
        Math.max(0, ...meta.filter((x) => x !== m).map((x) => x.size))
      const number = meta.find((m) => meta.length >= 2 && m.size >= 2 * maxRest(m) && m.w <= 0.25)
      const rest = meta.filter((m) => m !== number).sort((a, b) => a.h - b.h)
      if (number !== undefined) for (const p of number.g) part.set(p, 'number')
      rest.forEach((m, i) => {
        const name =
          rest.length === 1
            ? 'text'
            : i === 0
              ? 'heading'
              : i === rest.length - 1
                ? 'text'
                : `text-${i}`
        for (const p of m.g) part.set(p, name)
      })
      for (const [k, g] of itemGroups)
        if (k.startsWith('pic')) for (const p of g) part.set(p, 'picture')
    }

    const regions: PackRegion[] = []
    const used = new Set<string>()
    const slotName = (base: string) => {
      let s = base
      for (let n = 2; used.has(s); n++) s = `${base}-${n}`
      used.add(s)
      return s
    }
    // A thin single line just under the title is its message: a subtitle
    // (Tailspin's message line, Fabrikam's subline).
    const messageLine = (p: MasterPlaceholder): boolean =>
      titlePh !== undefined &&
      p.type === 'body' &&
      !item.has(p) &&
      !isPicture(p, logoSize) &&
      p.rect[3] <= 0.09 &&
      p.rect[1] > titlePh.rect[1] &&
      p.rect[1] - (titlePh.rect[1] + titlePh.rect[3]) < 0.06
    // The largest single text body is the body; others by size.
    const singles = content.filter(
      (p) =>
        !messageLine(p) &&
        !item.has(p) &&
        !isPicture(p, logoSize) &&
        p.type !== 'title' &&
        p.type !== 'ctrTitle' &&
        p.type !== 'subTitle' &&
        p.type !== 'tbl' &&
        p.type !== 'chart',
    )
    const mainBody = singles.reduce<MasterPlaceholder | undefined>(
      (a, b) => (a === undefined || b.rect[2] * b.rect[3] > a.rect[2] * a.rect[3] ? b : a),
      undefined,
    )
    const ordered = [...content].sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
    for (const p of ordered) {
      const n = item.get(p)
      const picture = isPicture(p, logoSize)
      const isTitle = typeOf(p) === 'title' || typeOf(p) === 'ctrTitle'
      let role: PackRegion['role']
      let base: string
      if (picture) {
        role = 'picture'
        base = (p.levels[0]?.sizePt ?? 99) <= logoSize && p.type !== 'pic' ? 'logo' : 'picture'
      } else if (p.type === 'tbl') {
        role = 'table'
        base = 'table'
      } else if (p.type === 'chart') {
        role = 'chart'
        base = 'chart'
      } else if (isTitle) {
        role = 'title'
        base = 'title'
      } else if (typeOf(p) === 'subTitle' || messageLine(p)) {
        role = 'subtitle'
        base = 'subtitle'
      } else if (n !== undefined) {
        role = part.get(p) === 'number' ? 'caption' : 'body'
        base = part.get(p) ?? 'text'
      } else if (p === mainBody) {
        role = 'body'
        base = 'body'
      } else {
        const bodySize = mainBody?.levels[0]?.sizePt ?? 16
        const s = p.levels[0]?.sizePt ?? bodySize
        role = s > bodySize ? 'subtitle' : s < bodySize * 0.8 ? 'caption' : 'body'
        base = role === 'subtitle' ? 'subtitle' : role === 'caption' ? 'caption' : 'text'
      }
      const slot = slotName(n !== undefined ? `${base}-${n}` : base)
      const type: PackRegion['type'] = picture
        ? 'image'
        : p.type === 'tbl'
          ? 'table'
          : p.type === 'chart'
            ? 'chart'
            : 'text'
      const region: PackRegion = {
        slot,
        role,
        type,
        rect: p.rect.map(frac) as [number, number, number, number],
        ...(n !== undefined ? { item: n } : {}),
      }
      if (type === 'text') {
        const listed = p.levels.some(
          (l) => l?.bullet?.kind === 'bullet' || l?.bullet?.kind === 'numbered',
        )
        region.textStyle = styleOf(isTitle ? 'title' : base.replace(/-\d+$/, ''), p.levels, listed)
        if (p.anchor === 'middle' || p.anchor === 'bottom') region.anchor = p.anchor
        region.autofit =
          p.autofit === 'shape' && (p.anchor ?? 'top') === 'top'
            ? 'grow-down'
            : p.autofit === 'normal'
              ? 'shrink'
              : 'fixed'
        const ins = [p.insets.l, p.insets.t, p.insets.r, p.insets.b].map((v) => px(v * emuPx)) as [
          number,
          number,
          number,
          number,
        ]
        if (ins.some((v) => v > 0)) region.insets = ins
        if (isTitle) region.required = true
      } else if (type === 'image') {
        region.focus = 'center'
      }
      regions.push(region)
    }

    const decor: FurnitureItem[] = []
    for (const shape of ml.shapes) {
      if (brand.skipShape?.(shape) === true) continue
      if (shape.text !== undefined) {
        // A fixed text the layout prints (a claim): drawn as it stands.
        decor.push({
          kind: 'text',
          rect: shape.rect.map(frac) as [number, number, number, number],
          textStyle: styleOf('decor-text', shape.levels ?? canonical.txStyles.other, false),
          template: shape.text.replace(/[{}]/g, ''),
        })
        continue
      }
      const d = await furnitureItemFor(shape)
      if (d !== null) decor.push(d)
    }
    const background = ml.background
    const surfaceId =
      background === undefined
        ? undefined
        : brand.surfaceByBackground?.[background.hex.toLowerCase()]
    const layout: PackLayout = {
      id,
      name: config.name ?? ml.name.replace(/\s*\((\d+ Punkte|\d+ active)\)\s*$/i, '').trim(),
      aliases: [ml.name],
      family: config.family ?? id,
      purpose: config.purpose,
      ...(surfaceId !== undefined ? { surface: { fixed: surfaceId } } : {}),
      ...(background !== undefined && surfaceId === undefined && background.scheme !== 'bg1'
        ? { background: colourRef(background)! }
        : {}),
      regions,
      ...(itemCount >= 2
        ? {
            items: {
              count: itemCount,
              ...(config.emphasis !== undefined ? { emphasis: config.emphasis } : {}),
            },
          }
        : {}),
      furniture,
      ...(decor.length > 0 ? { decor } : {}),
    }
    return layout
  }

  if (freeforms.length > 0)
    calls.push({
      topic: 'Freeform decoration',
      decision: `Left out: ${freeforms.join(', ')}`,
      why: 'A freeform outline is no rectangle or ellipse; drawn as one it would misrepresent the brand. Upload it as a picture into the folder if a layout needs it.',
    })
  if (swappedLayouts.length > 0)
    calls.push({
      topic: 'Dividers with inverted placeholders',
      decision: `The larger text is the title: ${swappedLayouts.join(', ')}`,
      why: 'These layouts set the short line as TITLE and the big words as SUBTITLE; a model fills the title first.',
    })
  const pack: StylePack = {
    schemaVersion: 1,
    id: brand.id,
    name: brand.name,
    canvas: { width: CANVAS_W, height: CANVAS_H },
    tokens,
    fonts: brand.fonts,
    textStyles: book.styles,
    grid: typeof brand.grid === 'function' ? brand.grid(reading) : brand.grid,
    furniture: { defaultSet: defaultSet.filter((f) => items[f] !== undefined), items },
    assets,
    layouts,
    components: pagination === undefined ? [] : [pagination],
    ...(brand.imagery !== undefined ? { imagery: brand.imagery } : {}),
    editorial: brand.editorial,
    qa: {
      ...brand.qa,
      requiredFurniture: (brand.qa.requiredFurniture ?? []).filter((f) => items[f] !== undefined),
    },
    archetypeMap: brand.archetypeMap,
    provenance: { ...brand.provenance, calls },
  }
  return { pack, files }
}
