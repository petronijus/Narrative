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
import { applyParagraphPatch } from '@narrative/slide-model'
import type { ParagraphPatch } from '@narrative/slide-model'
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

  // -------------------------------------------------------------------------
  // Per-paragraph list fidelity (new data model). Each paragraph terminates
  // with U+2029 carrying its own block attrs; getParagraphDeltas reads them
  // on export and emitText maps each to pptxgenjs paragraph-level bullet +
  // indentLevel options. We unzip and assert the produced <a:pPr> XML.
  // -------------------------------------------------------------------------

  /**
   * Build a Y.Text from `paras` (one string per paragraph), apply each
   * paragraph's block patch, and return it cast to the TextObject.text slot.
   * Every paragraph is U+2029-terminated so its attrs have a home.
   */
  function listedText(paras: Array<{ text: string; patch?: ParagraphPatch }>): TextObject['text'] {
    const PS = ' '
    const doc = new Y.Doc()
    const yt = doc.getText('t')
    const body = paras.map((p) => p.text + PS).join('')
    yt.insert(0, body)
    // Separator index of the Nth paragraph (0-based).
    const sepIndex = (n: number): number => {
      let count = -1
      for (let i = 0; i < body.length; i++) {
        if (body[i] === PS) {
          count += 1
          if (count === n) return i
        }
      }
      return -1
    }
    doc.transact(() => {
      paras.forEach((p, i) => {
        if (p.patch === undefined) return
        const at = sepIndex(i)
        applyParagraphPatch(yt, at, at, p.patch)
      })
    })
    return yt as unknown as TextObject['text']
  }

  it('per-paragraph: single-level bullet emits <a:buChar char="•">', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        makeText({
          text: listedText([
            { text: 'one', patch: { list: 'bullet' } },
            { text: 'two', patch: { list: 'bullet' } },
          ]),
        }),
      ]),
    )
    const xml = await getSlide1Xml(buf)
    // U+2022 is emitted as the numeric entity &#x2022;.
    expect(xml).toContain('<a:buChar char="&#x2022;"')
    // Two bulleted paragraphs → two buChar declarations.
    expect(xml.match(/<a:buChar/g)?.length).toBe(2)
  })

  it('per-paragraph: custom glyph rides through bullet.characterCode', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        makeText({
          text: listedText([{ text: 'star', patch: { list: 'bullet', bulletChar: '★' } }]),
        }),
      ]),
    )
    const xml = await getSlide1Xml(buf)
    // ★ = U+2605, emitted as &#x2605;.
    expect(xml).toContain('<a:buChar char="&#x2605;"')
  })

  it('per-paragraph: numbered list with a non-decimal format maps the autonum token', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        makeText({
          text: listedText([
            { text: 'a', patch: { list: 'number', numberFormat: 'lowerAlphaParen' } },
          ]),
        }),
      ]),
    )
    const xml = await getSlide1Xml(buf)
    // lowerAlphaParen → alphaLcParenR.
    expect(xml).toContain('<a:buAutoNum type="alphaLcParenR"')
  })

  it('per-paragraph: nested levels emit <a:pPr lvl="N"> via indentLevel', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        makeText({
          text: listedText([
            { text: 'top', patch: { list: 'bullet' } },
            { text: 'child', patch: { list: 'bullet', level: 1 } },
            { text: 'grand', patch: { list: 'bullet', level: 2 } },
          ]),
        }),
      ]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('lvl="1"')
    expect(xml).toContain('lvl="2"')
    // Top level (level 0/undefined) must NOT carry an lvl attr.
    expect(xml).not.toContain('lvl="0"')
  })

  it('per-paragraph: startAt rides through to <a:buAutoNum startAt="N">', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        makeText({
          text: listedText([
            { text: 'five', patch: { list: 'number', numberFormat: 'decimal', startAt: 5 } },
          ]),
        }),
      ]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:buAutoNum type="arabicPeriod" startAt="5"')
  })

  it('per-paragraph: a mixed box carries bullet, number, plain, and nested in one frame', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([
        makeText({
          height: 240,
          text: listedText([
            { text: 'plain' }, // no list → <a:buNone/>
            { text: 'bul', patch: { list: 'bullet' } },
            { text: 'num', patch: { list: 'number', numberFormat: 'upperRoman' } },
            { text: 'deep', patch: { list: 'bullet', level: 3 } },
          ]),
        }),
      ]),
    )
    const xml = await getSlide1Xml(buf)
    // Plain paragraph suppresses inherited bullets.
    expect(xml).toContain('<a:buNone/>')
    // Bullet + number coexist in the same txBody.
    expect(xml).toContain('<a:buChar char="&#x2022;"')
    expect(xml).toContain('<a:buAutoNum type="romanUcPeriod"')
    // Nested bullet keeps its level.
    expect(xml).toContain('lvl="3"')
    // Exactly four paragraphs — no spurious trailing empty <a:p>.
    expect(xml.match(/<a:p>/g)?.length).toBe(4)
  })

  it('per-paragraph data overrides the legacy frame-wide listStyle', async () => {
    // Even though listStyle='numbered' is set, a paragraph carrying its own
    // bullet attrs takes precedence (no frame-wide buAutoNum on every para).
    const buf = await exportDeckToPptx(
      singleSlide([
        makeText({
          listStyle: 'numbered',
          text: listedText([{ text: 'b', patch: { list: 'bullet' } }]),
        } as Partial<TextObject>),
      ]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:buChar char="&#x2022;"')
    expect(xml).not.toContain('<a:buAutoNum')
  })

  it('legacy frame-wide listStyle still applies when no paragraph carries list attrs', async () => {
    // Un-migrated deck: Y.Text with paragraphs but zero block attrs → the
    // exporter falls back to obj.listStyle.
    const buf = await exportDeckToPptx(
      singleSlide([
        makeText({
          listStyle: 'numbered',
          text: listedText([{ text: 'x' }, { text: 'y' }]),
        } as Partial<TextObject>),
      ]),
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

  it('emits cap="all" for a text object with textTransform="uppercase" (V2 bidirectional)', async () => {
    // Parity test for the V2 import fix: parser inherits `cap="all"` from
    // layout/master defaults. Export must mirror it back so a round-trip
    // preserves the uppercase styling.
    const buf = await exportDeckToPptx(
      singleSlide([makeText({ text: 'Title', textTransform: 'uppercase' })]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('cap="all"')
  })

  it('emits cap="small" for textTransform="lowercase" (V2 bidirectional)', async () => {
    const buf = await exportDeckToPptx(
      singleSlide([makeText({ text: 'Title', textTransform: 'lowercase' })]),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('cap="small"')
  })

  it('preserves newline-separated paragraphs through pptxgenjs (C1 bidirectional)', async () => {
    // Parity test for the C1 import fix: parser emits `\n` for `<a:br>`
    // between author lines. Export should re-emit those `\n` boundaries
    // as separate `<a:p>` paragraphs (pptxgenjs's native behavior), so
    // a re-import lands them back as `\n` in the text.
    const buf = await exportDeckToPptx(
      singleSlide([makeText({ text: 'first line\nsecond line\nthird line' })]),
    )
    const xml = await getSlide1Xml(buf)
    const paragraphCount = (xml.match(/<a:p>/g) ?? []).length
    expect(paragraphCount).toBeGreaterThanOrEqual(3)
    expect(xml).toContain('first line')
    expect(xml).toContain('second line')
    expect(xml).toContain('third line')
  })

  it('round-trips VideoObject.posterAssetId via pptxgenjs `cover` (R2 bidirectional)', async () => {
    // Parity test for R2: the import writer now emits ONE VideoObject
    // carrying `posterAssetId`, not a sibling ImageObject. On export,
    // `emitVideo` resolves the poster's bytes via the AssetLoader and
    // passes them to pptxgenjs as the `cover` option — pptxgenjs writes
    // a `<p:pic>/<p:blipFill>` referencing the poster image alongside
    // the `<a:videoFile>` rel. On re-import the parser sees the blip
    // + videoFile and reconstructs the same VideoObject + posterAssetId,
    // closing the loop without duplicating shapes per cycle.
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [
          {
            id: 'video',
            type: 'video',
            x: 100,
            y: 100,
            width: 400,
            height: 300,
            rotation: 0,
            opacity: 1,
            assetId: 'video-asset',
            posterAssetId: 'poster-asset',
            fit: 'contain',
            muted: true,
            autoplay: false,
          },
        ],
        animations: [],
        transition: DEFAULT_TRANSITION,
      } as unknown as Slide,
    ]
    // Identifiable poster bytes so we can confirm they landed in the
    // embedded media (not just pptxgenjs's stock play-button cover).
    const posterBytes = Buffer.from('NARRATIVE_POSTER_BYTES_R2_TEST_FIXTURE')
    let posterLoaderHits = 0
    const buf = await exportDeckToPptx(slides, {
      assetLoader: async (id) => {
        if (id === 'poster-asset') {
          posterLoaderHits++
          return { bytes: posterBytes, mimeType: 'image/jpeg' }
        }
        if (id === 'video-asset') return { bytes: Buffer.from([0, 0, 0, 0]), mimeType: 'video/mp4' }
        return null
      },
    })
    // The loader must have been called for the poster — that's our
    // signal that `emitVideo` actually picked up `posterAssetId`.
    expect(posterLoaderHits).toBe(1)
    const xml = await getSlide1Xml(buf)
    // The video lands as a `<p:pic>`; pptxgenjs `cover` writes the
    // poster bytes into a media part referenced from `<p:blipFill>`.
    expect(xml.toLowerCase()).toContain('videofile')
    expect(xml).toContain('<p:pic>')
    // Confirm the poster bytes ended up in the zip's media folder. We
    // can't easily search for "<p:blipFill" referencing the exact rId,
    // but the presence of the poster bytes in any embedded media file
    // tells us pptxgenjs accepted our cover data URL.
    const zip = await JSZip.loadAsync(buf)
    const mediaEntries = Object.values(zip.files).filter(
      (entry) => entry.name.startsWith('ppt/media/') && !entry.dir,
    )
    expect(mediaEntries.length).toBeGreaterThan(0)
    let foundPoster = false
    for (const entry of mediaEntries) {
      const bytes = await entry.async('nodebuffer')
      if (bytes.includes(posterBytes)) {
        foundPoster = true
        break
      }
    }
    expect(foundPoster, 'poster bytes were not embedded in the .pptx').toBe(true)
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

  // ─── M29 Phase 4 — first-class TableObject export ──────────────────────────

  it('emits an <a:tbl> for a first-class TableObject with per-cell text', async () => {
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [
          {
            id: 't1',
            type: 'table',
            x: 100,
            y: 100,
            width: 400,
            height: 200,
            rotation: 0,
            opacity: 1,
            colWidths: [200, 200],
            rowHeights: [100, 100],
            rows: [
              [{ text: 'A1' }, { text: 'B1' }],
              [{ text: 'A2' }, { text: 'B2' }],
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
          },
        ],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ]
    const buf = await exportDeckToPptx(slides)
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:tbl>')
    expect(xml).toContain('<a:tblGrid>')
    expect(xml).toContain('<a:gridCol')
    expect(xml).toContain('<a:tr')
    expect(xml).toContain('<a:t>A1</a:t>')
    expect(xml).toContain('<a:t>B2</a:t>')
  })

  it('emits gridSpan on the origin cell when a TableObject has a merged span', async () => {
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [
          {
            id: 't1',
            type: 'table',
            x: 0,
            y: 0,
            width: 400,
            height: 100,
            rotation: 0,
            opacity: 1,
            colWidths: [200, 200],
            rowHeights: [100],
            rows: [
              [
                { text: 'Header', gridSpan: 2 },
                // Continuation cell — exporter must skip it so pptxgenjs
                // emits gridSpan="2" on the origin without ALSO emitting
                // a duplicate `<a:tc>` for the covered slot.
                { text: '', mergeOriginR: 0, mergeOriginC: 0 },
              ],
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
          },
        ],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ]
    const buf = await exportDeckToPptx(slides)
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('gridSpan="2"')
    expect(xml).toContain('<a:t>Header</a:t>')
    // hMerge marker on the covered slot — pptxgenjs writes one even
    // though our row array only included the origin.
    expect(xml).toContain('hMerge="1"')
  })

  // ─── M29 fidelity round (export side) ──────────────────────────────────────

  function makeTableSlide(table: Partial<import('@narrative/shared').TableObject>): Slide[] {
    const base: import('@narrative/shared').TableObject = {
      id: 't1',
      type: 'table',
      x: 100,
      y: 100,
      width: 400,
      height: 200,
      rotation: 0,
      opacity: 1,
      colWidths: [200, 200],
      rowHeights: [100, 100],
      rows: [
        [{ text: 'A1' }, { text: 'B1' }],
        [{ text: 'A2' }, { text: 'B2' }],
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
    return [
      {
        id: 's1',
        objects: [{ ...base, ...table }],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ]
  }

  it('emits per-edge cell borders read from table.borderSegments', async () => {
    // 2×2 table where the left edge of cell (0,0) is a thick red stroke
    // (v:0:0) and the inner horizontal divider (h:1:0) is a green dashed
    // stroke. Both come from the new flat segment map — no legacy
    // cell.border anywhere. Exported per-cell <a:lnL/T/R/B> should
    // surface both styles.
    const buf = await exportDeckToPptx(
      makeTableSlide({
        borderSegments: {
          'v:0:0': { color: 0xff0000, width: 4 },
          'h:1:0': { color: 0x00aa00, width: 2, dash: 'dash' },
        },
      }),
    )
    const xml = await getSlide1Xml(buf)
    // Red 4px stroke landed somewhere (on the cell that owns v:0:0).
    expect(xml.toUpperCase()).toContain('FF0000')
    // Green stroke landed too.
    expect(xml.toUpperCase()).toContain('00AA00')
    // Dashed declared via prstDash. pptxgenjs maps our `dash` to `sysDash`
    // — see node_modules/pptxgenjs/dist/pptxgen.cjs.js for the literal map.
    expect(xml).toMatch(/<a:prstDash val="sysDash"/i)
  })

  it('emits a <a:gradFill> inside <a:tcPr> for a cell with a gradient fillStyle', async () => {
    const buf = await exportDeckToPptx(
      makeTableSlide({
        rows: [
          [
            {
              text: 'gradient',
              fillStyle: {
                kind: 'linearGradient',
                angleDeg: 90,
                stops: [
                  { offset: 0, color: 0xff0000 },
                  { offset: 1, color: 0x0000ff },
                ],
              },
            },
            { text: '' },
          ],
          [{ text: '' }, { text: '' }],
        ],
      }),
    )
    const xml = await getSlide1Xml(buf)
    // gradFill landed inside the table (somewhere in slide1.xml).
    expect(xml).toContain('<a:gradFill')
    // Both stop colours present.
    expect(xml.toUpperCase()).toContain('FF0000')
    expect(xml.toUpperCase()).toContain('0000FF')
  })

  it('emits fontFace + italic + underline + lineSpacingMultiple from TableDefaults', async () => {
    const buf = await exportDeckToPptx(
      makeTableSlide({
        defaults: {
          fontFamily: 'Comic Sans MS',
          fontSize: 18,
          fontWeight: 'normal',
          italic: true,
          underline: true,
          lineHeight: 1.5,
          letterSpacing: 2,
          color: 0x111111,
          align: 'left',
          vAlign: 'middle',
          padding: { top: 8, right: 8, bottom: 8, left: 8 },
        },
      }),
    )
    const xml = await getSlide1Xml(buf)
    // fontFace lands as <a:latin typeface="Comic Sans MS"/>.
    expect(xml).toContain('typeface="Comic Sans MS"')
    // PPTX italic = i="1" on each <a:rPr>; underline = u="sng".
    expect(xml).toMatch(/i="1"/)
    expect(xml).toMatch(/u="sng"/)
    // lineSpacingMultiple writes <a:lnSpc>/<a:spcPct val="150000"/>.
    expect(xml).toContain('spcPct')
  })

  it('emits cell-level italic + underline overrides for a single cell', async () => {
    const buf = await exportDeckToPptx(
      makeTableSlide({
        rows: [
          [{ text: 'plain' }, { text: 'fancy', italic: true, underline: true }],
          [{ text: '' }, { text: '' }],
        ],
      }),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toMatch(/i="1"/)
    expect(xml).toMatch(/u="sng"/)
  })

  it('emits transparency on a cell with fillAlpha < 1', async () => {
    const buf = await exportDeckToPptx(
      makeTableSlide({
        rows: [
          [{ text: 'translucent', fill: 0x88ccff, fillAlpha: 0.4 }, { text: '' }],
          [{ text: '' }, { text: '' }],
        ],
      }),
    )
    const xml = await getSlide1Xml(buf)
    // pptxgenjs emits transparency via <a:alpha val="..."/>. 0.4 alpha →
    // 60% transparency → alpha val 40000 (40% opacity) in PPTX EMU
    // convention. The exact number depends on rounding; we just assert an
    // <a:alpha> is present somewhere in the cell fill.
    expect(xml).toContain('<a:alpha')
  })

  // ─── M29 field-level round-trip ─────────────────────────────────────────────

  it('round-trips a feature-rich TableObject through export → parser', async () => {
    // Build a TableObject exercising every M29 surface that should survive
    // a round-trip: borderSegments, cell gradient fill, cell solid fill,
    // cell fillAlpha, padding, merge spans, default typography (font /
    // size / colour / lineHeight / letterSpacing / paragraphSpace / align),
    // per-cell colour override.
    const sourceTable: import('@narrative/shared').TableObject = {
      id: 't1',
      type: 'table',
      x: 100,
      y: 100,
      width: 400,
      height: 200,
      rotation: 0,
      opacity: 1,
      colWidths: [200, 200],
      rowHeights: [100, 100],
      rows: [
        [
          { text: 'A1', color: 0x0066cc },
          {
            text: 'gradient',
            fillStyle: {
              kind: 'linearGradient',
              angleDeg: 90,
              stops: [
                { offset: 0, color: 0xff0000 },
                { offset: 1, color: 0x0000ff },
              ],
            },
          },
        ],
        [
          { text: 'merged', gridSpan: 2 },
          { text: '', mergeOriginR: 1, mergeOriginC: 0 },
        ],
      ],
      defaults: {
        fontFamily: 'Inter',
        fontSize: 24,
        fontWeight: 'normal',
        color: 0x111111,
        align: 'center',
        vAlign: 'middle',
        lineHeight: 1.4,
        border: { color: 0xaaaaaa, width: 1 },
        padding: { top: 8, right: 8, bottom: 8, left: 8 },
      },
      borderSegments: {
        // Outer top of the table (h:0:0, h:0:1) — thick red.
        'h:0:0': { color: 0xff3300, width: 4 },
        'h:0:1': { color: 0xff3300, width: 4 },
      },
    }
    const buf = await exportDeckToPptx([
      {
        id: 's1',
        objects: [sourceTable],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ])
    const { parsePptx } = await import('./parser.js')
    const parsed = await parsePptx(buf)
    // Single slide, single shape, kind = table.
    expect(parsed.slides).toHaveLength(1)
    expect(parsed.slides[0]!.shapes).toHaveLength(1)
    const tbl = parsed.slides[0]!.shapes[0]!
    expect(tbl.kind).toBe('table')
    expect(tbl.tableCells).toBeDefined()
    expect(tbl.tableCells).toHaveLength(2)
    expect(tbl.tableCells![0]).toHaveLength(2)
    // Cell text round-trips.
    expect(tbl.tableCells![0]![0]!.text).toBe('A1')
    expect(tbl.tableCells![0]![1]!.text).toBe('gradient')
    expect(tbl.tableCells![1]![0]!.text).toBe('merged')
    // Merge: origin carries gridSpan=2; continuation cell carries pointer.
    expect(tbl.tableCells![1]![0]!.gridSpan).toBe(2)
    expect(tbl.tableCells![1]![1]!.mergeOriginR).toBe(1)
    expect(tbl.tableCells![1]![1]!.mergeOriginC).toBe(0)
    // Cell gradient survives — parser stores it as fillGradient.
    const g = tbl.tableCells![0]![1]!.fillGradient
    expect(g).toBeDefined()
    expect(g!.kind).toBe('linearGradient')
    expect(g!.stops).toHaveLength(2)
    expect(g!.stops[0]!.color).toBe(0xff0000)
    expect(g!.stops[1]!.color).toBe(0x0000ff)
    // Top-row outer-edge segment from borderSegments lands as the cell's
    // top edge after re-import — PPTX cells own their four edges,
    // segment-vs-cell is an internal Narrative distinction. The thick red
    // 4px stroke from h:0:0 / h:0:1 should appear on row-0 cells' top.
    const topEdge00 = tbl.tableCells![0]![0]!.border?.top
    expect(topEdge00).toBeDefined()
    expect(topEdge00!.color).toBe(0xff3300)
    // Per-cell colour override survives.
    expect(tbl.tableCells![0]![0]!.color).toBe(0x0066cc)
  })

  it('preserves a Y.Text-backed cell body across per-run splits', async () => {
    // Post-F15 behaviour: a Y.Text body with mid-cell formatting is
    // split into multiple `<a:r>` runs via the XML splice pass. The
    // concatenated text still reads correctly (just across two `<a:t>`
    // elements instead of one). This replaces the earlier "flattens to
    // a single string" test that captured the pre-F15 limitation.
    const doc = new Y.Doc()
    const yt = doc.getText('cell-text')
    yt.insert(0, 'Hello world')
    yt.format(0, 5, { fontFamily: 'Inter' })
    const buf = await exportDeckToPptx(
      makeTableSlide({
        rows: [
          [{ text: yt }, { text: '' }],
          [{ text: '' }, { text: '' }],
        ],
      }),
    )
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('<a:t>Hello</a:t>')
    expect(xml).toContain('<a:t> world</a:t>')
    expect(xml).toContain('typeface="Inter"')
  })

  // ─── M-fidelity batch (F1-F15) ─────────────────────────────────────────────

  it('F1 — emits rectRadius for a rectangle with cornerRadius', async () => {
    const buf = await exportDeckToPptx(singleSlide([makeRect({ cornerRadius: 20 })]))
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('roundRect')
    // pptxgenjs encodes rectRadius as `<a:gd name="adj" fmla="val NNNNN"/>`.
    // For w=288, h=144 (shortSide=144), radius=20 → fraction=0.139 → ~6944
    // in PPTX's 50000-unit "val" range (val 50000 = 100%).
    expect(xml).toMatch(/<a:gd[^>]*fmla="val \d+"/)
  })

  it('F2 — emits flipH/flipV on a rectangle', async () => {
    const buf = await exportDeckToPptx(singleSlide([makeRect({ flipH: true, flipV: true })]))
    const xml = await getSlide1Xml(buf)
    expect(xml).toContain('flipH="1"')
    expect(xml).toContain('flipV="1"')
  })

  it('F3 — emits <a:hlinkClick action="ppaction://hlinksldjump"> for slide-jump hyperlink', async () => {
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [
          makeText({
            text: 'jump',
            hyperlink: { kind: 'slide', slideId: 's2' },
          }),
        ],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
      {
        id: 's2',
        objects: [],
        animations: [],
        transition: DEFAULT_TRANSITION,
      },
    ]
    const buf = await exportDeckToPptx(slides)
    const xml = await getSlide1Xml(buf)
    expect(xml).toMatch(/<a:hlinkClick[^>]*action="ppaction:\/\/hlinksldjump"/i)
  })

  it('F4 — emits stretch sizing for an image with fit=contain', async () => {
    const slides: Slide[] = singleSlide([
      {
        id: 'img1',
        type: 'image',
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        rotation: 0,
        opacity: 1,
        assetId: 'asset-1',
        fit: 'contain',
      },
    ])
    const buf = await exportDeckToPptx(slides, {
      assetLoader: async () => ({
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        mimeType: 'image/jpeg',
      }),
    })
    const xml = await getSlide1Xml(buf)
    // pptxgenjs's 'contain' mode emits a <a:stretch><a:fillRect ...> with
    // negative l/t insets to letterbox; either form is acceptable.
    expect(xml).toMatch(/<a:stretch>|<a:srcRect/)
  })

  it('F5 — emits <a:fld type="slidenum"> for an isSlideNumber TextObject', async () => {
    const buf = await exportDeckToPptx(singleSlide([makeText({ text: '#', isSlideNumber: true })]))
    const xml = await getSlide1Xml(buf)
    expect(xml).toMatch(/<a:fld[^>]*type="slidenum"/)
  })

  it('F6 — emits <a:gradFill> on the slide background for a linear-gradient bg', async () => {
    const slides: Slide[] = [
      {
        id: 's1',
        objects: [],
        animations: [],
        transition: DEFAULT_TRANSITION,
        background: {
          kind: 'linearGradient',
          angleDeg: 90,
          stops: [
            { offset: 0, color: 0xff0000 },
            { offset: 1, color: 0x0000ff },
          ],
        },
      },
    ]
    const buf = await exportDeckToPptx(slides)
    const xml = await getSlide1Xml(buf)
    // The bg should now carry a gradFill, not just a solid placeholder.
    const bgMatch = xml.match(/<p:bg>[\s\S]*?<\/p:bg>/)
    expect(bgMatch).not.toBeNull()
    expect(bgMatch![0]).toContain('<a:gradFill')
    // Both stop colours present in the bg.
    expect(bgMatch![0].toUpperCase()).toContain('FF0000')
    expect(bgMatch![0].toUpperCase()).toContain('0000FF')
  })

  it('F10 — emits prstGeom prst="ellipse" on a <p:pic> with an ellipse mask', async () => {
    const slides: Slide[] = singleSlide([
      {
        id: 'img1',
        type: 'image',
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        rotation: 0,
        opacity: 1,
        assetId: 'asset-1',
        mask: { kind: 'ellipse' },
      },
    ])
    const buf = await exportDeckToPptx(slides, {
      assetLoader: async () => ({
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        mimeType: 'image/jpeg',
      }),
    })
    const xml = await getSlide1Xml(buf)
    // Find the picture's spPr — it should now carry an ellipse prstGeom.
    expect(xml).toMatch(/<a:prstGeom prst="ellipse"/)
  })

  it('F11 — emits <a:effectLst><a:blur> for a shape with blur > 0', async () => {
    const buf = await exportDeckToPptx(singleSlide([makeRect({ blur: 8 })]))
    const xml = await getSlide1Xml(buf)
    expect(xml).toMatch(/<a:blur[^>]*rad="\d+"/)
  })

  it('F15 — splices per-run <a:r> into a table cell with rich Y.Text body', async () => {
    const doc = new Y.Doc()
    const yt = doc.getText('cell-text')
    yt.insert(0, 'Hello world')
    yt.format(0, 5, { fontWeight: 700, color: 0xff0000 })
    const buf = await exportDeckToPptx(
      makeTableSlide({
        rows: [
          [{ text: yt }, { text: '' }],
          [{ text: '' }, { text: '' }],
        ],
      }),
    )
    const xml = await getSlide1Xml(buf)
    // Two `<a:r>` runs inside the rich cell: one bold/red ("Hello"), one
    // default (" world"). The XML splice replaces the single concatenated
    // `<a:r>` pptxgenjs emitted with the per-run sequence.
    const helloIdx = xml.indexOf('<a:t>Hello</a:t>')
    const worldIdx = xml.indexOf('<a:t> world</a:t>')
    expect(helloIdx).toBeGreaterThan(-1)
    expect(worldIdx).toBeGreaterThan(-1)
    expect(worldIdx).toBeGreaterThan(helloIdx)
    // Bold marker on the first run.
    expect(xml.slice(helloIdx - 200, helloIdx)).toMatch(/<a:rPr[^>]*b="1"/)
    expect(xml.slice(helloIdx - 200, helloIdx).toUpperCase()).toContain('FF0000')
  })
})
