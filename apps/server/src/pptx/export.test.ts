/**
 * pptx/export.test.ts
 *
 * Verifies that the exporter emits well-formed `.pptx` bytes with the right
 * coordinate scaling, fill / stroke / alpha attributes, and `<p:bg>` slides.
 * We unzip the result and inspect the slide XML directly — string-search the
 * tags we care about rather than full schema parsing.
 */

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import * as Y from 'yjs'
import { exportDeckToPptx } from './export.js'
import { DEFAULT_TRANSITION } from '@narrative/shared'
import type { Slide, TextObject, RectangleObject } from '@narrative/shared'

async function getSlide1Xml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const entry = zip.file('ppt/slides/slide1.xml')
  expect(entry).not.toBeNull()
  return entry!.async('string')
}

function makeText(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: 't1',
    type: 'text',
    x: 144, // 1 inch in 1920-canvas px (144 px = 1 in @ LAYOUT_WIDE)
    y: 144,
    width: 288,
    height: 72,
    rotation: 0,
    opacity: 1,
    text: 'Hello',
    fontSize: 36, // 36 px → ~18pt at our conversion
    fontWeight: 'normal',
    color: 0x336699,
    align: 'left',
    ...overrides,
  } as TextObject
}

function makeRect(overrides: Partial<RectangleObject> = {}): RectangleObject {
  return {
    id: 'r1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 288,
    height: 144,
    rotation: 0,
    opacity: 1,
    fill: 0xff0000,
    ...overrides,
  } as RectangleObject
}

function singleSlide(objects: Slide['objects'], background?: Slide['background']): Slide[] {
  const slide: Slide = {
    id: 's1',
    objects,
    animations: [],
    transition: DEFAULT_TRANSITION,
  }
  if (background !== undefined) slide.background = background
  return [slide]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exportDeckToPptx', () => {
  it('returns a non-empty Buffer with a ZIP magic header', async () => {
    const buf = await exportDeckToPptx([
      { id: 's1', objects: [], animations: [], transition: DEFAULT_TRANSITION },
    ])
    expect(buf.byteLength).toBeGreaterThan(0)
    expect(buf[0]).toBe(0x50) // 'P'
    expect(buf[1]).toBe(0x4b) // 'K'
  })

  it('emits a <p:txBody> with the right text for a text object', async () => {
    const buf = await exportDeckToPptx(singleSlide([makeText({ text: 'Round-trip me' })]))
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:t>Round-trip me</a:t>')
  })

  it('converts 1920-canvas px → pptx inches consistently', async () => {
    // x=144 px should land at 1 inch = 914400 EMU. pptxgenjs emits the value
    // in EMU within <a:off x="..."/>.
    const buf = await exportDeckToPptx(singleSlide([makeRect({ x: 144, y: 144 })]))
    const xml = await getSlide1Xml(buf)
    // The first <a:off> in slide1.xml belongs to the grpSpPr (always 0,0).
    // The second one is our shape — that's what we want to verify.
    const offs = [...xml.matchAll(/<a:off x="(\d+)" y="(\d+)"\/>/g)]
    expect(offs.length).toBeGreaterThanOrEqual(2)
    const shapeOff = offs[1]!
    const x = Number(shapeOff[1]),
      y = Number(shapeOff[2])
    // Allow ±2000 EMU (≈ 0.002") rounding from the px→inch→EMU pipeline.
    expect(Math.abs(x - 914400)).toBeLessThanOrEqual(2000)
    expect(Math.abs(y - 914400)).toBeLessThanOrEqual(2000)
  })

  it('emits a solid-fill <a:srgbClr> for a rectangle with `fill`', async () => {
    const buf = await exportDeckToPptx(singleSlide([makeRect({ fill: 0xff5733 })]))
    const xml = await getSlide1Xml(buf)
    expect(xml.toUpperCase()).toContain('<A:SRGBCLR VAL="FF5733"/>')
  })

  it('emits a <p:bg> with the slide background colour', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([], { kind: 'color', color: 0xa1b2c3, alpha: 1 }),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml.toUpperCase()).toContain('<P:BG>')
    expect(xml.toUpperCase()).toContain('A1B2C3')
  })

  it('embeds an image via the asset loader callback', async () => {
    // 1×1 red PNG — same trick as the spike script.
    const RED_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    )
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [
          {
            id: 'i1',
            type: 'image',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            rotation: 0,
            opacity: 1,
            assetId: 'asset-abc',
            variant: 'display',
            fit: 'cover',
          },
        ],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ]
    const buf = await exportDeckToPptx(slides, {
      assetLoader: async (id) =>
        id === 'asset-abc' ? { bytes: RED_PNG, mimeType: 'image/png' } : null,
    })
    const zip = await JSZip.loadAsync(buf)
    // pptxgenjs embeds the image under ppt/media/ — file naming varies but
    // there should be at least one image-* entry inside ppt/media/.
    const mediaFiles = Object.keys(zip.files).filter((n) => /^ppt\/media\/image[^/]*$/.test(n))
    expect(mediaFiles.length).toBeGreaterThan(0)
    // slide1.xml should now have a <p:pic> reference.
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<p:pic>')
  })

  it('emits <a:buChar> for a text object with listStyle="bullet"', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([makeText({ text: 'a\nb', listStyle: 'bullet' })]),
    )
    const xml = await getSlide1Xml(buf)
    // pptxgenjs's bullet:true emits <a:buChar char="•"/> per paragraph.
    expect(xml).toContain('<a:buChar')
  })

  it('emits <a:buAutoNum> for a text object with listStyle="numbered"', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([makeText({ text: 'step 1\nstep 2', listStyle: 'numbered' })]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:buAutoNum')
  })

  it('emits a hyperlink option for a TextObject with `hyperlink.kind=url`', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        makeText({
          text: 'Click',
          hyperlink: { kind: 'url', href: 'https://example.com/', target: '_blank' },
        } as Partial<TextObject>),
      ]),
    )
    const xml = await getSlide1Xml(buf)
    // pptxgenjs writes hyperlinks via `<a:hlinkClick r:id="rIdN"/>` on the
    // run, with the URL in the slide's _rels file. Inspecting the rels:
    const zip = await JSZip.loadAsync(buf)
    const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
    expect(rels).toContain('https://example.com/')
    expect(xml).toContain('<a:hlinkClick')
  })

  it('emits per-run formatting from a Y.Text body via toDelta', async () => {
    // Y.Text.format() walks `this.doc.transact()` — the text has to be
    // integrated into a Y.Doc before `format` can apply attrs, otherwise
    // the calls silently no-op and the export collapses back to a flat
    // string. We attach it to a throwaway doc here just to exercise format.
    const doc = new Y.Doc()
    const yt = doc.getText('t')
    yt.insert(0, 'AB')
    yt.format(0, 1, { fontWeight: 700, color: 0xff0000 })
    yt.format(1, 1, { italic: true, color: 0x00ff00 })
    const buf = await exportDeckToPptx(singleSlide([makeText({ text: yt as unknown as string })]))
    const xml = await getSlide1Xml(buf)
    expect(xml.toUpperCase()).toContain('FF0000')
    expect(xml.toUpperCase()).toContain('00FF00')
    expect(xml).toContain('i="1"')
  })

  it('adds speaker notes when notesBySlideId carries an entry for the slide', async () => {
    const slides = singleSlide([])
    const buf = await exportDeckToPptx(slides, {
      notesBySlideId: new Map([['s1', 'Mention the deadline.']]),
    })
    const zip = await JSZip.loadAsync(buf)
    // pptxgenjs writes `ppt/notesSlides/notesSlide1.xml` when addNotes is called.
    const notesFile = zip.file('ppt/notesSlides/notesSlide1.xml')
    expect(notesFile).not.toBeNull()
    const notesXml = await notesFile!.async('string')
    expect(notesXml).toContain('Mention the deadline.')
  })

  it('restores a multi-stop linear gradient in the slide XML via post-processing', async () => {
    // Build a slide with a rectangle carrying a 3-stop linear gradient.
    // Pre-fix, the exported XML had only `<a:solidFill>` (middle stop's
    // colour collapsed). Post-fix, the slide XML should carry a real
    // `<a:gradFill>` with all three stops + the angle.
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [
          {
            id: 'r1',
            type: 'rectangle',
            x: 100,
            y: 200,
            width: 300,
            height: 150,
            rotation: 0,
            opacity: 1,
            fill: 0x000000,
            fillStyle: {
              kind: 'linearGradient',
              angleDeg: 180,
              stops: [
                { offset: 0, color: 0xff0000 },
                { offset: 0.5, color: 0x00ff00 },
                { offset: 1, color: 0x0000ff },
              ],
            },
          } as unknown as RectangleObject,
        ],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ]
    const buf = await exportDeckToPptx(slides)
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:gradFill')
    // All three stop colours present:
    const up = xml.toUpperCase()
    expect(up).toContain('FF0000')
    expect(up).toContain('00FF00')
    expect(up).toContain('0000FF')
    // Linear gradient produces an <a:lin> direction node.
    expect(xml).toContain('<a:lin ')
  })

  it('reconstructs a 2×2 grid of grouped rect+text shapes as a `<a:tbl>`', async () => {
    // Build the same shape layout `parseTable` produces on import: 4 cell
    // rectangles + 4 cell texts, all sharing one groupId. Export should
    // detect the grid and emit `<a:tbl>` instead of 8 individual shapes.
    const groupId = 'gtab1'
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [
          // Row 0
          {
            id: 'r00',
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 96,
            height: 48,
            rotation: 0,
            opacity: 1,
            fill: 0xffffff,
            stroke: 0xcccccc,
            strokeWidth: 1,
            groupId,
          } as RectangleObject,
          {
            id: 't00',
            type: 'text',
            x: 0,
            y: 0,
            width: 96,
            height: 48,
            rotation: 0,
            opacity: 1,
            text: 'A1',
            fontSize: 14,
            fontWeight: 'normal',
            color: 0x000000,
            align: 'left',
            groupId,
          } as unknown as TextObject,
          {
            id: 'r01',
            type: 'rectangle',
            x: 96,
            y: 0,
            width: 96,
            height: 48,
            rotation: 0,
            opacity: 1,
            fill: 0xffffff,
            stroke: 0xcccccc,
            strokeWidth: 1,
            groupId,
          } as RectangleObject,
          {
            id: 't01',
            type: 'text',
            x: 96,
            y: 0,
            width: 96,
            height: 48,
            rotation: 0,
            opacity: 1,
            text: 'B1',
            fontSize: 14,
            fontWeight: 'normal',
            color: 0x000000,
            align: 'left',
            groupId,
          } as unknown as TextObject,
          // Row 1
          {
            id: 'r10',
            type: 'rectangle',
            x: 0,
            y: 48,
            width: 96,
            height: 48,
            rotation: 0,
            opacity: 1,
            fill: 0xffffff,
            stroke: 0xcccccc,
            strokeWidth: 1,
            groupId,
          } as RectangleObject,
          {
            id: 't10',
            type: 'text',
            x: 0,
            y: 48,
            width: 96,
            height: 48,
            rotation: 0,
            opacity: 1,
            text: 'A2',
            fontSize: 14,
            fontWeight: 'normal',
            color: 0x000000,
            align: 'left',
            groupId,
          } as unknown as TextObject,
          {
            id: 'r11',
            type: 'rectangle',
            x: 96,
            y: 48,
            width: 96,
            height: 48,
            rotation: 0,
            opacity: 1,
            fill: 0xffffff,
            stroke: 0xcccccc,
            strokeWidth: 1,
            groupId,
          } as RectangleObject,
          {
            id: 't11',
            type: 'text',
            x: 96,
            y: 48,
            width: 96,
            height: 48,
            rotation: 0,
            opacity: 1,
            text: 'B2',
            fontSize: 14,
            fontWeight: 'normal',
            color: 0x000000,
            align: 'left',
            groupId,
          } as unknown as TextObject,
        ],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ]
    const buf = await exportDeckToPptx(slides)
    const xml = await getSlide1Xml(buf)
    // Result must be an <a:tbl> element with all 4 cell texts.
    expect(xml).toContain('<a:tbl>')
    expect(xml).toContain('<a:t>A1</a:t>')
    expect(xml).toContain('<a:t>B1</a:t>')
    expect(xml).toContain('<a:t>A2</a:t>')
    expect(xml).toContain('<a:t>B2</a:t>')
    // And NOT a flat list of <p:sp> shapes for the cells.
    const spCount = (xml.match(/<p:sp>/g) ?? []).length
    expect(spCount).toBe(0)
  })

  it('leaves non-grid groups alone — emits them as plain grouped shapes', async () => {
    // Two rects that share a groupId but are NOT a uniform grid (different
    // sizes, overlapping). Export should fall through to per-shape emit,
    // NOT collapse them into a 1-cell table.
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [
          {
            id: 'a',
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            rotation: 0,
            opacity: 1,
            fill: 0xff0000,
            groupId: 'gx',
          } as RectangleObject,
          {
            id: 'b',
            type: 'rectangle',
            x: 50,
            y: 50,
            width: 80,
            height: 60,
            rotation: 0,
            opacity: 1,
            fill: 0x00ff00,
            groupId: 'gx',
          } as RectangleObject,
        ],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ]
    const buf = await exportDeckToPptx(slides)
    const xml = await getSlide1Xml(buf)
    expect(xml).not.toContain('<a:tbl>')
    // Both rects emitted as individual `<p:sp>` elements.
    const spCount = (xml.match(/<p:sp>/g) ?? []).length
    expect(spCount).toBeGreaterThanOrEqual(2)
  })

  it('emits a triangle prstGeom for a TriangleObject', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        {
          id: 'tri',
          type: 'triangle',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 0,
          opacity: 1,
          fill: 0xff0000,
        } as unknown as Slide['objects'][number],
      ]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('prst="triangle"')
  })

  it('emits a hexagon prstGeom for a PolygonObject with sides=6', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        {
          id: 'p',
          type: 'polygon',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 0,
          opacity: 1,
          fill: 0x00ff00,
          sides: 6,
        } as unknown as Slide['objects'][number],
      ]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('prst="hexagon"')
  })

  it('emits `triangle` end arrow type for an ArrowObject with endCap="arrow"', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        {
          id: 'a',
          type: 'arrow',
          x: 0,
          y: 0,
          width: 100,
          height: 0,
          rotation: 0,
          opacity: 1,
          stroke: 0x000000,
          strokeWidth: 2,
          p1: { x: 0, y: 0 },
          p2: { x: 100, y: 0 },
          startCap: 'none',
          endCap: 'arrow',
        } as unknown as Slide['objects'][number],
      ]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:tailEnd')
    expect(xml).toContain('triangle')
  })

  it('emits a `<a:custGeom>` with cubicBezTo for a PathObject', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        {
          id: 'path1',
          type: 'path',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 0,
          opacity: 1,
          anchors: [
            { x: 0, y: 0 },
            { x: 50, y: 0, cpIn: { x: -10, y: 10 } },
            { x: 100, y: 100 },
          ],
          stroke: 0x000000,
          strokeWidth: 2,
          fill: 0xff0000,
          closed: true,
        } as unknown as Slide['objects'][number],
      ]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:custGeom>')
    expect(xml).toContain('<a:cubicBezTo>')
    expect(/\<a:close\s*\/>/i.test(xml)).toBe(true)
  })

  it('drops images silently when no asset loader is provided', async () => {
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [
          {
            id: 'i1',
            type: 'image',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            rotation: 0,
            opacity: 1,
            assetId: 'abc',
            variant: 'display',
            fit: 'cover',
          },
          // a valid text object alongside so we still emit a slide body
          makeText({ id: 't2', text: 'kept' }),
        ],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ]
    const buf = await exportDeckToPptx(slides)
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:t>kept</a:t>')
    // No <p:pic> emitted since the image was dropped.
    expect(xml).not.toContain('<p:pic')
  })
})
