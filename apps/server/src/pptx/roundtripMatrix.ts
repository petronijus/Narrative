/**
 * pptx/roundtripMatrix.ts
 *
 * A deck covering every object type and every model field in at least one
 * non-default state, built the way the editor builds decks: objects carry
 * the fields a user sets, not the defaults the importer fills in. Used by
 * roundtrip.test.ts for the model → export → import invariant and by the
 * `pptxRoundtrip --matrix` CLI for inspecting the exported XML.
 */

import * as Y from 'yjs'
import sharp from 'sharp'
import {
  addAnimation,
  addObject,
  addSlide,
  createSlideDoc,
  getSlideAnimationsCtx,
  getSlideObjectsCtx,
  listSlides,
  PARAGRAPH_SEP,
  setSlideCollapsed,
  setSlideIndent,
  setSlideName,
  setSlideSkipped,
  updateSlideBackground,
  updateSlideTransition,
} from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { notesOf, type ImportedDeck, type InMemoryAsset } from './roundtrip.js'
import { setSlideNotes, type NotesDoc } from '@narrative/slide-model'

type Ctx = ReturnType<typeof createSlideDoc>

async function png(w: number, h: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer()
}

/** An MP4 container header — enough for the importer to recognise video bytes. */
function mp4(): Buffer {
  const b = Buffer.alloc(64)
  b.writeUInt32BE(32, 0)
  b.write('ftypisom', 4, 'latin1')
  return b
}

function rich(build: (t: Y.Text) => void): Y.Text {
  const t = new Y.Text()
  build(t)
  return t
}

function slideWith(ctx: Ctx, objects: SlideObject[]): string {
  const slide = addSlide(ctx)
  const objCtx = getSlideObjectsCtx(ctx, slide.id)!
  for (const o of objects) addObject(objCtx, o)
  return slide.id
}

const frame = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
  rotation: 0,
  opacity: 1,
})

export async function matrixDeck(): Promise<ImportedDeck> {
  const assets = new Map<string, InMemoryAsset>([
    ['img-a', { bytes: await png(64, 48, [200, 40, 40]), mimeType: 'image/png' }],
    ['img-b', { bytes: await png(32, 32, [40, 200, 40]), mimeType: 'image/png' }],
    ['vid-a', { bytes: mp4(), mimeType: 'video/mp4' }],
    ['img-wide', { bytes: await png(80, 40, [40, 40, 200]), mimeType: 'image/png' }],
  ])
  const ctx = createSlideDoc()

  // ─── 1. Parametric shapes ──────────────────────────────────────────────
  const s1 = slideWith(ctx, [
    { id: 'r1', type: 'rectangle', ...frame(100, 100, 400, 200), fill: 0x3366cc },
    {
      id: 'r2',
      type: 'rectangle',
      ...frame(600, 100, 300, 300),
      rotation: Math.PI / 6,
      opacity: 0.5,
      fill: 0xff0000,
      fillAlpha: 0.25,
      stroke: 0x00ff00,
      strokeWidth: 6,
      strokeDash: true,
      strokeAlpha: 0.75,
      cornerRadius: 24,
      name: 'Card',
      locked: true,
      aspectLocked: true,
      shadow: { color: 0x000000, blur: 12, offsetX: 4, offsetY: 8, opacity: 0.4 },
      blur: 3,
      flipH: true,
    },
    {
      id: 'r3',
      type: 'rectangle',
      ...frame(1000, 100, 300, 200),
      fill: 0x123456,
      cornerRadius: { tl: 10, tr: 20, br: 30, bl: 40 },
      fillStyle: {
        kind: 'linearGradient',
        angleDeg: 45,
        stops: [
          { offset: 0, color: 0xff0000 },
          { offset: 0.5, color: 0x00ff00, alpha: 0.5 },
          { offset: 1, color: 0x0000ff },
        ],
      },
    },
    {
      id: 'e1',
      type: 'ellipse',
      ...frame(100, 500, 200, 200),
      fill: 0xabcdef,
      fillStyle: {
        kind: 'radialGradient',
        centerX: 0.25,
        centerY: 0.75,
        stops: [
          { offset: 0, color: 0xffffff },
          { offset: 1, color: 0x000000 },
        ],
      },
      flipV: true,
    },
    {
      id: 't1',
      type: 'triangle',
      ...frame(400, 500, 200, 180),
      fill: 0x00aa00,
      stroke: 0x111111,
      strokeWidth: 2,
    },
    { id: 'p5', type: 'polygon', ...frame(700, 500, 200, 200), fill: 0xaa00aa, sides: 5 },
    { id: 'p9', type: 'polygon', ...frame(1000, 500, 200, 200), fill: 0x00aaaa, sides: 9 },
    // A transparent fill keeps its colour; a width without a colour is kept too.
    {
      id: 'r4',
      type: 'rectangle',
      ...frame(1300, 500, 100, 100),
      fill: 0x777777,
      fillAlpha: 0,
      strokeWidth: 4,
    },
  ] as SlideObject[])
  setSlideName(ctx, s1, 'Shapes')
  updateSlideBackground(ctx, s1, { kind: 'color', color: 0xf0f0f0, alpha: 0.5 })
  updateSlideTransition(ctx, s1, { kind: 'push', durationMs: 600, direction: 'up' })

  // ─── 2. Paths, lines, arrows ───────────────────────────────────────────
  const s2 = slideWith(ctx, [
    {
      id: 'path1',
      type: 'path',
      ...frame(100, 100, 300, 200),
      anchors: [
        { x: 0, y: 0 },
        { x: 150, y: 200, cpIn: { x: -50, y: 0 }, cpOut: { x: 50, y: 0 } },
        { x: 300, y: 0 },
      ],
      closed: true,
      stroke: 0x222222,
      strokeWidth: 3,
      fill: 0xffcc00,
      fillAlpha: 0.5,
      dash: true,
    },
    {
      id: 'path2',
      type: 'path',
      ...frame(500, 100, 200, 200),
      // A handle on one side only: no cubic segment natively.
      anchors: [
        { x: 0, y: 0, cpOut: { x: 30, y: 30 } },
        { x: 200, y: 200 },
      ],
      stroke: 0x0000ff,
      strokeWidth: 0,
    },
    {
      id: 'line1',
      type: 'line',
      ...frame(100, 500, 400, 100),
      p1: { x: 0, y: 100 },
      p2: { x: 400, y: 0 },
      stroke: 0x333333,
      strokeWidth: 4,
      startCap: 'round',
      endCap: 'square',
      dash: true,
    },
    {
      // A mirrored, rotated arrow: PowerPoint gets the drawn direction, the
      // model gets its own ends and flags back.
      id: 'arrowFlipped',
      type: 'arrow',
      ...frame(100, 700, 300, 120),
      rotation: 0.4,
      flipH: true,
      p1: { x: 0, y: 0 },
      p2: { x: 300, y: 120 },
      stroke: 0x224488,
      strokeWidth: 3,
    },
    {
      id: 'arrow1',
      type: 'arrow',
      ...frame(600, 500, 300, 150),
      p1: { x: 0, y: 0 },
      p2: { x: 300, y: 150 },
      stroke: 0xcc0000,
      strokeWidth: 5,
      strokeAlpha: 0.8,
    },
    {
      // An arrow with no arrowhead and a line with one.
      id: 'arrow2',
      type: 'arrow',
      ...frame(1000, 500, 200, 0),
      p1: { x: 0, y: 0 },
      p2: { x: 200, y: 0 },
      stroke: 0x00cc00,
      strokeWidth: 2,
      endCap: 'none',
    },
    {
      id: 'line2',
      type: 'line',
      // A box larger than the endpoints span.
      ...frame(1300, 500, 300, 300),
      p1: { x: 50, y: 50 },
      p2: { x: 150, y: 250 },
      stroke: 0x0000cc,
      strokeWidth: 2,
      endCap: 'arrow',
    },
  ] as SlideObject[])
  updateSlideBackground(ctx, s2, {
    kind: 'linearGradient',
    angleDeg: 30,
    stops: [
      { offset: 0, color: 0x101010 },
      { offset: 1, color: 0xf0f0f0 },
    ],
  })
  updateSlideTransition(ctx, s2, { kind: 'fade', durationMs: 400 })
  setSlideIndent(ctx, s2, 1)

  // ─── 3. Text ───────────────────────────────────────────────────────────
  const s3 = slideWith(ctx, [
    {
      id: 'tx1',
      type: 'text',
      ...frame(100, 100, 800, 200),
      text: 'Plain text',
      fontSize: 48,
      fontWeight: 'normal',
      color: 0x111111,
      align: 'left',
    },
    {
      id: 'tx2',
      type: 'text',
      ...frame(100, 350, 800, 400),
      text: rich((t) => {
        t.insert(0, 'Big ', { fontSize: 72 })
        t.insert(4, 'bold', { fontWeight: 700 })
        t.insert(8, ' light', { fontWeight: 300, italic: true })
        t.insert(14, ' red', { color: 0xff0000, underline: true })
        t.insert(18, ' serif', { fontFamily: 'Georgia' })
        t.insert(24, '\nsoft break')
        t.insert(35, PARAGRAPH_SEP)
        t.insert(36, 'Second paragraph', { fontSize: 32, italic: false })
      }),
      fontSize: 36,
      fontWeight: 'bold',
      color: 0x223344,
      colorAlpha: 0.9,
      align: 'center',
      vAlign: 'middle',
      italic: true,
      underline: false,
      fontFamily: 'Inter',
      letterSpacing: 2,
      lineHeight: 1.25,
      paragraphSpaceBefore: 12,
      paragraphSpaceAfter: 6,
      textTransform: 'uppercase',
      wrap: 'none',
      hyperlink: { kind: 'url', href: 'https://example.com/' },
      stroke: 0xff00ff,
      strokeWidth: 2,
    },
    {
      id: 'tx3',
      type: 'text',
      ...frame(1000, 100, 800, 600),
      text: rich((t) => {
        t.insert(0, 'One')
        t.insert(3, PARAGRAPH_SEP, { list: 'bullet' })
        t.insert(4, 'Two nested')
        t.insert(14, PARAGRAPH_SEP, { list: 'bullet', level: 1, bulletChar: '–' })
        t.insert(15, 'Three')
        t.insert(20, PARAGRAPH_SEP, { list: 'number', numberFormat: 'lowerRoman', startAt: 3 })
        t.insert(21, 'Plain')
        t.insert(26, PARAGRAPH_SEP)
      }),
      fontSize: 28,
      fontWeight: 500,
      color: 0x000000,
      align: 'right',
      vAlign: 'bottom',
      lineSpacing: 1.1,
      textTransform: 'capitalize',
      flipH: true,
    },
    {
      id: 'tx4',
      type: 'text',
      ...frame(1600, 980, 200, 60),
      text: '‹#›',
      fontSize: 20,
      fontWeight: 'normal',
      color: 0x666666,
      align: 'right',
      isSlideNumber: true,
    },
  ] as SlideObject[])
  updateSlideTransition(ctx, s3, { kind: 'magic', durationMs: 1200 })
  setSlideCollapsed(ctx, s3, true)
  setSlideSkipped(ctx, s3, true)

  // ─── 4. Media ──────────────────────────────────────────────────────────
  const s4 = slideWith(ctx, [
    { id: 'im1', type: 'image', ...frame(100, 100, 640, 480), assetId: 'img-a' },
    {
      id: 'im2',
      type: 'image',
      ...frame(800, 100, 300, 300),
      assetId: 'img-a',
      variant: 'original',
      fit: 'contain',
      opacity: 0.6,
      imageRect: { x: 700, y: 50, width: 600, height: 450 },
      imageRotation: 0.2,
      mask: { kind: 'ellipse' },
      alt: 'A red picture',
    },
    {
      id: 'im3',
      type: 'image',
      ...frame(1200, 100, 300, 300),
      assetId: 'img-b',
      mask: { kind: 'polygon', sides: 6 },
      hyperlink: { kind: 'url', href: 'https://example.org/' },
    },
    {
      id: 'vd1',
      type: 'video',
      ...frame(100, 600, 640, 360),
      assetId: 'vid-a',
      posterAssetId: 'img-b',
      fit: 'cover',
      autoplay: true,
      loop: true,
      muted: false,
      volume: 0.5,
      showControls: true,
      posterTime: 2,
      trimStart: 1,
      trimEnd: 9,
      videoTrigger: 'afterPrevious',
      videoDelay: 0.5,
    },
    { id: 'vd2', type: 'video', ...frame(800, 600, 320, 180), assetId: 'vid-a' },
  ] as SlideObject[])
  updateSlideBackground(ctx, s4, { kind: 'image', assetId: 'img-b', fit: 'contain', dim: 0.3 })
  updateSlideTransition(ctx, s4, { kind: 'cube', durationMs: 900, direction: 'left' })

  // ─── 5. Tables, groups, animations ─────────────────────────────────────
  const s5 = slideWith(ctx, [
    {
      id: 'tb1',
      type: 'table',
      ...frame(100, 100, 900, 300),
      colWidths: [300, 300, 300],
      rowHeights: [100, 100, 100],
      defaults: {
        fontSize: 20,
        fontWeight: 'normal',
        color: 0x111111,
        align: 'left',
        vAlign: 'middle',
        padding: { top: 8, right: 8, bottom: 8, left: 8 },
        border: { color: 0xcccccc, width: 1 },
        fill: 0xffffff,
      },
      rows: [
        [
          { text: 'Head A', fontWeight: 'bold', fill: 0xeeeeee, gridSpan: 2 },
          { text: '', mergeOriginR: 0, mergeOriginC: 0 },
          { text: 'Head C', align: 'center' },
        ],
        [
          { text: 'b1', rowSpan: 2, vAlign: 'top' },
          { text: 'b2', color: 0xff0000, italic: true },
          {
            text: 'b3',
            fillStyle: {
              kind: 'linearGradient',
              angleDeg: 0,
              stops: [
                { offset: 0, color: 0xff0000 },
                { offset: 1, color: 0x0000ff },
              ],
            },
          },
        ],
        [
          { text: '', mergeOriginR: 1, mergeOriginC: 0 },
          { text: 'c2', padding: { top: 2, right: 4, bottom: 6, left: 8 }, fontSize: 14 },
          { text: 'c3', fillAlpha: 0.5, fill: 0x00ff00 },
        ],
      ],
      borderSegments: {
        'h:1:0': { color: 0x000000, width: 3, dash: 'dash' },
        'v:1:1': { color: 0xff0000, width: 0 },
      },
    },
    { id: 'g1', type: 'rectangle', ...frame(100, 600, 100, 100), fill: 0x111111, groupId: 'grp' },
    { id: 'g2', type: 'ellipse', ...frame(250, 600, 100, 100), fill: 0x222222, groupId: 'grp' },
    { id: 'an1', type: 'rectangle', ...frame(600, 600, 100, 100), fill: 0x333333 },
    { id: 'an2', type: 'rectangle', ...frame(800, 600, 100, 100), fill: 0x444444, rotation: 0.5 },
  ] as SlideObject[])
  updateSlideBackground(ctx, s5, {
    kind: 'radialGradient',
    centerX: 0.3,
    centerY: 0.6,
    radius: 0.8,
    stops: [
      { offset: 0, color: 0xffffff },
      { offset: 1, color: 0x336699 },
    ],
  })
  updateSlideTransition(ctx, s5, { kind: 'none', durationMs: 300 })
  const animCtx = getSlideAnimationsCtx(ctx, s5)!
  addAnimation(animCtx, {
    objectId: 'an1',
    preset: 'fadeIn',
    trigger: 'onClick',
    duration: 0.6,
    delay: 0,
    easing: 'power2.out',
  })
  addAnimation(animCtx, {
    objectId: 'an2',
    preset: 'slideIn',
    trigger: 'withPrevious',
    duration: 1,
    delay: 0.25,
    easing: 'sine.inOut',
    params: { direction: 'left', distance: 200 },
  })
  addAnimation(animCtx, {
    objectId: 'an1',
    preset: 'moveTo',
    trigger: 'afterPrevious',
    duration: 0.8,
    delay: 0,
    easing: 'power1.inOut',
    params: { targetX: 1200, targetY: 700 },
  })
  addAnimation(animCtx, {
    objectId: 'an2',
    preset: 'rotateTo',
    trigger: 'onClick',
    duration: 0.5,
    delay: 0.1,
    easing: 'none',
    params: { angleDeg: 90 },
  })
  addAnimation(animCtx, {
    objectId: 'g1',
    preset: 'bounceIn',
    trigger: 'onEnter',
    duration: 0.7,
    delay: 0,
    easing: 'bounce.out',
  })
  addAnimation(animCtx, {
    objectId: 'g2',
    preset: 'fadeOut',
    trigger: 'afterPrevious',
    duration: 0.4,
    delay: 1,
    easing: 'power2.in',
    params: { repeat: 2 },
  })

  // ─── 6. Edge states ────────────────────────────────────────────────────
  // Values whose native form is absent or ambiguous: explicit `false`s, a
  // fill kept next to a gradient or picture, strokes that do not draw, zero
  // spacing, links between slides, the legacy frame-wide list style.
  const s6 = slideWith(ctx, [
    {
      id: 'x1',
      type: 'rectangle',
      ...frame(100, 100, 200, 200),
      fill: 0x445566,
      fillAlpha: 1,
      aspectLocked: false,
      flipH: false,
      flipV: false,
      locked: false,
      strokeDash: false,
      stroke: 0x000000,
      strokeWidth: 2,
      strokeAlpha: 1,
      cornerRadius: 0,
      hyperlink: { kind: 'slide', slideId: s1 },
    },
    {
      id: 'x2',
      type: 'ellipse',
      ...frame(400, 100, 200, 200),
      fill: 0x998877,
      fillStyle: { kind: 'image', assetId: 'img-b', fit: 'contain' },
    },
    {
      id: 'x3',
      type: 'rectangle',
      ...frame(700, 100, 100, 300),
      fill: 0x112233,
      // Wider than roundRect can draw: half the shorter side is 50.
      cornerRadius: 80,
      strokeWidth: 0,
      stroke: 0xff0000,
      strokeAlpha: 0.5,
    },
    {
      id: 'x4',
      type: 'path',
      ...frame(900, 100, 200, 200),
      anchors: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 100, y: 200 },
      ],
      closed: false,
      stroke: 0x000000,
      strokeWidth: 2,
      dash: false,
      fill: 0x00ff00,
      fillStyle: {
        kind: 'linearGradient',
        angleDeg: 120,
        stops: [
          { offset: 0, color: 0x00ff00 },
          { offset: 1, color: 0x0000ff },
        ],
      },
    },
    {
      id: 'x5',
      type: 'line',
      ...frame(100, 500, 300, 0),
      p1: { x: 0, y: 0 },
      p2: { x: 300, y: 0 },
      stroke: 0x00ff00,
      strokeWidth: 0,
      startCap: 'arrow',
      dash: false,
      hyperlink: { kind: 'url', href: 'https://example.net/', target: '_self' },
    },
    {
      id: 'x6',
      type: 'text',
      ...frame(500, 500, 600, 200),
      text: rich((t) => {
        t.insert(0, 'Legacy')
        t.insert(6, PARAGRAPH_SEP)
        t.insert(7, 'list')
      }),
      fontSize: 24,
      fontWeight: 400,
      color: 0x000000,
      colorAlpha: 1,
      align: 'left',
      vAlign: 'top',
      listStyle: 'numbered',
      letterSpacing: 0,
      paragraphSpaceBefore: 0,
      fontFamily: 'Inter, sans-serif',
      strokeWidth: 3,
      isSlideNumber: false,
      textStyleId: 'ts-heading',
      textStyleOverrides: ['fontSize', 'color'],
      textTransform: 'none',
      flipV: true,
      hyperlink: { kind: 'slide', slideId: s4 },
    },
    {
      id: 'x7',
      type: 'table',
      ...frame(1200, 500, 400, 200),
      rotation: 0.3,
      opacity: 0.8,
      name: 'Grid',
      colWidths: [200, 200],
      rowHeights: [100, 100],
      defaults: {
        fontSize: 16,
        fontWeight: 700,
        color: 0x222222,
        align: 'center',
        vAlign: 'bottom',
        padding: { top: 4, right: 4, bottom: 4, left: 4 },
      },
      rows: [
        [{ text: 'a' }, { text: 'b' }],
        [{ text: 'c' }, { text: '' }],
      ],
      hyperlink: { kind: 'url', href: 'https://example.com/table' },
    },
  ] as SlideObject[])
  updateSlideBackground(ctx, s6, { kind: 'image', assetId: 'img-a', fit: 'cover' })

  // ─── 7. Pictures fitted into frames of another aspect ──────────────────
  // `img-wide` is 2:1; every frame below is not, so each picture is
  // cropped (cover) or letterboxed (contain) exactly as the renderer does.
  slideWith(ctx, [
    { id: 'pf1', type: 'image', ...frame(100, 100, 300, 300), assetId: 'img-wide' },
    { id: 'pf2', type: 'image', ...frame(500, 100, 300, 300), assetId: 'img-wide', fit: 'contain' },
    {
      id: 'pf3',
      type: 'image',
      ...frame(900, 100, 300, 300),
      assetId: 'img-wide',
      fit: 'cover',
      imageRect: { x: 850, y: 50, width: 400, height: 400 },
    },
    {
      id: 'pf4',
      type: 'video',
      ...frame(100, 500, 400, 400),
      assetId: 'vid-a',
      posterAssetId: 'img-wide',
    },
    {
      id: 'pf5',
      type: 'rectangle',
      ...frame(600, 500, 300, 300),
      fill: 0xabcdef,
      cornerRadius: 30,
      stroke: 0x000000,
      strokeWidth: 4,
      fillStyle: { kind: 'image', assetId: 'img-wide' },
    },
    {
      id: 'mk1',
      type: 'image',
      ...frame(1300, 100, 120, 120),
      assetId: 'img-b',
      mask: { kind: 'rectangle', cornerRadius: 20 },
    },
    {
      id: 'mk2',
      type: 'image',
      ...frame(1450, 100, 120, 120),
      assetId: 'img-b',
      mask: { kind: 'rectangle' },
    },
    {
      id: 'mk3',
      type: 'image',
      ...frame(1600, 100, 120, 120),
      assetId: 'img-b',
      mask: { kind: 'rectangle', cornerRadius: { tl: 0, tr: 10, br: 20, bl: 30 } },
    },
    {
      id: 'mk4',
      type: 'image',
      ...frame(1300, 250, 120, 120),
      assetId: 'img-b',
      mask: { kind: 'triangle' },
    },
    {
      id: 'mk5',
      type: 'image',
      ...frame(1450, 250, 120, 120),
      assetId: 'img-b',
      mask: { kind: 'polygon', sides: 9 },
    },
    {
      id: 'mk6',
      type: 'image',
      ...frame(1600, 250, 120, 120),
      assetId: 'img-b',
      mask: {
        kind: 'path',
        closed: true,
        anchors: [
          { x: 0.5, y: 0 },
          { x: 1, y: 0.5, cpIn: { x: 0, y: -0.25 }, cpOut: { x: 0, y: 0.25 } },
          { x: 0.5, y: 1, cpIn: { x: 0.25, y: 0 } },
          { x: 0, y: 0.5 },
        ],
      },
    },
    {
      id: 'pf6',
      type: 'table',
      ...frame(1000, 500, 600, 300),
      colWidths: [300, 300],
      rowHeights: [150, 150],
      defaults: {
        fontSize: 18,
        fontWeight: 'normal',
        color: 0x000000,
        align: 'left',
        vAlign: 'top',
        padding: { top: 6, right: 6, bottom: 6, left: 6 },
        fillStyle: { kind: 'image', assetId: 'img-a', fit: 'contain' },
      },
      rows: [
        [
          {
            text: rich((t) => {
              t.insert(0, 'rich ', { fontWeight: 700 })
              t.insert(5, 'cell', { italic: true, color: 0xff0000 })
            }),
          },
          { text: 'own picture', fillStyle: { kind: 'image', assetId: 'img-wide' } },
        ],
        [
          {
            text: 'gradient',
            fillStyle: {
              kind: 'radialGradient',
              stops: [
                { offset: 0, color: 0xffffff },
                { offset: 1, color: 0 },
              ],
            },
          },
          { text: 'solid', fill: 0xff00ff, fillStyle: undefined },
        ],
      ],
    },
  ] as SlideObject[])

  // ─── Speaker notes: every node and mark the notes editor has ──────────
  const notesFor = (slideId: string, doc: NotesDoc): void => {
    setSlideNotes(ctx, slideId, doc)
  }
  notesFor(s1, [
    { type: 'heading', attrs: { level: 1 }, content: [{ text: 'Opening' }] },
    {
      type: 'paragraph',
      content: [
        { text: 'Say ' },
        { text: 'this', marks: { bold: {} } },
        { text: ' and ', marks: { italic: {} } },
        { text: 'that', marks: { bold: {}, underline: {} } },
        { text: ', not ' },
        { text: 'this', marks: { strike: {} } },
        { type: 'hardBreak' },
        { text: 'run ' },
        { text: 'npm test', marks: { code: {} } },
        { text: ' — see ' },
        {
          text: 'the docs',
          marks: {
            link: {
              href: 'https://example.com/docs',
              target: '_blank',
              rel: 'noopener noreferrer nofollow',
              class: null,
            },
          },
        },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ text: 'first' }] }] },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ text: 'second' }] },
            {
              type: 'orderedList',
              attrs: { start: 3 },
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ text: 'nested three' }] }],
                },
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ text: 'nested four' }] }],
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ text: 'A quote.' }] }] },
    { type: 'horizontalRule' },
    {
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ text: 'const a = 1\nconst b = 2' }],
    },
    { type: 'paragraph' },
  ])
  notesFor(s2, [{ type: 'paragraph', content: [{ text: 'Plain notes on slide two.' }] }])

  const slides = listSlides(ctx)
  return { slides, assets, notes: notesOf(ctx, slides) }
}
