/**
 * folderPack.test.ts — a folder's style pack in its document (A4.3): set,
 * read back, a merge patch that touches leaves (nested maps merge across
 * peers) and layouts by id, and the plain-JSON merge that validates first.
 */

import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  deleteStylePack,
  hasStylePack,
  mergeStylePackPatch,
  patchStylePack,
  readStylePack,
  setStylePack,
} from './folderPack.js'

const pack = {
  id: 'p',
  name: 'P',
  tokens: { colors: { red: { name: 'Red', value: '#ff0000' } } },
  layouts: [
    { id: 'a', name: 'A', regions: [{ slot: 's' }] },
    { id: 'b', name: 'B', regions: [] },
  ],
}

describe('folder style pack', () => {
  it('stores a pack and reads it back as JSON', () => {
    const doc = new Y.Doc()
    expect(readStylePack(doc)).toBeNull()
    setStylePack(doc, pack)
    expect(hasStylePack(doc)).toBe(true)
    expect(readStylePack(doc)).toEqual(pack)
    deleteStylePack(doc)
    expect(readStylePack(doc)).toBeNull()
  })

  it('patches leaves, layouts by id, and agrees with the plain merge', () => {
    const doc = new Y.Doc()
    setStylePack(doc, pack)
    const patch = {
      tokens: { colors: { red: { value: '#cc0000' }, blue: { name: 'Blue', value: '#0000ff' } } },
      layouts: { a: { name: 'A2' }, b: null, c: { name: 'C', regions: [] } },
      name: null,
    }
    patchStylePack(doc, patch)
    const expected = mergeStylePackPatch(pack, patch)
    expect(readStylePack(doc)).toEqual(expected)
    expect(expected).toMatchObject({
      tokens: { colors: { red: { value: '#cc0000' }, blue: { value: '#0000ff' } } },
      layouts: [
        { id: 'a', name: 'A2', regions: [{ slot: 's' }] },
        { id: 'c', name: 'C', regions: [] },
      ],
    })
    expect(expected).not.toHaveProperty('name')
  })

  it('stores no null a patch puts inside a subtree it creates, as the plain merge has it', () => {
    const doc = new Y.Doc()
    setStylePack(doc, pack)
    const patch = {
      layouts: { c: { name: 'C', surface: null, regions: [] } },
      editorial: { voice: { tone: 'plain', extra: null } },
    }
    patchStylePack(doc, patch)
    const stored = readStylePack(doc)
    expect(stored).toEqual(mergeStylePackPatch(pack, patch))
    expect(JSON.stringify(stored)).not.toContain('null')
  })

  it('merges two peers changing different colours', () => {
    const a = new Y.Doc()
    setStylePack(a, pack)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    patchStylePack(a, { tokens: { colors: { red: { value: '#111111' } } } })
    patchStylePack(b, { tokens: { colors: { blue: { name: 'Blue', value: '#0000ff' } } } })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    expect(readStylePack(a)).toMatchObject({
      tokens: { colors: { red: { value: '#111111' }, blue: { value: '#0000ff' } } },
    })
  })
})
