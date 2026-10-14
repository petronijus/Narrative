/**
 * stylePack.test.ts — a style pack's shape (zod) and its whole-pack rules
 * (validateStylePack, schema doc §3): the example pack is valid, and each
 * kind of broken reference or rule is reported at its path.
 */

import { describe, expect, it } from 'vitest'
import { StylePackSchema, type StylePack } from './stylePack.js'
import { validateStylePack } from './stylePackValidate.js'
import { exampleStylePack } from './stylePackExample.js'
import { richExampleStylePack } from './stylePackRichExample.js'

const paths = (pack: StylePack): string[] => validateStylePack(pack).map((i) => i.path)

describe('style pack', () => {
  it('the example pack has the shape and passes every rule', () => {
    const pack = exampleStylePack()
    expect(StylePackSchema.safeParse(pack).success).toBe(true)
    expect(validateStylePack(pack)).toEqual([])
  })

  it('the rich example pack (A5.2) has the shape, passes every rule, and maps the archetypes a deck needs', () => {
    const pack = richExampleStylePack()
    const parsed = StylePackSchema.safeParse(pack)
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(validateStylePack(pack)).toEqual([])
    expect(pack.layouts).toHaveLength(8)
    for (const a of [
      'cover',
      'agenda',
      'divider',
      'content',
      'comparison',
      'picture',
      'statement',
      'closer',
    ])
      expect(pack.archetypeMap[a as keyof StylePack['archetypeMap']]?.length, a).toBeGreaterThan(0)
  })

  it('rejects malformed fields by shape', () => {
    const bad = { ...exampleStylePack(), id: 'Not Kebab' }
    expect(StylePackSchema.safeParse(bad).success).toBe(false)
    const color = exampleStylePack()
    ;(color.textStyles['title'] as { color: string }).color = 'blue'
    expect(StylePackSchema.safeParse(color).success).toBe(false)
  })

  it('reports references that do not resolve', () => {
    const pack = exampleStylePack()
    pack.layouts[1]!.regions[1]!.textStyle = 'nope'
    pack.layouts[1]!.regions[0]!.component = 'missing'
    pack.textStyles['title']!.color = 'color:purple'
    pack.archetypeMap.closer = ['gone']
    pack.furniture.defaultSet.push('ghost')
    expect(paths(pack)).toEqual(
      expect.arrayContaining([
        'layouts[1].regions[1].textStyle',
        'layouts[1].regions[0].component',
        'textStyles.title.color',
        'archetypeMap.closer[0]',
        'furniture.defaultSet[2]',
      ]),
    )
  })

  it("checks a logo's per-colour file keys: a colour reference, of a pack colour", () => {
    const pack = exampleStylePack()
    pack.assets['logo'] = {
      name: 'Logo',
      byRole: {
        role: 'text',
        files: { 'color:navy': { assetId: 'a1' }, 'color:purple': { assetId: 'a2' } },
      },
    }
    expect(paths(pack)).toEqual(['assets.logo.byRole.files.color:purple'])
    const shape = exampleStylePack() as unknown as Record<string, unknown>
    shape['assets'] = {
      logo: { name: 'Logo', byRole: { role: 'text', files: { white: { assetId: 'a' } } } },
    }
    expect(StylePackSchema.safeParse(shape).success).toBe(false)
  })

  it('needs every role used covered by exactly one axis, in every value', () => {
    const pack = exampleStylePack()
    delete pack.tokens.axes[0]!.values[1]!.roles.accent
    pack.textStyles['footer']!.color = 'role:onAccent'
    const issues = paths(pack)
    expect(issues).toContain('tokens.axes[0].values[1].roles.accent')
    expect(issues).toContain('textStyles.footer.color')
  })

  it('checks geometry, slots, items, text styles and fonts', () => {
    const pack = exampleStylePack()
    pack.layouts[0]!.regions[1]!.rect = [0.5, 0.5, 0.6, 0.1]
    pack.layouts[0]!.regions[1]!.slot = 'title'
    pack.textStyles['body']!.lineHeight = 1.2
    pack.textStyles['body']!.levels![1]!.hanging = 100
    delete pack.fonts['head']
    const issues = paths(pack)
    expect(issues).toEqual(
      expect.arrayContaining([
        'layouts[0].regions[1].rect',
        'layouts[0].regions[1].slot',
        'textStyles.body',
        'textStyles.body.levels[1].hanging',
        'fonts.head',
        'textStyles.title.font',
      ]),
    )
  })

  it('checks furniture templates and the text colour whitelist', () => {
    const pack = exampleStylePack()
    const footer = pack.furniture.items['footer']!
    if (footer.kind === 'text') footer.template = '{client} | {date}'
    pack.tokens.colors['pink'] = { name: 'Pink', value: '#ff00aa' }
    pack.textStyles['footer']!.color = 'color:pink'
    const issues = paths(pack)
    expect(issues).toContain('furniture.items.footer.template')
    expect(issues).toContain('textStyles.footer.color')
  })
})
