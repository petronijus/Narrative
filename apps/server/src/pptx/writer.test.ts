/**
 * pptx/writer.test.ts
 *
 * Verifies that a `ParsedPptx` lowers into a Y.Doc state buffer whose decoded
 * slides match the parser's intermediate form. The interesting bits:
 *   - canvas-space scaling (PPTX 1280×720 → Narrative 1920×1080 is 1.5×)
 *   - text frames get the right align + colour
 *   - rect / ellipse pull fill + stroke + alpha through
 *   - linear gradient becomes a `fillStyle` on the shape
 *   - the default empty slide created by `createSlideDoc` is dropped
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { getParagraphs, PARAGRAPH_SEP } from '@narrative/slide-model'
import { buildDeckUpdate, buildDeckAppendUpdate } from './writer.js'
import type { ParsedPptx, ParsedSlide, ParsedShape } from './parser.js'

/**
 * Decode a deck-update buffer and return the live Y.Text body of the object
 * at `[slideIndex][objIndex]`. The per-paragraph list model lives as block
 * attributes on the Y.Text's paragraph-separator chars, which `toJSON()`
 * flattens away — so list assertions must read the live Y.Text and run it
 * through `getParagraphs`.
 */
function objectYText(state: Buffer, slideIndex: number, objIndex: number): Y.Text {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(state))
  const yslides = doc.getArray<Y.Map<unknown>>('slides')
  const slide = yslides.get(slideIndex)
  const objects = slide.get('objects') as Y.Array<Y.Map<unknown>>
  const obj = objects.get(objIndex)
  return obj.get('text') as Y.Text
}

/** A fully-specified text ParsedShape with sensible geometry defaults. */
function textShape(overrides: Partial<ParsedShape>): ParsedShape {
  return {
    kind: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    rotation: 0,
    sourceTag: 'p:sp',
    ...overrides,
  }
}

/** A parsed deck of one text shape per slide — enough to tell slides apart. */
function deckOf(texts: string[]): ParsedPptx {
  return {
    ...BASE,
    slides: texts.map((text, i) =>
      emptySlide({
        source: `slide${i + 1}.xml`,
        shapes: [
          {
            kind: 'text',
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            rotation: 0,
            text,
            sourceTag: 'p:sp',
          },
        ],
      }),
    ),
  }
}

/** The first text object of every slide, in deck order. */
function slideTexts(slides: Y.Array<Y.Map<unknown>>): string[] {
  return slides.toArray().map((slide) => {
    const objects = slide.get('objects') as Y.Array<Y.Map<unknown>>
    return objects.get(0).get('text')?.toString() ?? ''
  })
}

function emptySlide(overrides: Partial<ParsedSlide> = {}): ParsedSlide {
  return {
    source: 'slide1.xml',
    background: { kind: 'none' },
    shapes: [],
    ...overrides,
  }
}

function applyToFreshDoc(state: Buffer): {
  slides: Array<{
    background: unknown
    objects: Array<Record<string, unknown>>
  }>
} {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(state))
  const yslides = doc.getArray<Y.Map<unknown>>('slides')
  const out: Array<{ background: unknown; objects: Array<Record<string, unknown>> }> = []
  for (let i = 0; i < yslides.length; i++) {
    const s = yslides.get(i)
    const objects = s.get('objects') as Y.Array<Y.Map<unknown>> | undefined
    const bg = s.get('background') as Y.Map<unknown> | undefined
    const objSnapshots: Array<Record<string, unknown>> = []
    if (objects !== undefined) {
      for (let j = 0; j < objects.length; j++) {
        objSnapshots.push(objects.get(j).toJSON() as Record<string, unknown>)
      }
    }
    out.push({ background: bg?.toJSON(), objects: objSnapshots })
  }
  return { slides: out }
}

const BASE: Omit<ParsedPptx, 'slides'> = {
  slideWidth: 1280,
  slideHeight: 720,
  ignoredElements: [],
  distinctElementCount: 0,
  embeddedImages: new Map(),
  embeddedFonts: [],
}

describe('buildDeckUpdate', () => {
  it('produces a Y.Doc with one slide per parsed slide, default slide dropped', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [emptySlide({ source: 'slide1.xml' }), emptySlide({ source: 'slide2.xml' })],
    }
    const { state, slideCount } = buildDeckUpdate(parsed)
    expect(slideCount).toBe(2)
    const doc = applyToFreshDoc(state)
    expect(doc.slides).toHaveLength(2)
  })

  it('scales coordinates from 1280×720 source to 1920×1080 target', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            {
              kind: 'rectangle',
              x: 100,
              y: 200,
              width: 300,
              height: 150,
              rotation: 0,
              fillColor: 0xff0000,
              sourceTag: 'p:sp',
            },
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const doc = applyToFreshDoc(state)
    const rect = doc.slides[0]!.objects[0]!
    // 1920/1280 = 1.5 → 100 * 1.5 = 150, 200 * 1.5 = 300, etc.
    expect(rect['x']).toBe(150)
    expect(rect['y']).toBe(300)
    expect(rect['width']).toBe(450)
    expect(rect['height']).toBe(225)
    expect(rect['fill']).toBe(0xff0000)
  })

  it('maps a text-kind ParsedShape to a TextObject with correct align + vAlign', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            {
              kind: 'text',
              x: 0,
              y: 0,
              width: 200,
              height: 50,
              rotation: 0,
              text: 'Hi',
              fontSize: 24, // px
              textColor: 0x123456,
              textAlign: 'center',
              textVerticalAlign: 'middle',
              bold: true,
              sourceTag: 'p:sp',
            },
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const doc = applyToFreshDoc(state)
    const t = doc.slides[0]!.objects[0]!
    expect(t['type']).toBe('text')
    expect(t['text']).toBe('Hi')
    expect(t['align']).toBe('center')
    expect(t['vAlign']).toBe('middle')
    expect(t['color']).toBe(0x123456)
    expect(t['fontWeight']).toBe('bold')
    expect(t['fontSize']).toBe(36) // 24 px × 1.5 scale
  })

  it('emits fillStyle for a linear gradient + carries fillAlpha through', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            {
              kind: 'rectangle',
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              rotation: 0,
              fillColor: 0x4060e0,
              fillAlpha: 0.5,
              fillGradient: {
                kind: 'linearGradient',
                angleDeg: 90,
                stops: [
                  { offset: 0, color: 0xff0000 },
                  { offset: 1, color: 0x0000ff },
                ],
              },
              sourceTag: 'p:sp',
            },
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const doc = applyToFreshDoc(state)
    const r = doc.slides[0]!.objects[0]!
    expect(r['fillAlpha']).toBe(0.5)
    const fillStyle = r['fillStyle'] as Record<string, unknown>
    expect(fillStyle['kind']).toBe('linearGradient')
    expect(fillStyle['angleDeg']).toBe(90)
    const stops = fillStyle['stops'] as Array<Record<string, unknown>>
    expect(stops).toHaveLength(2)
    expect(stops[0]!['color']).toBe(0xff0000)
  })

  it('applies a solid background to the slide', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [emptySlide({ background: { kind: 'solid', color: 0xabcdef } })],
    }
    const { state } = buildDeckUpdate(parsed)
    const doc = applyToFreshDoc(state)
    const bg = doc.slides[0]!.background as Record<string, unknown>
    expect(bg['kind']).toBe('color')
    expect(bg['color']).toBe(0xabcdef)
  })

  // ─── Per-paragraph list block attributes ─────────────────────────────────
  // The legacy frame-wide `listStyle` is no longer written on import — the
  // per-paragraph model stores list kind/level/glyph/format as block attrs on
  // each paragraph's Y.Text separator. These tests read the live Y.Text via
  // `getParagraphs` to assert that fidelity.

  it('stamps per-paragraph bullet attrs onto the Y.Text (single bullet)', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            textShape({
              text: 'Item',
              textRuns: [{ text: 'Item' }],
              paragraphs: [{ list: 'bullet' }],
            }),
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    // Legacy field is intentionally NOT written anymore.
    const doc = applyToFreshDoc(state)
    expect(doc.slides[0]!.objects[0]!['listStyle']).toBeUndefined()
    // Block attrs ride on the paragraph separator.
    const yt = objectYText(state, 0, 0)
    const paras = getParagraphs(yt)
    expect(paras.map((p) => p.text)).toEqual(['Item'])
    expect(paras[0]!.attrs).toEqual({ list: 'bullet' })
  })

  it('preserves a custom buChar glyph per paragraph', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            textShape({
              text: 'Dash item',
              textRuns: [{ text: 'Dash item' }],
              paragraphs: [{ list: 'bullet', bulletChar: '–' }],
            }),
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const paras = getParagraphs(objectYText(state, 0, 0))
    expect(paras[0]!.attrs).toEqual({ list: 'bullet', bulletChar: '–' })
  })

  it('carries numberFormat + startAt for numbered paragraphs', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            textShape({
              text: 'Step',
              textRuns: [{ text: 'Step' }],
              paragraphs: [{ list: 'number', numberFormat: 'lowerAlphaParen', startAt: 3 }],
            }),
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const paras = getParagraphs(objectYText(state, 0, 0))
    expect(paras[0]!.attrs).toEqual({
      list: 'number',
      numberFormat: 'lowerAlphaParen',
      startAt: 3,
    })
  })

  it('carries multi-level nesting (level) on each paragraph', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            textShape({
              // Three <a:p>: level 0, 1, 2 — separators between, trailing on last.
              text: 'A\nB\nC',
              textRuns: [
                { text: 'A' },
                { text: PARAGRAPH_SEP },
                { text: 'B' },
                { text: PARAGRAPH_SEP },
                { text: 'C' },
              ],
              paragraphs: [
                { list: 'bullet' },
                { list: 'bullet', level: 1 },
                { list: 'bullet', level: 2 },
              ],
            }),
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const paras = getParagraphs(objectYText(state, 0, 0))
    expect(paras.map((p) => p.text)).toEqual(['A', 'B', 'C'])
    expect(paras.map((p) => p.attrs.level ?? 0)).toEqual([0, 1, 2])
    expect(paras.every((p) => p.attrs.list === 'bullet')).toBe(true)
  })

  it('handles a mixed box: bullet, plain, numbered paragraphs', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            textShape({
              text: 'Bullet\nPlain\nNumber',
              textRuns: [
                { text: 'Bullet' },
                { text: PARAGRAPH_SEP },
                { text: 'Plain' },
                { text: PARAGRAPH_SEP },
                { text: 'Number' },
              ],
              paragraphs: [
                { list: 'bullet' },
                {}, // plain paragraph — no list, no level
                { list: 'number', numberFormat: 'decimal' },
              ],
            }),
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const paras = getParagraphs(objectYText(state, 0, 0))
    expect(paras.map((p) => p.text)).toEqual(['Bullet', 'Plain', 'Number'])
    expect(paras[0]!.attrs).toEqual({ list: 'bullet' })
    expect(paras[1]!.attrs).toEqual({}) // plain
    expect(paras[2]!.attrs).toEqual({ list: 'number', numberFormat: 'decimal' })
  })

  it('leaves a plain (non-list) frame without paragraph separators', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            textShape({
              text: 'Just text',
              textRuns: [{ text: 'Just text' }],
              // No `paragraphs` → string fast-path, no trailing separator.
            }),
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const yt = objectYText(state, 0, 0)
    expect(yt.toString()).toBe('Just text')
    const paras = getParagraphs(yt)
    expect(paras).toHaveLength(1)
    expect(paras[0]!.attrs).toEqual({})
  })

  it('preserves master → layout → slide paint order in the resulting object list', async () => {
    // Mirrors the production parser's bake order: master shapes come first
    // in `ParsedSlide.shapes`, then layout shapes, then slide-native shapes.
    // The writer iterates in array order and `addObject` appends, so the
    // resulting object array should match that order — guaranteeing master
    // content paints UNDER slide content.
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            // Master rect — emits FIRST
            {
              kind: 'rectangle',
              x: 0,
              y: 0,
              width: 50,
              height: 50,
              rotation: 0,
              fillColor: 0xff0000,
              sourceTag: 'p:sp',
            },
            // Layout rect — emits SECOND
            {
              kind: 'rectangle',
              x: 60,
              y: 0,
              width: 50,
              height: 50,
              rotation: 0,
              fillColor: 0x00ff00,
              sourceTag: 'p:sp',
            },
            // Slide-native text — emits LAST (on top)
            {
              kind: 'text',
              x: 0,
              y: 0,
              width: 200,
              height: 50,
              rotation: 0,
              text: 'On top',
              sourceTag: 'p:sp',
            },
          ],
        }),
      ],
    }
    const { state, objectsCreated } = buildDeckUpdate(parsed)
    expect(objectsCreated).toBe(3)
    const doc = applyToFreshDoc(state)
    const objs = doc.slides[0]!.objects
    expect(objs).toHaveLength(3)
    expect(objs[0]!['fill']).toBe(0xff0000)
    expect(objs[1]!['fill']).toBe(0x00ff00)
    expect(objs[2]!['type']).toBe('text')
    expect(objs[2]!['text']).toBe('On top')
  })

  it('copies hyperlink from ParsedShape onto the TextObject', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            {
              kind: 'text',
              x: 0,
              y: 0,
              width: 200,
              height: 50,
              rotation: 0,
              text: 'Click',
              hyperlink: { href: 'https://example.com/' },
              sourceTag: 'p:sp',
            },
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const doc = applyToFreshDoc(state)
    const t = doc.slides[0]!.objects[0]!
    const link = t['hyperlink'] as Record<string, unknown>
    expect(link['kind']).toBe('url')
    expect(link['href']).toBe('https://example.com/')
    expect(link['target']).toBe('_blank')
  })

  it('builds a Y.Text body from rich textRuns and preserves the plain string round-trip', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            {
              kind: 'text',
              x: 0,
              y: 0,
              width: 200,
              height: 50,
              rotation: 0,
              text: 'AB',
              textRuns: [
                { text: 'A', bold: true, color: 0xff0000 },
                { text: 'B', italic: true, color: 0x00ff00 },
              ],
              sourceTag: 'p:sp',
            },
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    // Re-apply to a fresh doc and inspect the Y.Text directly so we can
    // confirm per-character formatting attributes survived the encode.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(state))
    const slides = doc.getArray<Y.Map<unknown>>('slides')
    const objects = slides.get(0).get('objects') as Y.Array<Y.Map<unknown>>
    const yText = objects.get(0).get('text') as Y.Text
    expect(yText).toBeInstanceOf(Y.Text)
    expect(yText.toString()).toBe('AB')
    const delta = yText.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>
    expect(delta).toHaveLength(2)
    expect(delta[0]!.insert).toBe('A')
    expect(delta[0]!.attributes?.['fontWeight']).toBe(700)
    expect(delta[0]!.attributes?.['color']).toBe(0xff0000)
    expect(delta[1]!.insert).toBe('B')
    expect(delta[1]!.attributes?.['italic']).toBe(true)
    expect(delta[1]!.attributes?.['color']).toBe(0x00ff00)
  })

  it('seeds slide notes Y.XmlFragment when ParsedSlide.notes is set', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          notes: ['First paragraph', 'Second paragraph'],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(state))
    const slides = doc.getArray<Y.Map<unknown>>('slides')
    const notes = slides.get(0).get('notes') as Y.XmlFragment
    expect(notes).toBeInstanceOf(Y.XmlFragment)
    expect(notes.length).toBe(2)
    const paragraphs = notes.toArray() as Y.XmlElement[]
    expect(paragraphs[0]!.nodeName).toBe('paragraph')
    expect(paragraphs[0]!.toString()).toContain('First paragraph')
    expect(paragraphs[1]!.toString()).toContain('Second paragraph')
  })

  it('buildDeckAppendUpdate appends parsed slides at the end of an existing Y.Doc', async () => {
    // Phase 1: build an initial deck via buildDeckUpdate and apply to a doc.
    const initial: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          source: 'slide1.xml',
          shapes: [
            {
              kind: 'text',
              x: 0,
              y: 0,
              width: 100,
              height: 50,
              rotation: 0,
              text: 'Original',
              sourceTag: 'p:sp',
            },
          ],
        }),
      ],
    }
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(buildDeckUpdate(initial).state))
    const slides = doc.getArray<Y.Map<unknown>>('slides')
    expect(slides.length).toBe(1)

    // Phase 2: build an append update for 2 more slides and apply to the
    // same doc. The append update is a DIFF — applying it on top of the
    // existing state extends the slides array without touching slide 0.
    const appendParsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          source: 'slide2.xml',
          shapes: [
            {
              kind: 'text',
              x: 0,
              y: 0,
              width: 100,
              height: 50,
              rotation: 0,
              text: 'Appended A',
              sourceTag: 'p:sp',
            },
          ],
        }),
        emptySlide({
          source: 'slide3.xml',
          shapes: [
            {
              kind: 'text',
              x: 0,
              y: 0,
              width: 100,
              height: 50,
              rotation: 0,
              text: 'Appended B',
              sourceTag: 'p:sp',
            },
          ],
        }),
      ],
    }
    const result = buildDeckAppendUpdate(appendParsed, doc)
    expect(result.slideCount).toBe(2) // 2 slides APPENDED, not total
    Y.applyUpdate(doc, new Uint8Array(result.state))

    // Deck now has all three slides in order: original → A → B.
    expect(slides.length).toBe(3)
    const originalObjects = slides.get(0).get('objects') as Y.Array<Y.Map<unknown>>
    expect(originalObjects.get(0).get('text')?.toString()).toBe('Original')
    const slideAObjects = slides.get(1).get('objects') as Y.Array<Y.Map<unknown>>
    expect(slideAObjects.get(0).get('text')?.toString()).toBe('Appended A')
    const slideBObjects = slides.get(2).get('objects') as Y.Array<Y.Map<unknown>>
    expect(slideBObjects.get(0).get('text')?.toString()).toBe('Appended B')
  })

  it('buildDeckAppendUpdate inserts at `insertAt`, keeping the imported file order', () => {
    // A three-slide deck, so there is a real middle to drop into.
    const doc = new Y.Doc()
    Y.applyUpdate(
      doc,
      new Uint8Array(buildDeckUpdate(deckOf(['Original A', 'Original B', 'Original C'])).state),
    )
    const slides = doc.getArray<Y.Map<unknown>>('slides')

    const result = buildDeckAppendUpdate(deckOf(['Imported 1', 'Imported 2']), doc, 1)
    expect(result.slideCount).toBe(2)
    Y.applyUpdate(doc, new Uint8Array(result.state))

    // Imported slides land at 1 and 2 IN FILE ORDER — the bug worth a test
    // is inserting each of them at the same index, which reverses them.
    expect(slideTexts(slides)).toEqual([
      'Original A',
      'Imported 1',
      'Imported 2',
      'Original B',
      'Original C',
    ])
  })

  it('buildDeckAppendUpdate puts index 0 above everything', () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(buildDeckUpdate(deckOf(['Original'])).state))
    const slides = doc.getArray<Y.Map<unknown>>('slides')

    Y.applyUpdate(doc, new Uint8Array(buildDeckAppendUpdate(deckOf(['Imported']), doc, 0).state))

    expect(slideTexts(slides)).toEqual(['Imported', 'Original'])
  })

  it('buildDeckAppendUpdate clamps an index past the end instead of failing', () => {
    // The deck can shrink between the drop and the upload finishing, so a
    // stale index has to land the slides somewhere sensible rather than
    // throwing away a parsed deck.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(buildDeckUpdate(deckOf(['Original'])).state))
    const slides = doc.getArray<Y.Map<unknown>>('slides')

    Y.applyUpdate(doc, new Uint8Array(buildDeckAppendUpdate(deckOf(['Imported']), doc, 99).state))

    expect(slideTexts(slides)).toEqual(['Original', 'Imported'])
  })

  it('skips image-kind shapes in v1 and counts them in `skipped.images`', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            { kind: 'image', x: 0, y: 0, width: 100, height: 100, rotation: 0, sourceTag: 'p:pic' },
          ],
        }),
      ],
    }
    const { skipped, objectsCreated } = buildDeckUpdate(parsed)
    expect(objectsCreated).toBe(0)
    expect(skipped.images).toBe(1)
  })

  // ─── M29 — table-specific writer tests ──────────────────────────────────────

  it('lifts uniform cell typography into TableDefaults and strips redundant overrides', async () => {
    // Every cell agrees on fontSize=24 + fontFamily=Inter + color=0xFF0000.
    // After mapping, those values should land on TableDefaults and the cells
    // should carry no override. align=center matches the defaults arg the
    // writer's aggregator picks up too.
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            {
              kind: 'table',
              x: 0,
              y: 0,
              width: 200,
              height: 100,
              rotation: 0,
              sourceTag: 'a:tbl',
              tableColWidths: [100, 100],
              tableRowHeights: [50, 50],
              tableCells: [
                [
                  {
                    text: 'A1',
                    fontSize: 24,
                    fontFamily: 'Inter',
                    color: 0xff0000,
                    align: 'center',
                  },
                  {
                    text: 'B1',
                    fontSize: 24,
                    fontFamily: 'Inter',
                    color: 0xff0000,
                    align: 'center',
                  },
                ],
                [
                  {
                    text: 'A2',
                    fontSize: 24,
                    fontFamily: 'Inter',
                    color: 0xff0000,
                    align: 'center',
                  },
                  {
                    text: 'B2',
                    fontSize: 24,
                    fontFamily: 'Inter',
                    color: 0xff0000,
                    align: 'center',
                  },
                ],
              ],
            },
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const doc = applyToFreshDoc(state)
    const table = doc.slides[0]!.objects[0]!
    const defaults = table['defaults'] as Record<string, unknown>
    // 24 * scale (1.5 because BASE slideWidth=1280 → target 1920) = 36.
    expect(defaults['fontSize']).toBe(36)
    expect(defaults['fontFamily']).toBe('Inter')
    expect(defaults['color']).toBe(0xff0000)
    expect(defaults['align']).toBe('center')
    // Per-cell overrides were stripped because they matched defaults.
    const rows = table['rows'] as Array<Array<Record<string, unknown>>>
    expect(rows[0]![0]!['fontSize']).toBeUndefined()
    expect(rows[0]![0]!['fontFamily']).toBeUndefined()
    expect(rows[0]![0]!['color']).toBeUndefined()
    expect(rows[0]![0]!['align']).toBeUndefined()
  })

  it('preserves a cell-level override when only one cell diverges', async () => {
    // 2×1 table: cell [0][0] has fontSize=24, cell [0][1] has fontSize=36.
    // Defaults can't be lifted (cells disagree); both cells retain their
    // fontSize override.
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            {
              kind: 'table',
              x: 0,
              y: 0,
              width: 200,
              height: 50,
              rotation: 0,
              sourceTag: 'a:tbl',
              tableColWidths: [100, 100],
              tableRowHeights: [50],
              tableCells: [
                [
                  { text: 'small', fontSize: 24 },
                  { text: 'big', fontSize: 36 },
                ],
              ],
            },
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const doc = applyToFreshDoc(state)
    const table = doc.slides[0]!.objects[0]!
    const defaults = table['defaults'] as Record<string, unknown>
    // No lift — defaults stay at the hardcoded fallback (18).
    expect(defaults['fontSize']).toBe(18)
    const rows = table['rows'] as Array<Array<Record<string, unknown>>>
    expect(rows[0]![0]!['fontSize']).toBe(36) // 24 * 1.5
    expect(rows[0]![1]!['fontSize']).toBe(54) // 36 * 1.5
  })

  it('maps a parsed cell fillGradient onto TableCell.fillStyle', async () => {
    const parsed: ParsedPptx = {
      ...BASE,
      slides: [
        emptySlide({
          shapes: [
            {
              kind: 'table',
              x: 0,
              y: 0,
              width: 100,
              height: 50,
              rotation: 0,
              sourceTag: 'a:tbl',
              tableColWidths: [100],
              tableRowHeights: [50],
              tableCells: [
                [
                  {
                    text: 'g',
                    fillGradient: {
                      kind: 'linearGradient',
                      angleDeg: 90,
                      stops: [
                        { offset: 0, color: 0xff0000 },
                        { offset: 1, color: 0x0000ff },
                      ],
                    },
                  },
                ],
              ],
            },
          ],
        }),
      ],
    }
    const { state } = buildDeckUpdate(parsed)
    const doc = applyToFreshDoc(state)
    const table = doc.slides[0]!.objects[0]!
    const rows = table['rows'] as Array<Array<Record<string, unknown>>>
    const fillStyle = rows[0]![0]!['fillStyle'] as Record<string, unknown>
    expect(fillStyle['kind']).toBe('linearGradient')
    const stops = fillStyle['stops'] as Array<Record<string, unknown>>
    expect(stops).toHaveLength(2)
    expect(stops[0]!['color']).toBe(0xff0000)
    expect(stops[1]!['color']).toBe(0x0000ff)
  })
})
