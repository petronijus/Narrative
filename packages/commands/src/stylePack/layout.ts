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
 *   - Content: given per slot, or carried over from what the slide holds —
 *     the object in the same slot is updated in place (its id, and so its
 *     animations, stay); else an object with the region's role moves in
 *     (A5.1: any object carrying a `role`, whether a layout placed it or an
 *     agent classified it). Regions and objects of one role pair up in
 *     reading order (top, then left; a region's `fillOrder` first), and only
 *     where the types fit: text into a text region (or a component's first
 *     text object), anything else into a picture, chart or table region.
 *   - What the layout did not place stays where it is and is listed
 *     (`unplaced`): objects without a slot or role, and objects of the
 *     earlier layout the new one has no place for. The earlier layout's
 *     empty text boxes (a component part still showing its master's text
 *     counts as empty) and picture placeholders are removed, and so is its
 *     object a slot's given content replaces.
 *   - Content is checked first: a slot the layout has, text for text and
 *     components, a picture for picture slots.
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
  ARCHETYPES,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Archetype,
  type ColorRef,
  type DeckMeta,
  type FurnitureItem,
  type ImageFocus,
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
  type TokenResolveContext,
} from '@narrative/slide-model'
import { CommandError } from '../errors.js'
import { compiledTokenId, compileStylePack } from './compile.js'
import { planFromBody, planToDelta, type BodyPlan, type TextBodyInput } from '../text/body.js'
import { textStyleFields } from '../text/textStyle.js'

/** What a slot is filled with: text (plain or paragraphs) or a picture, and the side of it kept in view. */
export type SlotContent = TextBodyInput | { assetId: string; focus?: PictureFocus }

/** A pack region's `focus`; 'center' is an image's default (no `focus`). */
type PictureFocus = NonNullable<PackRegion['focus']>

export interface LayoutPlan {
  /** In place (ids kept); `body` replaces the text. */
  update: Array<{ id: string; patch: Record<string, unknown>; body?: BodyPlan }>
  add: SlideObject[]
  remove: string[]
  background: SlideBackground
  layout: SlideLayoutRef
  /** Objects left where they were: not placed in a region, not furniture. */
  unplaced: string[]
  /** The layout's slots left without content (an empty box, a placeholder, a component's own text). */
  emptySlots: string[]
}

/**
 * Slots of what a deck spec draws on the grid (`drawn-<n>`, A5.2): placed
 * by the spec, not by a region, so a re-lay leaves them where they are, never
 * moves them by role and does not list them as unplaced.
 */
export const DRAWN_SLOT_PREFIX = 'drawn-'
const isDrawn = (slot: string | undefined): boolean =>
  slot !== undefined && slot.startsWith(DRAWN_SLOT_PREFIX)

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
  /** The archetype the layout was picked for (else the pack's archetypeMap says). */
  archetype?: Archetype
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

function isAssetContent(
  c: SlotContent | undefined,
): c is { assetId: string; focus?: PictureFocus } {
  return typeof c === 'object' && c !== null && 'assetId' in c
}

/** The image `focus` for a region's picture: the content's, else the region's; centred is none. */
function focusOf(region: PackRegion, given: SlotContent | undefined): ImageFocus | undefined {
  const focus = (isAssetContent(given) ? given.focus : undefined) ?? region.focus
  return focus === undefined || focus === 'center' ? undefined : focus
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
  const { colorToken, colorValue, styleToken } = packTokens(pack, tokens, ctx)

  // ── The pack's components, as their masters hold them ───────────────────
  const components = compileStylePack(pack, { tokens, fonts: null }).components
  const componentOf = (id: string) => components.find((c) => c.origin.key === `component:${id}`)
  /** The text a component part shows until it is filled (its master's). */
  const componentDefaults = new Set(
    components.flatMap((c) =>
      c.objects.flatMap((o) => (o.type === 'text' && typeof o.text === 'string' ? [o.text] : [])),
    ),
  )

  // ── Content given by slot: each slot the layout has, of a kind it takes ──
  for (const [slot, given] of Object.entries(args.content ?? {})) {
    const region = layout.regions.find((r) => r.slot === slot)
    if (region === undefined)
      throw new CommandError(
        'invalid_input',
        `layout '${layout.id}' has no slot '${slot}'; it has ${layout.regions.map((r) => r.slot).join(', ')}`,
      )
    const takesPicture = region.type === 'image' && region.component === undefined
    if (isAssetContent(given) !== takesPicture)
      throw new CommandError(
        'invalid_input',
        takesPicture
          ? `slot '${slot}' takes a picture { assetId }, not text`
          : `slot '${slot}' takes ${region.type === 'text' || region.component !== undefined ? 'text' : `no content (a ${region.type} slot)`}, not a picture`,
      )
  }

  // ── What the slide holds ────────────────────────────────────────────────
  const bodyOf = (map: Y.Map<unknown>): RichDeltaOp[] | string => {
    const t = map.get('text')
    return t instanceof Y.Text ? toDelta(t) : typeof t === 'string' ? t : ''
  }
  /** A body as a new text object's fields. */
  const textOf = (body: RichDeltaOp[] | string): Record<string, unknown> => ({
    text: typeof body === 'string' ? body : body.map((op) => op.insert).join(''),
    ...(typeof body === 'string' ? {} : { _richTextOps: body }),
  })
  const plain = args.objects.map((m) => ({
    map: m,
    id: m.get('id') as string,
    type: m.get('type') as string,
    slot: m.get('slot') as string | undefined,
    role: m.get('role') as string | undefined,
    x: Number(m.get('x') ?? 0),
    y: Number(m.get('y') ?? 0),
  }))
  type Held = (typeof plain)[number]
  const pack0 = plain.filter((o) => o.slot !== undefined)
  /** A layout's text box with nothing of its own: empty, or a component part's default text. */
  const holdsNoText = (o: Held): boolean => {
    if (o.type !== 'text' || o.slot === undefined) return false
    const text = String(textOf(bodyOf(o.map))['text']).trim()
    return text === '' || componentDefaults.has(text)
  }
  const used = new Set<string>()
  const remove = new Set<string>()
  // Furniture and decor are regenerated; region objects are matched below.
  for (const o of pack0) if (o.role === 'furniture') remove.add(o.id)

  // The object already in a region's slot.
  const slotHolder = new Map<PackRegion, Held>()
  for (const region of layout.regions) {
    const o = pack0.find(
      (p) => p.slot === region.slot && !remove.has(p.id) && ![...slotHolder.values()].includes(p),
    )
    if (o !== undefined) slotHolder.set(region, o)
  }
  // Text goes into text regions (and components, whose first text object
  // takes it); anything else into picture, chart and table regions.
  const fits = (region: PackRegion, o: Held): boolean =>
    region.component !== undefined
      ? o.type === 'text' &&
        (componentOf(region.component)?.objects.some((p) => p.type === 'text') ?? false)
      : region.type === 'text'
        ? o.type === 'text'
        : o.type !== 'text'
  // The rest move by role, in reading order on both sides: regions by
  // fillOrder, then top, then left; objects by top, then left.
  const byRole = new Map<PackRegion, Held>()
  const holders = new Set([...slotHolder.values()].map((o) => o.id))
  const movable = plain
    .filter(
      (o) =>
        o.role !== undefined &&
        o.role !== 'furniture' &&
        !remove.has(o.id) &&
        !holders.has(o.id) &&
        !isDrawn(o.slot) &&
        !holdsNoText(o),
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const regionOrder = [...layout.regions].sort(
    (a, b) =>
      (a.fillOrder ?? Number.MAX_SAFE_INTEGER) - (b.fillOrder ?? Number.MAX_SAFE_INTEGER) ||
      a.rect[1] - b.rect[1] ||
      a.rect[0] - b.rect[0],
  )
  const taken = new Set<string>()
  for (const region of regionOrder) {
    // A region holding its own object takes no other. One filled by name
    // takes the earlier layout's object of its role only to replace it (it
    // goes); a person's or an agent's own object is not the layout's to drop.
    if (slotHolder.has(region)) continue
    const given = args.content?.[region.slot] !== undefined
    const o = movable.find(
      (m) =>
        !taken.has(m.id) &&
        m.role === region.role &&
        fits(region, m) &&
        (!given || m.slot !== undefined),
    )
    if (o === undefined) continue
    byRole.set(region, o)
    taken.add(o.id)
  }

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

  /** An object that moved into a region: its old self goes. */
  const consume = (o: Held): void => {
    used.add(o.id)
    remove.add(o.id)
  }

  /** Regions that got content: given, carried in place, or moved in. */
  const filled = new Set<PackRegion>()
  for (const region of layout.regions) {
    const box = rectPx(region.rect)
    const given = args.content?.[region.slot]
    if (given !== undefined) filled.add(region)
    const sameSlot = slotHolder.get(region)
    const roleMatch = byRole.get(region)
    const sameRole = sameSlot ?? roleMatch

    if (region.component !== undefined) {
      // A component's objects at the region's origin, as its master holds
      // them; the slot's content goes into its first text object.
      const compiled = componentOf(region.component)
      if (compiled === undefined) continue
      // Content given replaces the earlier layout's object of this role.
      if (given !== undefined && roleMatch !== undefined) consume(roleMatch)
      const firstText = compiled.objects.findIndex((o) => o.type === 'text')
      for (const [i, o] of compiled.objects.entries()) {
        const slot = i === 0 ? region.slot : `${region.slot}-${i + 1}`
        const old = pack0.find((p) => !used.has(p.id) && p.slot === slot)
        const placed: Record<string, unknown> = { ...o, x: box.x + o.x, y: box.y + o.y, slot }
        if (o.type === 'text' && typeof o.textStyleId === 'string') {
          const style = tokens.textStyles[o.textStyleId]
          if (style !== undefined) Object.assign(placed, textStyleFields(style, tokens))
        }
        const content = i === firstText && !isAssetContent(given) ? given : undefined
        if (old !== undefined && old.type === o.type) {
          used.add(old.id)
          if (i === firstText && !holdsNoText(old)) filled.add(region)
          const { id: _id, text: _text, ...patch } = placed
          update.push({
            id: old.id,
            patch,
            ...(content !== undefined ? { body: planFromBody(content) } : {}),
          })
          continue
        }
        if (old !== undefined) remove.add(old.id)
        // Moved in by role: the text of the object that held it.
        const moved =
          i === firstText &&
          content === undefined &&
          sameRole !== undefined &&
          sameRole.type === 'text' &&
          !used.has(sameRole.id)
            ? sameRole
            : undefined
        if (moved !== undefined) {
          consume(moved)
          filled.add(region)
        }
        const body =
          content !== undefined
            ? textOf(planToDelta(planFromBody(content)))
            : moved !== undefined
              ? textOf(bodyOf(moved.map))
              : {}
        add.push({ ...placed, id: nanoid(), ...body } as unknown as SlideObject)
      }
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
        if (!holdsNoText(sameSlot)) filled.add(region)
        update.push({
          id: sameSlot.id,
          patch: { ...geometry, ...fields },
          ...(given !== undefined && !isAssetContent(given) ? { body: planFromBody(given) } : {}),
        })
        continue
      }
      let body: RichDeltaOp[] | string = ''
      if (given !== undefined && !isAssetContent(given)) {
        body = planToDelta(planFromBody(given))
        // It replaces the earlier layout's object of this role.
        if (roleMatch !== undefined) consume(roleMatch)
      } else if (sameRole !== undefined && sameRole.type === 'text') {
        body = bodyOf(sameRole.map)
        consume(sameRole)
        if (String(textOf(body)['text']).trim() !== '') filled.add(region)
      }
      add.push({
        ...defaults,
        ...geometry,
        ...fields,
        id: nanoid(),
        type: 'text',
        rotation: 0,
        opacity: 1,
        ...textOf(body),
      } as unknown as SlideObject)
      continue
    }

    // A picture, chart or table region.
    const geometry = { ...box, slot: region.slot, role: region.role, name: region.slot }
    const asset = isAssetContent(given) ? given.assetId : undefined
    // The layout's own placeholder, standing in until there is a picture.
    const placeholder =
      sameRole !== undefined && sameRole.type === 'rectangle' && sameRole.slot !== undefined
    if (sameRole !== undefined && fits(region, sameRole) && !placeholder) {
      if (asset !== undefined && sameRole.type !== 'image') {
        // A new picture replaces what was there.
        consume(sameRole)
      } else {
        // What was there (a picture, a table, a chart) moves into the region,
        // id kept; a picture covers its new frame — unless it stays in the
        // slot of the same layout and nothing new is given: then the crop
        // and focus someone chose stay too (a variant switch re-lays it).
        used.add(sameRole.id)
        filled.add(region)
        const sameFrame =
          sameRole === sameSlot &&
          args.current?.packId === pack.id &&
          args.current.layoutId === layout.id &&
          given === undefined
        update.push({
          id: sameRole.id,
          patch: {
            ...geometry,
            ...(sameRole.type === 'image' && !sameFrame
              ? {
                  fit: 'cover',
                  focus: focusOf(region, given),
                  imageRect: undefined,
                  ...(asset !== undefined ? { assetId: asset } : {}),
                }
              : {}),
          },
        })
        continue
      }
    }
    if (placeholder) {
      if (asset === undefined) {
        used.add(sameRole.id)
        update.push({ id: sameRole.id, patch: geometry })
        continue
      }
      consume(sameRole)
    }
    if (region.type === 'image' && asset !== undefined) {
      add.push({
        ...geometry,
        id: nanoid(),
        type: 'image',
        rotation: 0,
        opacity: 1,
        assetId: asset,
        fit: 'cover',
        ...(focusOf(region, given) !== undefined ? { focus: focusOf(region, given) } : {}),
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

  // The earlier layout's objects nothing took over: an empty text box or a
  // picture placeholder goes; anything holding content stays, listed.
  for (const o of pack0) {
    if (used.has(o.id) || remove.has(o.id) || o.role === 'furniture' || isDrawn(o.slot)) continue
    if (o.type === 'rectangle' || holdsNoText(o)) remove.add(o.id)
  }
  const unplaced = plain
    .filter(
      (o) => !used.has(o.id) && !remove.has(o.id) && o.role !== 'furniture' && !isDrawn(o.slot),
    )
    .map((o) => o.id)
  const emptySlots = layout.regions.filter((r) => !filled.has(r)).map((r) => r.slot)

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
        const compiled = componentOf(item.component)
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
  const archetype = args.archetype ?? archetypeOfLayout(pack, layout.id)
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
      ...(archetype !== undefined ? { archetype } : {}),
    },
    unplaced,
    emptySlots,
  }
}

/**
 * The folder tokens a pack's compile made, by what the pack calls them: a
 * colour reference (`role:text`, `color:navy`, `#ff0000`) as a token
 * reference and as the value it has on `ctx` (the deck's variant, the
 * slide's surface), a text style id as its token. A reference the compile
 * has not made yet is a conflict: compile the pack first.
 */
export function packTokens(
  pack: StylePack,
  tokens: FolderTokensSnapshot,
  ctx: TokenResolveContext,
): {
  colorToken(ref: ColorRef): { $token: string }
  colorValue(ref: ColorRef): number
  styleToken(styleId: string): TextStyleTokenSnapshot
} {
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
  return {
    colorToken,
    colorValue(ref) {
      const hex = resolveTokenValue(colorToken(ref), tokens, ctx)
      return (hex === null ? null : parseHexColor(hex))?.color ?? 0
    },
    styleToken(styleId) {
      const id = compiledTokenId(pack.id, `textStyle:${styleId}`)
      const style = tokens.textStyles[id]
      if (style === undefined)
        throw new CommandError(
          'conflict',
          `the folder has no text style for '${styleId}' yet; compile the pack first (style.pack.edit { op: "compile" })`,
        )
      return style
    },
  }
}

/** The archetype the pack's `archetypeMap` gives a layout (the first that lists it). */
export function archetypeOfLayout(pack: StylePack, layoutId: string): Archetype | undefined {
  for (const archetype of ARCHETYPES)
    if (pack.archetypeMap[archetype]?.includes(layoutId) === true) return archetype
  return undefined
}

/**
 * The layout a slide of `archetype` takes (A5.1): of the layouts the pack's
 * `archetypeMap` lists for it, preferred first, the first; given content
 * (`filled`, its slot names), the first whose required slots it fills, else
 * the first.
 */
export function layoutForArchetype(
  pack: StylePack,
  archetype: Archetype,
  filled: ReadonlySet<string> = new Set(),
): PackLayout {
  const candidates = (pack.archetypeMap[archetype] ?? [])
    .map((id) => pack.layouts.find((l) => l.id === id))
    .filter((l): l is PackLayout => l !== undefined)
  const first = candidates[0]
  if (first === undefined) {
    const mapped = ARCHETYPES.filter((a) => (pack.archetypeMap[a]?.length ?? 0) > 0)
    throw new CommandError(
      'not_found',
      `the pack has no layout for archetype '${archetype}'` +
        (mapped.length > 0 ? `; it has layouts for ${mapped.join(', ')}` : '') +
        ' (or pick a layoutId: style.pack.get "layouts")',
    )
  }
  if (filled.size === 0) return first
  return (
    candidates.find((l) => l.regions.every((r) => r.required !== true || filled.has(r.slot))) ??
    first
  )
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
