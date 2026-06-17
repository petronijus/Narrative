/**
 * lib/pptxCompat.test.ts
 *
 * Unit tests for the compatibility scanner that powers ExportPptxDialog
 * and the import-side warning panel. Each case crafts a minimal Slide
 * snapshot and asserts the right warning shows up (with the right
 * count + severity).
 */

import { describe, it, expect } from 'vitest'
import {
  scanDeckForExportCompat,
  relevantIgnoredElements,
  IMPORT_KNOWN_LOSSES,
  type CompatWarning,
} from './pptxCompat.js'
import { DEFAULT_TRANSITION } from '@narrative/shared'
import type {
  Slide,
  SlideObject,
  TextObject,
  RectangleObject,
  ImageObject,
  VideoObject,
  TableObject,
} from '@narrative/shared'

function wrap(objects: SlideObject[]): Slide {
  return {
    id: 's1',
    objects,
    animations: [],
    transition: DEFAULT_TRANSITION,
  }
}

function findById(warnings: CompatWarning[], id: string): CompatWarning | undefined {
  return warnings.find((w) => w.id === id)
}

const baseText: TextObject = {
  id: 't',
  type: 'text',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  rotation: 0,
  opacity: 1,
  text: 'hi',
  fontSize: 18,
  fontWeight: 'normal',
  color: 0x000000,
  align: 'left',
}

const baseRect: RectangleObject = {
  id: 'r',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  rotation: 0,
  opacity: 1,
  fill: 0xffffff,
}

const baseImage: ImageObject = {
  id: 'img',
  type: 'image',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  assetId: 'a',
}

const baseVideo: VideoObject = {
  id: 'vid',
  type: 'video',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  rotation: 0,
  opacity: 1,
  assetId: 'v',
}

const baseTable: TableObject = {
  id: 'tbl',
  type: 'table',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  rotation: 0,
  opacity: 1,
  colWidths: [100, 100],
  rowHeights: [50, 50],
  rows: [
    [{ text: 'a' }, { text: 'b' }],
    [{ text: 'c' }, { text: 'd' }],
  ],
  defaults: {
    fontSize: 18,
    fontWeight: 'normal',
    color: 0x111111,
    align: 'left',
    vAlign: 'middle',
    border: { color: 0xcccccc, width: 1 },
    padding: { top: 8, right: 8, bottom: 8, left: 8 },
  },
}

describe('scanDeckForExportCompat', () => {
  it('returns no warnings on a vanilla deck', () => {
    const out = scanDeckForExportCompat([wrap([baseText, baseRect])])
    expect(out).toEqual([])
  })

  it('flags imageRotation on rotated images', () => {
    const out = scanDeckForExportCompat([
      wrap([
        { ...baseImage, imageRotation: 0.5 },
        { ...baseImage, id: 'img2', imageRotation: 1.2 },
      ]),
    ])
    const w = findById(out, 'imageRotation')
    expect(w).toBeDefined()
    expect(w!.count).toBe(2)
    expect(w!.severity).toBe('lossy')
  })

  it('flags image-filled shapes (rectangle + ellipse)', () => {
    const slide = wrap([
      { ...baseRect, fillStyle: { kind: 'image', assetId: 'a' } },
      {
        ...baseRect,
        id: 'r2',
        type: 'ellipse',
        fillStyle: { kind: 'image', assetId: 'a' },
      } as unknown as SlideObject,
    ])
    const out = scanDeckForExportCompat([slide])
    const w = findById(out, 'shapeImageFill')
    expect(w).toBeDefined()
    expect(w!.count).toBe(2)
    expect(w!.severity).toBe('simplified')
  })

  it('flags video playback options when any non-default field is set', () => {
    const out = scanDeckForExportCompat([
      wrap([
        { ...baseVideo, autoplay: true },
        { ...baseVideo, id: 'v2', loop: true },
        { ...baseVideo, id: 'v3' }, // baseline — no warning
      ]),
    ])
    const w = findById(out, 'videoPlayback')
    expect(w).toBeDefined()
    expect(w!.count).toBe(2)
    expect(w!.severity).toBe('lossy')
  })

  it('flags custom fonts on text and table defaults', () => {
    const out = scanDeckForExportCompat([
      wrap([
        { ...baseText, fontFamily: 'Inter' },
        {
          ...baseTable,
          defaults: { ...baseTable.defaults, fontFamily: 'Comic Sans MS' },
        },
      ]),
    ])
    const w = findById(out, 'fontEmbed')
    expect(w).toBeDefined()
    expect(w!.count).toBe(2)
    expect(w!.severity).toBe('simplified')
  })

  it('does not warn about multi-level lists (they now round-trip fully)', () => {
    // Per-paragraph list attrs live inside the Y.Text body, which the scanner
    // doesn't even inspect — but assert explicitly that no list-flattening
    // warning is surfaced for a text frame that uses lists.
    const out = scanDeckForExportCompat([
      wrap([{ ...baseText, listStyle: 'numbered' } as unknown as SlideObject]),
    ])
    expect(out.some((w) => /list/i.test(w.id) || /list/i.test(w.title))).toBe(false)
  })

  it('flags textTransform capitalize', () => {
    const out = scanDeckForExportCompat([wrap([{ ...baseText, textTransform: 'capitalize' }])])
    const w = findById(out, 'textTransformCapitalize')
    expect(w).toBeDefined()
    expect(w!.severity).toBe('lossy')
  })

  it('flags free-form group when 2+ non-table objects share a groupId', () => {
    const out = scanDeckForExportCompat([
      wrap([
        { ...baseRect, id: 'a', groupId: 'g1' },
        { ...baseRect, id: 'b', groupId: 'g1' },
        // Single-member group — does NOT trigger the warning.
        { ...baseRect, id: 'c', groupId: 'g2' },
      ]),
    ])
    const w = findById(out, 'freeFormGroup')
    expect(w).toBeDefined()
    // One warning per slide carrying a group ≥ 2; we don't double-count
    // even when multiple groups in the same slide qualify.
    expect(w!.count).toBe(1)
  })

  it('sorts lossy warnings before simplified', () => {
    const out = scanDeckForExportCompat([
      wrap([
        { ...baseImage, imageRotation: 0.5 }, // lossy
        { ...baseRect, fillStyle: { kind: 'image', assetId: 'a' } }, // simplified
      ]),
    ])
    expect(out[0]!.severity).toBe('lossy')
    expect(out[out.length - 1]!.severity).toBe('simplified')
  })
})

describe('relevantIgnoredElements', () => {
  it('filters parser-flagged tags to a curated subset', () => {
    const out = relevantIgnoredElements([
      'a:chart',
      'a:smartArt',
      'a:gd', // not user-relevant
      'p:oleObj',
      'p:cNvPr', // not user-relevant
    ])
    expect(out).toEqual(['a:chart', 'a:smartArt', 'p:oleObj'])
  })

  it('returns an empty array on a clean import', () => {
    expect(relevantIgnoredElements(['a:gd', 'a:avLst'])).toEqual([])
  })
})

describe('IMPORT_KNOWN_LOSSES', () => {
  it('covers every category surfaced via the static panel', () => {
    const ids = IMPORT_KNOWN_LOSSES.map((e) => e.id)
    expect(ids).toContain('charts')
    expect(ids).toContain('smartArt')
    expect(ids).toContain('oleEmbed')
    expect(ids).toContain('nestedGroups')
    expect(ids).toContain('complexTiming')
    expect(ids).toContain('layoutInherit')
  })
})
