/**
 * shared/src/schema/stylePackValidate.ts — the style pack as a whole
 * (agentic A4.3, docs/plans/a4-style-pack-schema.md §3): what zod's
 * field-by-field shape cannot say. Every problem is a path-addressed issue
 * (`layouts[4].regions[2].textStyle`), so whoever edits a pack — a person
 * in Folder Settings, an agent through `style.pack.edit`, a bootstrap
 * importer — learns exactly what to fix. An empty list is a valid pack.
 */

import {
  COLOR_ROLES,
  MAX_PACK_BYTES,
  type ColorRole,
  type FurnitureItem,
  type PackComponent,
  type StylePack,
} from './stylePack.js'

export interface PackIssue {
  path: string
  message: string
}

const CANVAS = { width: 1920, height: 1080 }
/** A rect a hair outside the canvas still counts as inside (4-decimal fractions). */
const RECT_EPS = 0.0005
/** A component may overhang its region by a pixel. */
const FIT_EPS_PX = 1

/** Every colour reference in a value, with where it sits. */
function colorRefs(value: unknown, path: string, out: Array<{ path: string; ref: string }>): void {
  if (typeof value === 'string') {
    if (/^(role:[A-Za-z]+|color:[a-z][a-z0-9-]*)$/.test(value)) out.push({ path, ref: value })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => colorRefs(v, `${path}[${i}]`, out))
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) colorRefs(v, path === '' ? k : `${path}.${k}`, out)
  }
}

/** `{name}` placeholders in a furniture template. */
function placeholders(template: string | Record<string, string>): string[] {
  const texts = typeof template === 'string' ? [template] : Object.values(template)
  const out = new Set<string>()
  for (const t of texts) for (const m of t.matchAll(/\{([a-z][a-z0-9-]*)\}/g)) out.add(m[1]!)
  return [...out]
}

export function validateStylePack(pack: StylePack): PackIssue[] {
  const issues: PackIssue[] = []
  const issue = (path: string, message: string): void => {
    issues.push({ path, message })
  }
  const has = <T extends object>(rec: T, key: string): boolean => Object.hasOwn(rec, key)

  const layoutIds = new Set<string>()
  const componentById = new Map<string, PackComponent>()
  pack.components.forEach((c, i) => {
    if (componentById.has(c.id)) issue(`components[${i}].id`, `duplicate component id '${c.id}'`)
    componentById.set(c.id, c)
  })
  pack.layouts.forEach((l, i) => {
    if (layoutIds.has(l.id)) issue(`layouts[${i}].id`, `duplicate layout id '${l.id}'`)
    layoutIds.add(l.id)
  })

  // ── 7. Fonts ────────────────────────────────────────────────────────────
  for (const required of ['head', 'text']) {
    if (!has(pack.fonts, required)) issue(`fonts.${required}`, `the '${required}' font is required`)
  }
  for (const [id, f] of Object.entries(pack.fonts)) {
    const wdth = f.requires?.axes?.wdth
    if (
      f.stretch !== undefined &&
      wdth !== undefined &&
      (f.stretch < wdth[0] || f.stretch > wdth[1])
    )
      issue(
        `fonts.${id}.stretch`,
        `stretch ${f.stretch} is outside the face's wdth ${wdth[0]}–${wdth[1]}`,
      )
    const wght = f.requires?.axes?.wght
    if (wght !== undefined && (f.weight < wght[0] || f.weight > wght[1]))
      issue(
        `fonts.${id}.weight`,
        `weight ${f.weight} is outside the face's wght ${wght[0]}–${wght[1]}`,
      )
  }

  // ── 6. Text styles ──────────────────────────────────────────────────────
  for (const [id, s] of Object.entries(pack.textStyles)) {
    const p = `textStyles.${id}`
    if (!has(pack.fonts, s.font)) issue(`${p}.font`, `no font '${s.font}'`)
    if (s.lineHeight !== undefined && s.lineSpacing !== undefined)
      issue(p, 'lineHeight and lineSpacing are exclusive')
    if (s.size > 1000) issue(`${p}.size`, 'sizes are 1–1000 px')
    if (s.minSize !== undefined && s.minSize > s.size)
      issue(`${p}.minSize`, 'the shrink floor is larger than the size')
    s.levels?.forEach((l, i) => {
      const lp = `${p}.levels[${i}]`
      if (l.bullet !== undefined && l.list !== 'bullet')
        issue(`${lp}.bullet`, "a bullet needs list: 'bullet'")
      if (l.numberFormat !== undefined && l.list !== 'number')
        issue(`${lp}.numberFormat`, "a number format needs list: 'number'")
      if (l.hanging > l.indent)
        issue(`${lp}.hanging`, 'the marker hangs left of the box (hanging > indent)')
      if (l.font !== undefined && !has(pack.fonts, l.font))
        issue(`${lp}.font`, `no font '${l.font}'`)
      if (l.size !== undefined && l.size > 1000) issue(`${lp}.size`, 'sizes are 1–1000 px')
    })
  }

  // ── 2. Colour roles and 3. variants ─────────────────────────────────────
  const governing = new Map<ColorRole, string>()
  pack.tokens.axes.forEach((axis, ai) => {
    const ap = `tokens.axes[${ai}]`
    const valueIds = new Set(axis.values.map((v) => v.id))
    if (valueIds.size !== axis.values.length) issue(`${ap}.values`, 'duplicate value ids')
    if (!valueIds.has(axis.default))
      issue(`${ap}.default`, `'${axis.default}' is not one of its values`)
    const roles = new Set<ColorRole>()
    for (const v of axis.values) for (const r of Object.keys(v.roles)) roles.add(r as ColorRole)
    for (const role of roles) {
      const other = governing.get(role)
      if (other !== undefined) issue(`${ap}`, `role '${role}' is governed by axis '${other}' too`)
      else governing.set(role, axis.id)
      axis.values.forEach((v, vi) => {
        if (!has(v.roles, role))
          issue(`${ap}.values[${vi}].roles.${role}`, `every value of the axis defines '${role}'`)
      })
    }
    axis.values.forEach((v, vi) => {
      for (const [role, ref] of Object.entries(v.roles))
        if (ref.startsWith('role:'))
          issue(`${ap}.values[${vi}].roles.${role}`, 'a role cannot point at a role')
      for (const [otherAxis, values] of Object.entries(v.recommendedWith ?? {})) {
        const target = pack.tokens.axes.find((a) => a.id === otherAxis)
        if (target === undefined)
          issue(`${ap}.values[${vi}].recommendedWith.${otherAxis}`, 'no such axis')
        else
          for (const val of values)
            if (!target.values.some((x) => x.id === val))
              issue(`${ap}.values[${vi}].recommendedWith.${otherAxis}`, `no value '${val}'`)
      }
    })
  })
  for (const required of ['background', 'text'] as const)
    if (!governing.has(required))
      issue('tokens.axes', `role '${required}' must be governed by an axis`)
  for (const [sid, surface] of Object.entries(pack.tokens.surfaces ?? {}))
    for (const [role, ref] of Object.entries(surface.roles))
      if (ref.startsWith('role:'))
        issue(`tokens.surfaces.${sid}.roles.${role}`, 'a role cannot point at a role')

  const refs: Array<{ path: string; ref: string }> = []
  colorRefs(pack, '', refs)
  for (const { path, ref } of refs) {
    if (ref.startsWith('color:')) {
      const id = ref.slice('color:'.length)
      if (!has(pack.tokens.colors, id)) issue(path, `no pack colour '${id}'`)
    } else {
      const role = ref.slice('role:'.length) as ColorRole
      if (!(COLOR_ROLES as readonly string[]).includes(role)) issue(path, `unknown role '${role}'`)
      else if (!governing.has(role)) issue(path, `role '${role}' is governed by no axis`)
    }
  }

  // Surfaces a layout may use: a declared surface or an axis value.
  const surfaceIds = new Set(Object.keys(pack.tokens.surfaces ?? {}))
  for (const a of pack.tokens.axes) for (const v of a.values) surfaceIds.add(v.id)

  // ── 8. Furniture and 1. references in it ────────────────────────────────
  const furnitureItem = (item: FurnitureItem, p: string): void => {
    if (item.kind === 'text') {
      if (!has(pack.textStyles, item.textStyle))
        issue(`${p}.textStyle`, `no text style '${item.textStyle}'`)
      for (const name of placeholders(item.template))
        if (name !== 'page' && !has(item.fields ?? {}, name))
          issue(`${p}.template`, `'{${name}}' is not a declared field`)
    } else if (item.kind === 'pageNumber') {
      const c = componentById.get(item.component)
      if (c === undefined) issue(`${p}.component`, `no component '${item.component}'`)
      else if (c.kind !== 'pagination')
        issue(`${p}.component`, `'${item.component}' is not a pagination component`)
    } else if (item.kind === 'image') {
      if (!has(pack.assets, item.asset)) issue(`${p}.asset`, `no asset '${item.asset}'`)
    }
  }
  let pageNumbers = 0
  for (const [id, item] of Object.entries(pack.furniture.items)) {
    furnitureItem(item, `furniture.items.${id}`)
    if (item.kind === 'pageNumber') pageNumbers++
  }
  if (pageNumbers > 1) issue('furniture.items', 'at most one pageNumber item')
  pack.furniture.defaultSet.forEach((id, i) => {
    if (!has(pack.furniture.items, id))
      issue(`furniture.defaultSet[${i}]`, `no furniture item '${id}'`)
  })
  pack.qa.requiredFurniture.forEach((id, i) => {
    if (!has(pack.furniture.items, id))
      issue(`qa.requiredFurniture[${i}]`, `no furniture item '${id}'`)
  })
  pack.qa.textColors.forEach((ref, i) => {
    if (ref.startsWith('role:')) issue(`qa.textColors[${i}]`, 'list colours, not roles')
  })

  // ── Layouts: 1, 4, 5 ────────────────────────────────────────────────────
  pack.layouts.forEach((layout, li) => {
    const lp = `layouts[${li}]`
    const surface = layout.surface
    if (surface !== undefined) {
      const ids = 'fixed' in surface ? [surface.fixed] : surface.choose
      for (const id of ids)
        if (!surfaceIds.has(id)) issue(`${lp}.surface`, `no surface or variant '${id}'`)
      if ('choose' in surface && !surface.choose.includes(surface.default))
        issue(`${lp}.surface.default`, 'the default is not one of the choices')
    }
    layout.furniture?.forEach((id, i) => {
      if (!has(pack.furniture.items, id))
        issue(`${lp}.furniture[${i}]`, `no furniture item '${id}'`)
    })
    layout.decor?.forEach((item, i) => furnitureItem(item, `${lp}.decor[${i}]`))

    const slots = new Set<string>()
    const fillOrders = new Set<number>()
    const items = new Set<number>()
    layout.regions.forEach((r, ri) => {
      const rp = `${lp}.regions[${ri}]`
      if (slots.has(r.slot)) issue(`${rp}.slot`, `duplicate slot '${r.slot}'`)
      slots.add(r.slot)
      if (r.role === 'furniture') issue(`${rp}.role`, 'furniture is the pack’s, never a region')
      const [x, y, w, h] = r.rect
      if (w <= 0 || h <= 0) issue(`${rp}.rect`, 'width and height must be positive')
      if (x < -RECT_EPS || y < -RECT_EPS || x + w > 1 + RECT_EPS || y + h > 1 + RECT_EPS)
        issue(`${rp}.rect`, 'the region leaves the canvas')
      if (r.type === 'text' && r.textStyle === undefined && r.component === undefined)
        issue(`${rp}`, 'a text region names a textStyle or a component')
      if (r.type === 'image' && r.textStyle !== undefined)
        issue(`${rp}.textStyle`, 'an image region has no text style')
      if (r.textStyle !== undefined && !has(pack.textStyles, r.textStyle))
        issue(`${rp}.textStyle`, `no text style '${r.textStyle}'`)
      if (r.component !== undefined) {
        const c = componentById.get(r.component)
        if (c === undefined) issue(`${rp}.component`, `no component '${r.component}'`)
        else {
          const regionW = w * CANVAS.width
          const regionH = h * CANVAS.height
          for (const o of c.objects) {
            const [ox, oy, ow, oh] = o.rect
            if (ox + ow > regionW + FIT_EPS_PX || oy + oh > regionH + FIT_EPS_PX) {
              issue(`${rp}.component`, `'${r.component}' does not fit the region`)
              break
            }
          }
        }
      }
      if (r.fillOrder !== undefined) {
        if (fillOrders.has(r.fillOrder))
          issue(`${rp}.fillOrder`, `duplicate fillOrder ${r.fillOrder}`)
        fillOrders.add(r.fillOrder)
      }
      if (r.item !== undefined) {
        items.add(r.item)
        if (layout.items === undefined) issue(`${rp}.item`, 'the layout declares no items')
        else if (r.item > layout.items.count) issue(`${rp}.item`, `item ${r.item} > items.count`)
      }
    })
    if (layout.items !== undefined && items.size > 0)
      for (let n = 1; n <= layout.items.count; n++)
        if (!items.has(n)) issue(`${lp}.regions`, `item ${n} has no region`)
  })

  // ── Components: text styles ─────────────────────────────────────────────
  pack.components.forEach((c, ci) => {
    c.objects.forEach((o, oi) => {
      if (o.textStyle !== undefined && !has(pack.textStyles, o.textStyle))
        issue(`components[${ci}].objects[${oi}].textStyle`, `no text style '${o.textStyle}'`)
    })
  })

  // ── Archetypes ──────────────────────────────────────────────────────────
  for (const [archetype, ids] of Object.entries(pack.archetypeMap))
    ids?.forEach((id, i) => {
      if (!layoutIds.has(id)) issue(`archetypeMap.${archetype}[${i}]`, `no layout '${id}'`)
    })

  // ── 4. Grid ─────────────────────────────────────────────────────────────
  const { grid } = pack
  grid.columns.forEach(([l, r], i) => {
    if (l >= r) issue(`grid.columns[${i}]`, 'left must be before right')
    if (l < 0 || r > CANVAS.width) issue(`grid.columns[${i}]`, 'outside the canvas')
    const prev = grid.columns[i - 1]
    if (prev !== undefined && l < prev[1]) issue(`grid.columns[${i}]`, 'columns must ascend')
  })
  const b = grid.bands
  const tops = [b.title, b.subtitle, b.content, b.footer].filter(
    (v): v is number => v !== undefined,
  )
  tops.forEach((t, i) => {
    if (t < 0 || t > CANVAS.height) issue('grid.bands', 'a band starts outside the canvas')
    if (i > 0 && t < tops[i - 1]!) issue('grid.bands', 'bands must descend the slide in order')
  })

  // ── 9. Text colours ─────────────────────────────────────────────────────
  if (pack.qa.textColors.length > 0) {
    const hexOf = (ref: string): string | undefined =>
      ref.startsWith('color:')
        ? pack.tokens.colors[ref.slice(6)]?.value.toLowerCase()
        : ref.startsWith('#')
          ? ref.toLowerCase()
          : undefined
    const allowed = new Set(
      pack.qa.textColors.map(hexOf).filter((v): v is string => v !== undefined),
    )
    for (const [id, s] of Object.entries(pack.textStyles)) {
      const resolved: string[] = []
      if (s.color.startsWith('role:')) {
        const role = s.color.slice(5) as ColorRole
        const axis = pack.tokens.axes.find((a) => a.id === governing.get(role))
        for (const v of axis?.values ?? []) {
          const ref = v.roles[role]
          const hex = ref === undefined ? undefined : hexOf(ref)
          if (hex !== undefined) resolved.push(hex)
        }
      } else {
        const hex = hexOf(s.color)
        if (hex !== undefined) resolved.push(hex)
      }
      for (const hex of resolved)
        if (!allowed.has(hex)) issue(`textStyles.${id}.color`, `${hex} is not one of qa.textColors`)
    }
  }

  // ── 10. Size ────────────────────────────────────────────────────────────
  const bytes = new TextEncoder().encode(JSON.stringify(pack)).length
  if (bytes > MAX_PACK_BYTES) issue('', `the pack is ${bytes} bytes; at most ${MAX_PACK_BYTES}`)

  return issues
}
