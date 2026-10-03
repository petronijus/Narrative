/**
 * media/visibleMedia.test.ts — which media a deck or a component master may
 * show: its own, and its folder's components' and the folder's own pictures
 * and videos (never its fonts), never another deck's or another folder's.
 */

import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  linkFolderOf,
  visibleIn,
  visibleInSql,
  type MediaHolder,
  type MediaPlacement,
} from './visibleMedia.js'

type Kind = MediaPlacement['kind']

const deckRow = (deckId: string, kind: Kind = 'image'): MediaPlacement => ({
  deckId,
  componentId: null,
  folderId: null,
  componentFolderId: null,
  kind,
})
const componentRow = (
  componentId: string,
  folder: string,
  kind: Kind = 'image',
): MediaPlacement => ({
  deckId: null,
  componentId,
  folderId: null,
  componentFolderId: folder,
  kind,
})
const folderRow = (folderId: string, kind: Kind = 'image'): MediaPlacement => ({
  deckId: null,
  componentId: null,
  folderId,
  componentFolderId: null,
  kind,
})

const deckInF: MediaHolder = { owner: { deckId: 'd1' }, folderId: 'F' }
const masterInF: MediaHolder = { owner: { componentId: 'c1' }, folderId: 'F' }
const deckInNoFolder: MediaHolder = { owner: { deckId: 'd9' }, folderId: null }

describe('visibleIn', () => {
  it('shows a document its own media', () => {
    expect(visibleIn(deckRow('d1'), deckInF)).toBe(true)
    expect(visibleIn(deckRow('d1', 'font'), deckInF)).toBe(true)
    expect(visibleIn(componentRow('c1', 'F'), masterInF)).toBe(true)
  })

  it('never shows another deck’s media, in the same folder or not', () => {
    expect(visibleIn(deckRow('d2'), deckInF)).toBe(false)
    expect(visibleIn(deckRow('d1'), masterInF)).toBe(false)
  })

  it('links the media of every component and of the folder itself, in its folder only', () => {
    expect(visibleIn(componentRow('c2', 'F'), deckInF)).toBe(true)
    expect(visibleIn(componentRow('c2', 'F', 'video'), deckInF)).toBe(true)
    expect(visibleIn(componentRow('c2', 'F'), masterInF)).toBe(true)
    expect(visibleIn(folderRow('F'), deckInF)).toBe(true)
    expect(visibleIn(folderRow('F', 'video'), masterInF)).toBe(true)
    expect(visibleIn(componentRow('c3', 'G'), deckInF)).toBe(false)
    expect(visibleIn(folderRow('G'), deckInF)).toBe(false)
  })

  it('links pictures and videos only: the folder’s fonts are not slide media', () => {
    expect(visibleIn(folderRow('F', 'font'), deckInF)).toBe(false)
    expect(visibleIn(folderRow('F', 'font'), masterInF)).toBe(false)
    expect(visibleIn(componentRow('c2', 'F', 'font'), deckInF)).toBe(false)
  })

  it('shows a deck in no folder its own media only', () => {
    expect(visibleIn(deckRow('d9'), deckInNoFolder)).toBe(true)
    expect(visibleIn(componentRow('c2', 'F'), deckInNoFolder)).toBe(false)
    expect(visibleIn(folderRow('F'), deckInNoFolder)).toBe(false)
  })
})

describe('linkFolderOf', () => {
  it('is the folder whose documents may link the row', () => {
    expect(linkFolderOf(componentRow('c2', 'F'))).toBe('F')
    expect(linkFolderOf(folderRow('G', 'video'))).toBe('G')
    expect(linkFolderOf(folderRow('G', 'font'))).toBeNull()
    expect(linkFolderOf(deckRow('d1'))).toBeNull()
  })
})

describe('visibleInSql', () => {
  const compile = (holder: MediaHolder) => new PgDialect().sqlToQuery(visibleInSql(holder))

  it('limits the linked rows to pictures and videos', () => {
    const q = compile(deckInF)
    expect(q.sql).toBe(
      '("media_assets"."deck_id" = $1 or ("media_assets"."kind" in ($2, $3) and (("media_assets"."component_id" is not null and "components"."folder_id" = $4) or "media_assets"."folder_id" = $5)))',
    )
    expect(q.params).toEqual(['d1', 'image', 'video', 'F', 'F'])
  })

  it('is the own rows only without a folder', () => {
    expect(compile(deckInNoFolder).sql).toBe('"media_assets"."deck_id" = $1')
  })
})
