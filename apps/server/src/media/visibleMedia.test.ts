/**
 * media/visibleMedia.test.ts — which media a deck or a component master may
 * show: its own, and its folder's components' and the folder's own, never
 * another deck's or another folder's.
 */

import { describe, expect, it } from 'vitest'
import { visibleIn, type MediaHolder, type MediaPlacement } from './visibleMedia.js'

const deckRow = (deckId: string): MediaPlacement => ({
  deckId,
  componentId: null,
  folderId: null,
  componentFolderId: null,
})
const componentRow = (componentId: string, folder: string): MediaPlacement => ({
  deckId: null,
  componentId,
  folderId: null,
  componentFolderId: folder,
})
const folderRow = (folderId: string): MediaPlacement => ({
  deckId: null,
  componentId: null,
  folderId,
  componentFolderId: null,
})

const deckInF: MediaHolder = { owner: { deckId: 'd1' }, folderId: 'F' }
const masterInF: MediaHolder = { owner: { componentId: 'c1' }, folderId: 'F' }
const deckInNoFolder: MediaHolder = { owner: { deckId: 'd9' }, folderId: null }

describe('visibleIn', () => {
  it('shows a document its own media', () => {
    expect(visibleIn(deckRow('d1'), deckInF)).toBe(true)
    expect(visibleIn(componentRow('c1', 'F'), masterInF)).toBe(true)
  })

  it('never shows another deck’s media, in the same folder or not', () => {
    expect(visibleIn(deckRow('d2'), deckInF)).toBe(false)
    expect(visibleIn(deckRow('d1'), masterInF)).toBe(false)
  })

  it('links the media of every component and of the folder itself, in its folder only', () => {
    expect(visibleIn(componentRow('c2', 'F'), deckInF)).toBe(true)
    expect(visibleIn(componentRow('c2', 'F'), masterInF)).toBe(true)
    expect(visibleIn(folderRow('F'), deckInF)).toBe(true)
    expect(visibleIn(componentRow('c3', 'G'), deckInF)).toBe(false)
    expect(visibleIn(folderRow('G'), deckInF)).toBe(false)
  })

  it('shows a deck in no folder its own media only', () => {
    expect(visibleIn(deckRow('d9'), deckInNoFolder)).toBe(true)
    expect(visibleIn(componentRow('c2', 'F'), deckInNoFolder)).toBe(false)
    expect(visibleIn(folderRow('F'), deckInNoFolder)).toBe(false)
  })
})
