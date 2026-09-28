/**
 * commands/src/testing/fixtureDeck.ts
 *
 * The standard deck every command example runs against. Ids are fixed so
 * examples (which double as model-facing documentation) can reference real
 * things: slides `s1`–`s3`; on `s1` a rectangle `r1`, an ellipse `e1`, a
 * rich text box `t1`, a cropped image `img1`, a 3x3 table `tbl1`, a group
 * `ga`+`gb` (group `grp1`), a three-item bullet list `t2` ("Revenue",
 * "Costs", "Margin"), an image `img2` masked to an ellipse, and animations
 * `a1` (fadeIn on `r1`) then `a2` (fadeIn on `e1`); on `s2` a locked
 * rectangle `lock1`, a 2x3 table `tbl2` whose top row is one merged cell, a
 * line `ln1` from (100, 900) to (500, 900) and an open path `pa1` (a curved
 * stroke through (1200, 800), (1400, 700), (1600, 800)); `s3` is empty; a
 * deck guide `gd1`.
 *
 * Add to it when a new command needs something to act on; never rename.
 */

import * as Y from 'yjs'
import type {
  EllipseObject,
  ImageObject,
  LineObject,
  PathObject,
  RectangleObject,
  TextObject,
} from '@narrative/shared'
import {
  addAnimation,
  addGuide,
  addObjects,
  addSlide,
  addTable,
  applyFormat,
  applyParagraphPatch,
  createSlideDoc,
  getDeckGuidesCtx,
  getSlideAnimationsCtx,
  getSlideObjectsCtx,
  mergeTableCells,
  PARAGRAPH_SEP,
  type DeckMutationContext,
} from '@narrative/slide-model'

export const FIXTURE_SLIDE_IDS = ['s1', 's2', 's3'] as const

function rect(
  id: string,
  x: number,
  y: number,
  extra: Partial<RectangleObject> = {},
): RectangleObject {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 200,
    height: 100,
    fill: 0x4060e0,
    rotation: 0,
    opacity: 1,
    ...extra,
  }
}

export function createFixtureDeck(): DeckMutationContext {
  const deck = createSlideDoc()
  addSlide(deck)
  addSlide(deck)
  // Fixed slide ids (test-only: production ids are nanoids).
  FIXTURE_SLIDE_IDS.forEach((id, i) => deck.slides.get(i).set('id', id))

  const objects = getSlideObjectsCtx(deck, 's1')
  if (objects === null) throw new Error('fixture: slide s1 missing')

  const ellipse: EllipseObject = {
    id: 'e1',
    type: 'ellipse',
    x: 500,
    y: 100,
    width: 150,
    height: 150,
    fill: 0xe06040,
    rotation: 0,
    opacity: 1,
  }
  const text: TextObject = {
    id: 't1',
    type: 'text',
    x: 100,
    y: 400,
    width: 600,
    height: 80,
    text: 'Quarterly results',
    fontSize: 40,
    fontWeight: 'normal',
    color: 0x111111,
    align: 'left',
    rotation: 0,
    opacity: 1,
  }
  const image: ImageObject = {
    id: 'img1',
    type: 'image',
    assetId: 'asset-fixture',
    x: 1000,
    y: 200,
    width: 400,
    height: 300,
    rotation: 0,
    opacity: 1,
    fit: 'cover',
    imageRect: { x: 950, y: 150, width: 600, height: 450 },
  }
  addObjects(objects, [
    rect('r1', 100, 100),
    ellipse,
    text,
    image,
    rect('ga', 100, 700, { groupId: 'grp1' }),
    rect('gb', 350, 700, { groupId: 'grp1' }),
  ])
  const tableId = addTable(objects, { x: 1000, y: 700, width: 600, height: 240, rows: 3, cols: 3 })
  renameById(objects.objects, tableId, 'tbl1')

  // "results" in bold, so rich-text commands have runs to preserve.
  const t1 = objects.objects
    .toArray()
    .find((m) => m.get('id') === 't1')
    ?.get('text')
  if (t1 instanceof Y.Text) deck.doc.transact(() => applyFormat(t1, 10, 7, { fontWeight: 700 }))

  const animations = getSlideAnimationsCtx(deck, 's1')
  if (animations === null) throw new Error('fixture: slide s1 animations missing')
  const step = addAnimation(animations, {
    objectId: 'r1',
    preset: 'fadeIn',
    trigger: 'onEnter',
    duration: 0.6,
    delay: 0,
    easing: 'power2.out',
  })
  renameById(animations.animations, step.id, 'a1')

  const second = addAnimation(animations, {
    objectId: 'e1',
    preset: 'fadeIn',
    trigger: 'afterPrevious',
    duration: 0.6,
    delay: 0,
    easing: 'power2.out',
  })
  renameById(animations.animations, second.id, 'a2')

  const list: TextObject = {
    ...text,
    id: 't2',
    y: 520,
    height: 150,
    fontSize: 28,
    text: ['Revenue', 'Costs', 'Margin'].join(PARAGRAPH_SEP),
  }
  const masked: ImageObject = {
    ...image,
    id: 'img2',
    x: 1500,
    y: 100,
    width: 200,
    height: 200,
    imageRect: { x: 1450, y: 50, width: 300, height: 300 },
    mask: { kind: 'ellipse' },
  }
  addObjects(objects, [list, masked])
  const t2 = objects.objects
    .toArray()
    .find((m) => m.get('id') === 't2')
    ?.get('text')
  if (t2 instanceof Y.Text)
    deck.doc.transact(() => applyParagraphPatch(t2, 0, t2.length, { list: 'bullet' }))

  const s2 = getSlideObjectsCtx(deck, 's2')
  if (s2 === null) throw new Error('fixture: slide s2 missing')
  addObjects(s2, [rect('lock1', 1600, 60, { locked: true, name: 'Logo' })])
  const tbl2 = addTable(s2, { x: 200, y: 300, width: 900, height: 200, rows: 2, cols: 3 })
  renameById(s2.objects, tbl2, 'tbl2')
  mergeTableCells(s2, 'tbl2', { r0: 0, c0: 0, r1: 0, c1: 2 })

  const line: LineObject = {
    id: 'ln1',
    type: 'line',
    x: 100,
    y: 900,
    width: 400,
    height: 0,
    rotation: 0,
    opacity: 1,
    p1: { x: 0, y: 0 },
    p2: { x: 400, y: 0 },
    stroke: 0x1b2a4a,
    strokeWidth: 4,
  }
  const path: PathObject = {
    id: 'pa1',
    type: 'path',
    x: 1200,
    y: 700,
    width: 400,
    height: 100,
    rotation: 0,
    opacity: 1,
    // Handles on both ends of each segment, so both segments curve.
    anchors: [
      { x: 0, y: 100, cpOut: { x: 80, y: -100 } },
      { x: 200, y: 0, cpIn: { x: -80, y: 0 }, cpOut: { x: 80, y: 0 } },
      { x: 400, y: 100, cpIn: { x: -80, y: -100 } },
    ],
    stroke: 0x1b2a4a,
    strokeWidth: 3,
  }
  addObjects(s2, [line, path])

  const guides = getDeckGuidesCtx(deck.doc)
  const guideId = addGuide(guides, 'vertical', 960)
  renameById(guides.guides, guideId, 'gd1')
  return deck
}

/** Test-only: give a freshly created item its fixed fixture id. */
function renameById(arr: Y.Array<Y.Map<unknown>>, from: string, to: string): void {
  const item = arr.toArray().find((m) => m.get('id') === from)
  if (item === undefined) throw new Error(`fixture: '${from}' not found`)
  item.set('id', to)
}
