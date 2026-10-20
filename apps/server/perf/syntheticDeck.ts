/**
 * perf/syntheticDeck.ts — a real-size `.pptx` built from fixed inputs, for
 * the PowerPoint performance driver (`perf/pptx.ts`).
 *
 * Client decks stay out of the repo, so the driver's default input is made
 * here: a seeded PRNG draws every picture, the slides are built through the
 * slide model and written by the exporter itself (`writeDeck`, a fixed
 * `now`), and two embedded fonts from the e2e fixtures are added the way
 * PowerPoint lists them (`<p:embeddedFontLst>`). The same spec and the same
 * library versions give the same bytes; the driver prints the deck's hash so
 * two measurements can be checked to have read the same input.
 *
 * What it carries, at the default spec (100 slides, 200 pictures):
 *   - photos: JPEG 2400×1600 (q82) — most pictures, like a typical pitch deck;
 *   - every 5th picture a PNG: flat "screenshots" 1600×1000, photo PNGs
 *     1600×1000 and transparent PNGs 1200×1200;
 *   - two oversize photos (9000×6000, 54 MP) that the importer has to bring
 *     under the stored-image limits (media/storedImageLimits.ts);
 *   - one logo on every slide (the same asset referenced 100 times);
 *   - title + bulleted body text, a shape, notes on every third slide and a
 *     picture background on every tenth.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import JSZip from 'jszip'
import sharp from 'sharp'
import {
  addObject,
  addSlide,
  createSlideDoc,
  getSlideObjectsCtx,
  listSlides,
  PARAGRAPH_SEP,
  removeSlide,
  updateSlideBackground,
  type NotesDoc,
} from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { writeDeck } from '../src/pptx/ooxml/writeDeck.js'

export interface SyntheticDeckSpec {
  slides: number
  images: number
  seed: number
}

export const DEFAULT_SPEC: SyntheticDeckSpec = { slides: 100, images: 200, seed: 1 }

/** Bump when the generator changes what it writes (part of the cache key). */
export const GENERATOR_VERSION = 1

/** mulberry32: small, fast, and the same sequence on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A photo-like raster: smooth colour fields (row and column waves) under
 * fine grain, so JPEG and PNG land near the sizes real photos have.
 */
function photoPixels(w: number, h: number, rand: () => number, channels: 3 | 4): Buffer {
  const px = Buffer.alloc(w * h * channels)
  const waves = Array.from({ length: 3 }, () => ({
    fx: 2 + rand() * 9,
    fy: 2 + rand() * 9,
    px: rand() * Math.PI * 2,
    py: rand() * Math.PI * 2,
    base: 60 + rand() * 120,
  }))
  const cols = waves.map((wv) =>
    Float32Array.from({ length: w }, (_, x) => 55 * Math.sin((x / w) * wv.fx + wv.px)),
  )
  const rows = waves.map((wv) =>
    Float32Array.from({ length: h }, (_, y) => 55 * Math.sin((y / h) * wv.fy + wv.py)),
  )
  let i = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const v = waves[c]!.base + cols[c]![x]! + rows[c]![y]! + (rand() - 0.5) * 36
        px[i++] = v < 0 ? 0 : v > 255 ? 255 : v
      }
      if (channels === 4) {
        // A soft vignette of transparency, like a cut-out product shot.
        const dx = x / w - 0.5
        const dy = y / h - 0.5
        const r = Math.sqrt(dx * dx + dy * dy)
        px[i++] = r > 0.5 ? 0 : r > 0.4 ? Math.round(255 * (0.5 - r) * 10) : 255
      }
    }
  }
  return px
}

interface Picture {
  bytes: Buffer
  mimeType: string
}

async function picture(index: number, spec: SyntheticDeckSpec): Promise<Picture> {
  const rand = prng(spec.seed * 100_003 + index)
  const oversize =
    index === Math.floor(spec.images / 4) || index === Math.floor((spec.images * 3) / 4)
  if (oversize) {
    const raw = photoPixels(2400, 1600, rand, 3)
    const bytes = await sharp(raw, { raw: { width: 2400, height: 1600, channels: 3 } })
      .resize(9000, 6000, { kernel: 'cubic' })
      .jpeg({ quality: 82 })
      .toBuffer()
    return { bytes, mimeType: 'image/jpeg' }
  }
  if (index % 5 === 4) {
    const kind = Math.floor(index / 5) % 4
    if (kind === 3) {
      const raw = photoPixels(1200, 1200, rand, 4)
      const bytes = await sharp(raw, { raw: { width: 1200, height: 1200, channels: 4 } })
        .png()
        .toBuffer()
      return { bytes, mimeType: 'image/png' }
    }
    if (kind === 2) {
      const raw = photoPixels(1600, 1000, rand, 3)
      const bytes = await sharp(raw, { raw: { width: 1600, height: 1000, channels: 3 } })
        .png()
        .toBuffer()
      return { bytes, mimeType: 'image/png' }
    }
    // A flat UI "screenshot": panels of solid colour.
    const panels = Array.from({ length: 12 }, () => {
      const x = Math.floor(rand() * 1400)
      const y = Math.floor(rand() * 850)
      const width = 40 + Math.floor(rand() * 600)
      const height = 20 + Math.floor(rand() * 300)
      const c = (): number => Math.floor(rand() * 256)
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="rgb(${c()},${c()},${c()})"/>`
    })
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">${panels.join('')}</svg>`
    const bytes = await sharp({
      create: { width: 1600, height: 1000, channels: 3, background: { r: 244, g: 245, b: 247 } },
    })
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer()
    return { bytes, mimeType: 'image/png' }
  }
  const raw = photoPixels(2400, 1600, rand, 3)
  const bytes = await sharp(raw, { raw: { width: 2400, height: 1600, channels: 3 } })
    .jpeg({ quality: 82 })
    .toBuffer()
  return { bytes, mimeType: 'image/jpeg' }
}

const frame = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
  rotation: 0,
  opacity: 1,
})

function body(slide: number): Y.Text {
  const t = new Y.Text()
  const lines = [
    `Point ${slide}.1 — what the market told us this quarter`,
    `Point ${slide}.2 — where the product meets the need`,
    `Point ${slide}.3 — the next three steps and their owners`,
  ]
  let at = 0
  lines.forEach((line, i) => {
    t.insert(at, line, i === 1 ? { fontWeight: 700 } : {})
    at += line.length
    if (i < lines.length - 1) {
      t.insert(at, PARAGRAPH_SEP, { list: 'bullet' })
      at += 1
    }
  })
  return t
}

const FIXTURE_FONTS = ['block-font.ttf', 'codicon.ttf'] as const

function fixtureFont(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../web/e2e/fixtures/${name}`, import.meta.url)))
}

/**
 * Add `<p:embeddedFontLst>` with two typefaces (regular + bold each, four
 * faces from two files), as PowerPoint embeds them.
 */
async function embedFonts(pptx: Buffer, now: Date): Promise<Buffer> {
  const zip = await JSZip.loadAsync(pptx)
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  const pres = await zip.file('ppt/presentation.xml')!.async('string')
  const types = await zip.file('[Content_Types].xml')!.async('string')
  const extraRels: string[] = []
  const fonts: string[] = []
  FIXTURE_FONTS.forEach((name, i) => {
    const part = `fonts/font${i + 1}.fntdata`
    zip.file(`ppt/${part}`, fixtureFont(name), { date: now, createFolders: false })
    const rid = `rIdPerfFont${i + 1}`
    extraRels.push(
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="${part}"/>`,
    )
    fonts.push(
      `<p:embeddedFont><p:font typeface="Perf Font ${i + 1}"/><p:regular r:id="${rid}"/><p:bold r:id="${rid}"/></p:embeddedFont>`,
    )
  })
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels.replace('</Relationships>', `${extraRels.join('')}</Relationships>`),
    { date: now, createFolders: false },
  )
  zip.file(
    'ppt/presentation.xml',
    pres.replace(
      '</p:presentation>',
      `<p:embeddedFontLst>${fonts.join('')}</p:embeddedFontLst></p:presentation>`,
    ),
    { date: now, createFolders: false },
  )
  zip.file(
    '[Content_Types].xml',
    types.replace(
      '<Default ',
      '<Default Extension="fntdata" ContentType="application/x-fontdata"/><Default ',
    ),
    { date: now, createFolders: false },
  )
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}

/** Build the deck. Takes a while (≈ a minute at the default spec); callers cache it. */
export async function buildSyntheticDeck(spec: SyntheticDeckSpec = DEFAULT_SPEC): Promise<Buffer> {
  const assets = new Map<string, Picture>()
  for (let i = 0; i < spec.images; i++) assets.set(`pic-${i}`, await picture(i, spec))
  assets.set('logo', {
    bytes: await sharp({
      create: {
        width: 320,
        height: 120,
        channels: 4,
        background: { r: 20, g: 40, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer(),
    mimeType: 'image/png',
  })

  const ctx = createSlideDoc()
  const placeholder = listSlides(ctx)[0]?.id
  let next = 0
  for (let s = 0; s < spec.slides; s++) {
    const slide = addSlide(ctx)
    const objCtx = getSlideObjectsCtx(ctx, slide.id)!
    const objects: SlideObject[] = [
      {
        id: `t${s}`,
        type: 'text',
        ...frame(120, 80, 1680, 140),
        text: `Slide ${s + 1}: a headline that says what this slide proves`,
        fontSize: 56,
        fontWeight: 'bold',
        color: 0x111111,
        align: 'left',
      } as SlideObject,
      {
        id: `b${s}`,
        type: 'text',
        ...frame(120, 260, 820, 600),
        text: body(s + 1),
        fontSize: 28,
        color: 0x333333,
        align: 'left',
      } as SlideObject,
      {
        id: `r${s}`,
        type: 'rectangle',
        ...frame(120, 900, 1680, 8),
        fill: 0x3366cc,
      } as SlideObject,
      { id: `l${s}`, type: 'image', ...frame(1560, 960, 240, 90), assetId: 'logo' } as SlideObject,
    ]
    // Two pictures per slide on average; every tenth slide puts one behind
    // everything as its background.
    const perSlide = Math.round(((s + 1) * spec.images) / spec.slides) - next
    for (let k = 0; k < perSlide; k++) {
      const assetId = `pic-${next++}`
      if (s % 10 === 9 && k === 0) {
        updateSlideBackground(ctx, slide.id, { kind: 'image', assetId, fit: 'cover' })
        continue
      }
      objects.push({
        id: `p${s}-${k}`,
        type: 'image',
        ...frame(1000 + k * 60, 260 + k * 60, 800, 533),
        assetId,
      } as SlideObject)
    }
    for (const o of objects) addObject(objCtx, o)
  }
  if (placeholder !== undefined) removeSlide(ctx, placeholder)

  const slides = listSlides(ctx)
  const notesBySlideId = new Map<string, NotesDoc>()
  slides.forEach((slide, s) => {
    if (s % 3 === 0) {
      notesBySlideId.set(slide.id, [
        { type: 'paragraph', content: [{ text: `Speaker notes for slide ${s + 1}.` }] },
        { type: 'paragraph', content: [{ text: 'Mention the numbers; pause for questions.' }] },
      ])
    }
  })
  const now = new Date(Date.UTC(2026, 9, 1))
  const pptx = await writeDeck(slides, {
    title: 'Synthetic performance deck',
    assetLoader: async (id) => assets.get(id) ?? null,
    notesBySlideId,
    now,
  })
  return embedFonts(pptx, now)
}
