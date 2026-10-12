/**
 * compile.test.ts — a style pack made into folder tokens and masters
 * (A4.4): role colours per variant and surface (an axis value a layout
 * pins included), text styles with their list levels linked to the
 * compiled colours, the pack's components, the fonts the folder lacks, and
 * a second compile that updates what the first made instead of adding to it.
 */

import { describe, expect, it } from 'vitest'
import { exampleStylePack, type StylePack } from '@narrative/shared'
import type { FolderTokensSnapshot } from '@narrative/slide-model'
import { compileStylePack, compiledTokenId } from './compile.js'

const EMPTY: FolderTokensSnapshot = { colors: {}, textStyles: {}, effectStyles: {} }

/** The plan applied as the server applies it: every token under its id. */
function applied(plan: ReturnType<typeof compileStylePack>): FolderTokensSnapshot {
  const tokens: FolderTokensSnapshot = { colors: {}, textStyles: {}, effectStyles: {} }
  for (const t of plan.colors)
    tokens.colors[t.id] = { id: t.id, ...t.fields, origin: t.origin } as never
  for (const t of plan.textStyles)
    tokens.textStyles[t.id] = { id: t.id, ...t.fields, origin: t.origin } as never
  return tokens
}

describe('compileStylePack', () => {
  it('compiles role colours per variant and surface, and styles linked to them', () => {
    const plan = compileStylePack(exampleStylePack(), { tokens: EMPTY, fonts: [] })
    const text = plan.colors.find((t) => t.id === compiledTokenId('example', 'role:text'))!
    expect(text.exists).toBe(false)
    expect(text.fields).toMatchObject({
      value: '#001e50',
      byVariant: { axis: 'background', values: { light: '#001e50', dark: '#ffffff' } },
      bySurface: { 'picture-dark': '#ffffff' },
    })
    const body = plan.textStyles.find((t) => t.id === 'p-example-textStyle-body')!
    expect(body.fields).toMatchObject({
      name: 'Body',
      size: 32,
      color: { $token: 'colors.p-example-role-text' },
    })
    expect(body.fields['levels']).toEqual([
      expect.objectContaining({
        list: 'bullet',
        bulletChar: '–',
        bulletColor: { $token: 'colors.p-example-role-accent' },
        indent: 36,
      }),
      expect.objectContaining({ bulletChar: '–', indent: 72, fontSize: 28 }),
    ])
    expect(plan.components.map((c) => c.origin.key)).toEqual([
      'component:pagination',
      'component:headline',
    ])
    expect(plan.missingFonts).toEqual(['Inter 700', 'Inter 400'])
  })

  it('pins an axis value a layout uses as its surface', () => {
    const pack: StylePack = exampleStylePack()
    pack.layouts[2]!.surface = { fixed: 'dark' }
    const plan = compileStylePack(pack, { tokens: EMPTY, fonts: [] })
    const background = plan.colors.find((t) => t.origin.key === 'role:background')!
    expect(background.fields['bySurface']).toEqual({ dark: '#001e50' })
  })

  it('updates what an earlier compile made, under the same ids', () => {
    const pack = exampleStylePack()
    const first = compileStylePack(pack, { tokens: EMPTY, fonts: [] })
    pack.tokens.colors['navy']!.value = '#002060'
    const second = compileStylePack(pack, { tokens: applied(first), fonts: [] })
    expect(second.colors.every((t) => t.exists)).toBe(true)
    expect(second.colors.map((t) => t.id)).toEqual(first.colors.map((t) => t.id))
    expect(second.colors.find((t) => t.origin.key === 'role:text')!.fields['value']).toBe('#002060')
  })

  it('names no font the folder holds, a variable face by its range', () => {
    const plan = compileStylePack(exampleStylePack(), {
      tokens: EMPTY,
      fonts: [{ family: 'Inter', weight: 400, axes: { wght: [100, 900] } }],
    })
    expect(plan.missingFonts).toEqual([])
  })
})
