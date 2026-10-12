/**
 * stylePack/layout.ts — a slide laid out with a pack layout (agentic A4.4):
 * what `slide.applyLayout` and `style.deck.apply` write. Pure: the plan
 * names the objects to update, add and remove, the slide's background and
 * its layout reference; the commands execute it with the slide-model
 * writers.
 *
 *   - Every region becomes an object at its rect with `slot` and `role`:
 *     text linked to the region's compiled text style (A4.4 compile; its
 *     fields as text.style.apply writes them), with the region's autofit,
 *     anchor and alignment; a picture, or a placeholder until one is given;
 *     a component's objects at the region's origin (drawn from the pack's
 *     component, as its master holds them).
 *   - Content: given per slot, or carried over from the slide's earlier
 *     layout — the object in the same slot is updated in place (its id,
 *     and so its animations, stay); else the content of an object with the
 *     same role moves into the new region.
 *   - Furniture (the layout's set, else the pack's default) and the
 *     layout's decor are regenerated: `role: 'furniture'`, the item id as
 *     `slot` (`decor-<n>` for decor). Template fields come from the deck's
 *     meta; `{page}` alone is a live page number, inside other text the
 *     slide's number when laid out (style.deck.apply renews it).
 *   - Colours are references to the colour tokens the compile made, so a
 *     variant switch is one deck-meta write; the slide background is the
 *     layout's, resolved on the deck's variant and the slide's surface.
 *
 * Objects people added without a `slot` are never touched.
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type ColorRef,
  type DeckMeta,
  type FurnitureItem,
  type PackLayout,
  type PackRegion,
  type SlideBackground,
  type SlideLayoutRef,
  type SlideObject,
  type StylePack,
} from '@narrative/shared'
import {
  getObjectTypeDef,
  parseHexColor,
  resolveTokenValue,
  toDelta,
  type FolderTokensSnapshot,
  type RichDeltaOp,
  type TextStyleTokenSnapshot,
} from '@narrative/slide-model'
import { CommandError } from '../errors.js'
import { compiledTokenId, compileStylePack } from './compile.js'
import {
  planFromBody,
  planText,
  planToDelta,
  type BodyPlan,
  type TextBodyInput,
} from '../text/body.js'
import { textStyleFields } from '../text/textStyle.js'

/** What a slot is filled with: text (plain or paragraphs) or a picture. */
export type SlotContent = TextBodyInput | { assetId: string }

export interface LayoutPlan {
  /** In place (ids kept); `body` replaces the text. */
  update: Array<{ id: string; patch: Record<string, unknown>; body?: BodyPlan }>
  add: SlideObject[]
  remove: string[]
  background: SlideBackground
  layout: SlideLayoutRef
}

interface PlanArgs {
  pack: StylePack
  layoutId: string
  tokens: FolderTokensSnapshot
  meta: DeckMeta
  /** The slide's objects as stored (Y.Maps, so text bodies keep their formatting). */
  objects: ReadonlyArray<Y.Map<unknown>>
  /** The slide's current layout (its earlier one), if any. */
  current: SlideLayoutRef | undefined
  content?: Readonly<Record<string, SlotContent>>
  /** A surface the slide chooses, where the layout lets it choose. */
  surface?: string
  /** The slide's 1-based number, for `{page}` inside furniture text. */
  slideNumber: number
}

/** A canvas fraction in px, to the half pixel: fractions carry 4 decimals (≈ 0.2 px), the brand's grid does not. */
const px = (fraction: number, of: number): number => Math.round(fraction * of * 2) / 2

function rectPx(rect: readonly [number, number, number, number]): {
  x: number
  y: number
  width: number
  height: number
} {
  return {
    x: px(rect[0], SLIDE_WIDTH),
    y: px(rect[1], SLIDE_HEIGHT),
    width: px(rect[2], SLIDE_WIDTH),
    height: px(rect[3], SLIDE_HEIGHT),
  }
}

function isAssetContent(c: SlotContent | undefined): c is { assetId: string } {
  return typeof c === 'object' && c !== null && 'assetId' in c
}

export function planLayout(args: PlanArgs): LayoutPlan {
  const { pack, tokens, meta } = args
  const layout = pack.layouts.find((l) => l.id === args.layoutId)
  if (layout === undefined)
    throw new CommandError(
      'not_found',
      `the pack has no layout '${args.layoutId}'; it has ${pack.layouts.map((l) => l.id).join(', ')}`,
    )

  // ── Surface ─────────────────────────────────────────────────────────────
  let surface: string | undefined
  if (layout.surface !== undefined) {
    if ('fixed' in layout.surface) surface = layout.surface.fixed
    else {
      surface = args.surface ?? layout.surface.default
      if (!layout.surface.choose.includes(surface))
        throw new CommandError(
          'invalid_input',
          `layout '${layout.id}' offers the surfaces ${layout.surface.choose.join(', ')}`,
        )
    }
  }
  const ctx = {
    ...(meta.variant !== undefined ? { variant: meta.variant } : {}),
    ...(surface !== undefined ? { surface } : {}),
  }

  // ── Tokens the compile made ─────────────────────────────────────────────
  const colorToken = (ref: ColorRef): { $token: string } => {
    const key = ref.startsWith('#') ? `literal:${ref.toLowerCase()}` : ref
    const id = compiledTokenId(pack.id, key)
    if (!Object.hasOwn(tokens.colors, id))
      throw new CommandError(
        'conflict',
        `the folder has no token for ${ref} yet; compile the pack first (style.pack.edit { op: "compile" })`,
      )
    return { $token: `colors.${id}` }
  }
  const colorValue = (ref: ColorRef): number => {
    const hex = resolveTokenValue(colorToken(ref), tokens, ctx)
    return (hex === null ? null : parseHexColor(hex))?.color ?? 0
  }
  const styleToken = (styleId: string): TextStyleTokenSnapshot => {
    const id = compiledTokenId(pack.id, `textStyle:${styleId}`)
    const style = tokens.textStyles[id]
    if (style === undefined)
      throw new CommandError(
        'conflict',
        `the folder has no text style for '${styleId}' yet; compile the pack first (style.pack.edit { op: "compile" })`,
      )
    return style
  }

  // ── What the slide holds from its earlier layout ────────────────────────
  const plain = args.objects.map((m) => ({
    map: m,
    id: m.get('id') as string,
    type: m.get('type') as string,
    slot: m.get('slot') as string | undefined,
    role: m.get('role') as string | undefined,
  }))
  const pack0 = plain.filter((o) => o.slot !== undefined)
  const used = new Set<string>()
  const remove = new Set<string>()
  // Furniture and decor are regenerated; region objects are matched below.
  for (const o of pack0) if (o.role === 'furniture') remove.add(o.id)

  const update: LayoutPlan['update'] = []
  const add: SlideObject[] = []
  const defaults = getObjectTypeDef('text')?.defaultProps() ?? {}

  const textFields = (region: PackRegion, styleId: string): Record<string, unknown> => {
    const style = styleToken(styleId)
    const fields: Record<string, unknown> = {
      ...textStyleFields(style, tokens),
      textStyleId: style.id,
      textStyleOverrides:
        region.align !== undefined && region.align !== style.align ? ['align'] : [],
    }
    if (region.align !== undefined) fields['align'] = region.align
    if (region.anchor !== undefined && region.anchor !== 'top') fields['vAlign'] = region.anchor
    else fields['vAlign'] = undefined
    fields['autofit'] =
      region.autofit === 'grow-down' || region.autofit === 'shrink' ? region.autofit : undefined
    return fields
  }

  const bodyOf = (map: Y.Map<unknown>): RichDeltaOp[] | string => {
    const t = map.get('text')
    return t instanceof Y.Text ? toDelta(t) : typeof t === 'string' ? t : ''
  }

  for (const region of layout.regions) {
    const box = rectPx(region.rect)
    const given = args.content?.[region.slot]
    const sameSlot = pack0.find(
      (o) => !used.has(o.id) && o.slot === region.slot && !remove.has(o.id),
    )
    const sameRole =
      sameSlot ??
      (args.current !== undefined
        ? pack0.find(
            (o) =>
              !used.has(o.id) &&
              o.role === region.role &&
              !remove.has(o.id) &&
              o.role !== 'furniture',
          )
        : undefined)

    if (region.component !== undefined) {
      // A component's objects at the region's origin, as its master holds them.
      const compiled = compileStylePack(pack, { tokens, fonts: null }).components.find(
        (c) => c.origin.key === `component:${region.component}`,
      )
      if (compiled === undefined) continue
      for (const [i, o] of compiled.objects.entries()) {
        const slot = i === 0 ? region.slot : `${region.slot}-${i + 1}`
        const old = pack0.find((p) => !used.has(p.id) && p.slot === slot)
        const placed: Record<string, unknown> = { ...o, x: box.x + o.x, y: box.y + o.y, slot }
        if (o.type === 'text' && typeof o.textStyleId === 'string') {
          const style = tokens.textStyles[o.textStyleId]
          if (style !== undefined) Object.assign(placed, textStyleFields(style, tokens))
        }
        const content = i === 0 ? given : undefined
        if (old !== undefined && old.type === o.type) {
          used.add(old.id)
          const { id: _id, text: _text, ...patch } = placed
          update.push({
            id: old.id,
            patch,
            ...(content !== undefined && !isAssetContent(content)
              ? { body: planFromBody(content) }
              : {}),
          })
        } else {
          if (old !== undefined) remove.add(old.id)
          const body =
            content !== undefined && !isAssetContent(content) ? planFromBody(content) : null
          add.push({
            ...placed,
            id: nanoid(),
            ...(body !== null ? { text: planText(body), _richTextOps: planToDelta(body) } : {}),
          } as unknown as SlideObject)
        }
      }
      if (sameRole !== undefined && sameRole.slot !== region.slot && !used.has(sameRole.id))
        remove.add(sameRole.id)
      continue
    }

    if (region.type === 'text') {
      if (region.textStyle === undefined) continue
      const fields = textFields(region, region.textStyle)
      // A text box has no inner margin: the region's insets (a master's
      // bodyPr) move the box inside the region's frame.
      const [il, it, ir, ib] = region.insets ?? [0, 0, 0, 0]
      const inner = {
        x: box.x + il,
        y: box.y + it,
        width: Math.max(1, box.width - il - ir),
        height: Math.max(1, box.height - it - ib),
      }
      const geometry = { ...inner, slot: region.slot, role: region.role, name: region.slot }
      if (sameSlot !== undefined && sameSlot.type === 'text') {
        used.add(sameSlot.id)
        update.push({
          id: sameSlot.id,
          patch: { ...geometry, ...fields },
          ...(given !== undefined && !isAssetContent(given)
            ? { body: planFromBody(given) }
            : {}),
        })
        continue
      }
      let body: RichDeltaOp[] | string = ''
      if (given !== undefined && !isAssetContent(given)) body = planToDelta(planFromBody(given))
      else if (sameRole !== undefined && sameRole.type === 'text') {
        body = bodyOf(sameRole.map)
        used.add(sameRole.id)
        remove.add(sameRole.id)
      }
      add.push({
        ...defaults,
        ...geometry,
        ...fields,
        id: nanoid(),
        type: 'text',
        rotation: 0,
        opacity: 1,
        text: typeof body === 'string' ? body : body.map((op) => op.insert).join(''),
        ...(typeof body === 'string' ? {} : { _richTextOps: body }),
      } as unknown as SlideObject)
      continue
    }

    // Picture (or a chart or table slot, held by a placeholder until one is made).
    const picture = isAssetContent(given)
      ? given.assetId
      : sameRole !== undefined && sameRole.type === 'image'
        ? (sameRole.map.get('assetId') as string)
        : undefined
    if (sameRole !== undefined) {
      used.add(sameRole.id)
      remove.add(sameRole.id)
    }
    const geometry = { ...box, slot: region.slot, role: region.role, name: region.slot }
    if (region.type === 'image' && picture !== undefined) {
      add.push({
        ...geometry,
        id: nanoid(),
        type: 'image',
        rotation: 0,
        opacity: 1,
        assetId: picture,
        fit: 'cover',
      } as unknown as SlideObject)
    } else {
      add.push({
        ...geometry,
        id: nanoid(),
        type: 'rectangle',
        rotation: 0,
        opacity: 1,
        fill: colorToken(placeholderRef(pack)),
        fillAlpha: 0.15,
      } as unknown as SlideObject)
    }
  }

  // Region objects of the earlier layout nothing took over.
  if (args.current !== undefined)
    for (const o of pack0) if (!used.has(o.id) && o.role !== 'furniture') remove.add(o.id)

  // ── Furniture and decor ─────────────────────────────────────────────────
  const furnitureIds = layout.furniture ?? pack.furniture.defaultSet
  for (const fid of furnitureIds) {
    const item = pack.furniture.items[fid]
    if (item !== undefined) add.push(...furnitureObjects(item, fid))
  }
  layout.decor?.forEach((item, i) => add.push(...furnitureObjects(item, `decor-${i + 1}`)))

  function furnitureObjects(item: FurnitureItem, slot: string): SlideObject[] {
    const base = { slot, role: 'furniture', name: slot, rotation: 0, opacity: 1, locked: true }
    switch (item.kind) {
      case 'text': {
        const lang = meta.lang ?? pack.editorial.languages[0] ?? 'en'
        const template =
          typeof item.template === 'string'
            ? item.template
            : (item.template[lang] ?? Object.values(item.template)[0] ?? '')
        const style = styleToken(item.textStyle)
        const live = template.trim() === '{page}'
        const text = live
          ? ''
          : template.replace(/\{([a-z][a-z0-9-]*)\}/g, (_m, name: string) => {
              if (name === 'page') return String(args.slideNumber)
              const f = item.fields?.[name]
              return meta.fields?.[name] ?? f?.default ?? f?.sentinel ?? ''
            })
        return [
          {
            ...defaults,
            ...base,
            ...rectPx(item.rect),
            ...textStyleFields(style, tokens),
            textStyleId: style.id,
            textStyleOverrides: [],
            id: nanoid(),
            type: 'text',
            text,
            ...(live ? { isSlideNumber: true } : {}),
          } as unknown as SlideObject,
        ]
      }
      case 'pageNumber': {
        const compiled = compileStylePack(pack, { tokens, fonts: null }).components.find(
          (c) => c.origin.key === `component:${item.component}`,
        )
        return (compiled?.objects ?? []).map((o, i) => {
          const placed: Record<string, unknown> = {
            ...o,
            ...base,
            slot: i === 0 ? slot : `${slot}-${i + 1}`,
            id: nanoid(),
          }
          if (o.type === 'text' && typeof o.textStyleId === 'string') {
            const style = tokens.textStyles[o.textStyleId]
            if (style !== undefined) Object.assign(placed, textStyleFields(style, tokens))
          }
          return placed as unknown as SlideObject
        })
      }
      case 'image': {
        const asset = pack.assets[item.asset]
        const source =
          asset?.byRole !== undefined
            ? asset.byRole.files[
                Object.keys(asset.byRole.files).find(
                  (ref) => colorValue(ref as ColorRef) === colorValue(`role:${asset.byRole!.role}`),
                ) ?? ''
              ]
            : asset?.file
        if (source === undefined || !('assetId' in source)) return []
        return [
          {
            ...base,
            ...rectPx(item.rect),
            id: nanoid(),
            type: 'image',
            assetId: source.assetId,
            fit: 'contain',
          } as unknown as SlideObject,
        ]
      }
      case 'rule': {
        const r = rectPx(item.rect)
        return [
          {
            ...base,
            ...r,
            id: nanoid(),
            type: 'line',
            p1: { x: 0, y: 0 },
            p2: { x: r.width, y: r.height },
            stroke: colorToken(item.color),
            strokeWidth: item.width,
          } as unknown as SlideObject,
        ]
      }
      case 'shape': {
        const fill = item.fill
        const fillFields =
          fill === undefined
            ? { fill: 0, fillAlpha: 0 }
            : typeof fill === 'string'
              ? { fill: colorToken(fill) }
              : {
                  fill: colorValue(fill.radial[0]!.color),
                  fillStyle: {
                    kind: 'radialGradient',
                    centerX: fill.center[0],
                    centerY: fill.center[1],
                    stops: fill.radial.map((s) => {
                      const hex = resolveTokenValue(colorToken(s.color), tokens, ctx)
                      const parsed = hex === null ? null : parseHexColor(hex)
                      return {
                        offset: s.offset,
                        color: parsed?.color ?? 0,
                        ...(parsed !== null && parsed.alpha < 1 ? { alpha: parsed.alpha } : {}),
                      }
                    }),
                  },
                }
        return [
          {
            ...base,
            ...rectPx(item.rect),
            id: nanoid(),
            type: item.shape === 'ellipse' ? 'ellipse' : 'rectangle',
            ...fillFields,
            ...(item.stroke !== undefined
              ? { stroke: colorToken(item.stroke.color), strokeWidth: item.stroke.width }
              : {}),
            ...(item.shape === 'rect' && item.radius !== undefined
              ? { cornerRadius: item.radius }
              : {}),
          } as unknown as SlideObject,
        ]
      }
    }
  }

  // ── Background and the reference ────────────────────────────────────────
  const background: SlideBackground = {
    kind: 'color',
    color: colorValue(layout.background ?? 'role:background'),
    alpha: 1,
  }
  return {
    update,
    add,
    // An object updated in place is never removed.
    remove: [...remove].filter((id) => !update.some((u) => u.id === id)),
    background,
    layout: {
      packId: pack.id,
      layoutId: layout.id,
      ...(surface !== undefined ? { surface } : {}),
    },
  }
}

/** The colour a placeholder takes: the muted text role where the pack has it, else the text role. */
function placeholderRef(pack: StylePack): ColorRef {
  const governs = (role: string): boolean =>
    pack.tokens.axes.some((a) => a.values.some((v) => role in v.roles))
  return governs('textMuted') ? 'role:textMuted' : 'role:text'
}

/** Which layout objects of a slide are the pack's (they carry a slot). */
export function isLayoutObject(map: Y.Map<unknown>): boolean {
  return typeof map.get('slot') === 'string'
}

export type { PackLayout }
