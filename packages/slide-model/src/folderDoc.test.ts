import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addFolderToken,
  deleteFolderToken,
  migrateFolderTokens,
  readFolderTokens,
  seedDefaultTokens,
  updateFolderToken,
} from './folderDoc.js'
import { DEFAULT_COLORS, DEFAULT_TEXT_STYLES } from './defaultTokens.js'

function counter(): () => string {
  let n = 0
  return () => `t${++n}`
}

describe('folder token document', () => {
  it('seeds the defaults once, with text styles referencing the seeded colours', () => {
    const doc = new Y.Doc()
    expect(seedDefaultTokens(doc, counter())).toBe(true)
    const t = readFolderTokens(doc)
    expect(Object.keys(t.colors)).toHaveLength(DEFAULT_COLORS.length)
    expect(Object.keys(t.textStyles)).toHaveLength(DEFAULT_TEXT_STYLES.length)
    const title = Object.values(t.textStyles).find((s) => s.name === 'Title')!
    const primary = Object.values(t.colors).find((c) => c.name === 'Primary')!
    expect(title).toMatchObject({
      builtin: true,
      size: 96,
      color: { $token: `colors.${primary.id}` },
    })
    // A folder that has tokens is never refilled.
    expect(seedDefaultTokens(doc, counter())).toBe(false)
  })

  it('adds, updates (undefined removes a field) and deletes tokens', () => {
    const doc = new Y.Doc()
    addFolderToken(doc, 'colors', 'brand', { name: 'Brand', value: '#123456' })
    addFolderToken(doc, 'effectStyles', 'soft', {
      name: 'Soft',
      kind: 'shadow',
      params: { blur: 8, opacity: 0.4 },
    })
    addFolderToken(doc, 'textStyles', 'h', { name: 'H', size: 40, textTransform: 'uppercase' })
    expect(updateFolderToken(doc, 'textStyles', 'h', { size: 48, textTransform: undefined })).toBe(
      true,
    )
    expect(updateFolderToken(doc, 'colors', 'missing', { value: '#000000' })).toBe(false)
    const t = readFolderTokens(doc)
    expect(t.colors['brand']).toEqual({ id: 'brand', name: 'Brand', value: '#123456' })
    expect(t.effectStyles['soft']).toEqual({
      id: 'soft',
      name: 'Soft',
      kind: 'shadow',
      params: { blur: 8, opacity: 0.4 },
    })
    expect(t.textStyles['h']).toEqual({ id: 'h', name: 'H', size: 48 })
    expect(deleteFolderToken(doc, 'colors', 'brand')).toBe(true)
    expect(deleteFolderToken(doc, 'colors', 'brand')).toBe(false)
    expect(readFolderTokens(doc).colors).toEqual({})
  })

  it('migrates an old seed: builtin flags and the footnote name', () => {
    const doc = new Y.Doc()
    addFolderToken(doc, 'textStyles', 'a', { name: 'Title', size: 96 })
    addFolderToken(doc, 'textStyles', 'b', { name: 'Footnote', size: 11 })
    addFolderToken(doc, 'textStyles', 'c', { name: 'Footnote', size: 9, builtin: false })
    expect(migrateFolderTokens(doc)).toBe(true)
    const t = readFolderTokens(doc).textStyles
    expect(t['a']).toMatchObject({ name: 'Title', builtin: true })
    expect(t['b']).toMatchObject({ name: 'Footnotes and pages', builtin: true })
    expect(t['c']).toMatchObject({ name: 'Footnote' })
    expect(migrateFolderTokens(doc)).toBe(false)
  })

  it('reads a token without a stored id under its key', () => {
    const folder = new Y.Doc()
    const colors = new Y.Map<unknown>()
    folder.getMap('tokens').set('colors', colors)
    const brand = new Y.Map<unknown>()
    colors.set('c1', brand)
    brand.set('name', 'Brand')
    brand.set('value', '#123456')
    expect(readFolderTokens(folder)).toEqual({
      colors: { c1: { id: 'c1', name: 'Brand', value: '#123456' } },
      textStyles: {},
      effectStyles: {},
    })
  })
})
