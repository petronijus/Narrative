/**
 * pptx/roundtrip.ts
 *
 * The invariant import and export have to keep between them:
 *
 *   import(pptx) = M1   →   export(M1) = pptx'   →   import(pptx') = M2   ⇒   M1 = M2
 *
 * Whatever the importer understood about a deck, the exporter must write in
 * a form the importer reads back as the same thing. The two sides used to be
 * separate translations (a hand-written OOXML reader, pptxgenjs for writing),
 * so every meaning had to be kept in step by hand and many drifted: rotation
 * units, paragraph breaks, bullet glyphs, crops, custom geometry.
 *
 * Everything here runs the production code — parser, writer, the Y.Doc, the
 * exporter — in memory, with the one piece of I/O (media storage) replaced by
 * a map. `diffDecks` compares two imports generically, over every field an
 * object carries, so a field the importer starts writing is covered without
 * this file having to learn about it.
 */

import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import {
  hydrateSlideDoc,
  listSlides,
  getParagraphDeltas,
  getSlideNotes,
} from '@narrative/slide-model'
import { notesFromFragment, type NotesDoc } from './ooxml/notes.js'
import type { Slide } from '@narrative/shared'
import { parsePptx } from './parser.js'
import { buildDeckUpdate } from './writer.js'
import { patchParsedAssetIds } from './importDeck.js'
import { writeDeck } from './ooxml/writeDeck.js'

export interface InMemoryAsset {
  bytes: Buffer
  mimeType: string
}

export interface ImportedDeck {
  slides: Slide[]
  assets: Map<string, InMemoryAsset>
  /** Speaker notes per slide id (slides without notes have no entry). */
  notes: Map<string, NotesDoc>
}

/** Every slide's notes document, as the export route reads them. */
export function notesOf(
  handles: ReturnType<typeof hydrateSlideDoc>,
  slides: readonly Slide[],
): Map<string, NotesDoc> {
  const out = new Map<string, NotesDoc>()
  for (const s of slides) {
    const fragment = getSlideNotes(handles, s.id)
    const doc = fragment !== null ? notesFromFragment(fragment) : []
    if (doc.length > 0) out.set(s.id, doc)
  }
  return out
}

/** Import a .pptx exactly as the server does, with media kept in memory. */
export async function importInMemory(buffer: Buffer): Promise<ImportedDeck> {
  const parsed = await parsePptx(buffer)
  const assets = new Map<string, InMemoryAsset>()
  const byPath = new Map<string, string>()
  let n = 0
  for (const [zipPath, media] of parsed.embeddedImages) {
    const id = `asset-${n++}`
    byPath.set(zipPath, id)
    assets.set(id, { bytes: media.bytes, mimeType: media.mimeType })
  }
  patchParsedAssetIds(parsed, byPath)
  const { state } = buildDeckUpdate(parsed)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(state))
  const handles = hydrateSlideDoc(doc)
  const slides = listSlides(handles)
  return { slides, assets, notes: notesOf(handles, slides) }
}

/** Export a deck exactly as the export route does, media from memory. */
export async function exportInMemory(deck: ImportedDeck): Promise<Buffer> {
  return writeDeck(deck.slides, {
    title: 'round-trip',
    assetLoader: async (id) => deck.assets.get(id) ?? null,
    notesBySlideId: deck.notes,
    now: new Date(0),
  })
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Fields whose values are identities, not content. */
const IDENTITY_KEYS = new Set(['id'])
/** Fields that name an uploaded asset; compared by the bytes they point at. */
const ASSET_KEYS = new Set(['assetId', 'posterAssetId'])

/**
 * Numbers compare within this: OOXML's own resolution (a hundredth of a
 * point is 1/50 of a canvas pixel, angles are 1/60 000 of a degree) is
 * finer, and a value that drifts further has been translated wrongly.
 */
export const NUMBER_TOLERANCE = 0.01

/** A deck-independent view of one slide: ids replaced by what they stand for. */
export function normaliseSlide(
  slide: Slide,
  assets: Map<string, InMemoryAsset>,
  slideIndex: ReadonlyMap<string, number> = new Map(),
): unknown {
  const objectIndex = new Map<string, number>()
  slide.objects.forEach((o, i) => objectIndex.set(o.id, i))
  const groupLabel = new Map<string, string>()
  const hashOf = (id: string): string => {
    const a = assets.get(id)
    return a === undefined
      ? `missing:${id}`
      : `sha1:${createHash('sha1').update(a.bytes).digest('hex').slice(0, 12)}`
  }

  const norm = (value: unknown, key: string | undefined): unknown => {
    if (value instanceof Y.Text) {
      return getParagraphDeltas(value).map((p) => ({
        attrs: norm(p.attrs, undefined),
        runs: mergeRuns(p.ops).map((r) => ({ text: r.text, attrs: norm(r.attrs, undefined) })),
      }))
    }
    if (typeof value === 'string') {
      if (key !== undefined && ASSET_KEYS.has(key)) return value === '' ? '' : hashOf(value)
      if (key === 'groupId') {
        if (!groupLabel.has(value)) groupLabel.set(value, `group-${groupLabel.size}`)
        return groupLabel.get(value)
      }
      if (key === 'slideId') {
        const i = slideIndex.get(value)
        return i === undefined ? value : `slide-${i + 1}`
      }
      if (key === 'targetId' || key === 'objectId') {
        const i = objectIndex.get(value)
        return i === undefined ? value : `object-${i}`
      }
      return value
    }
    if (Array.isArray(value)) return value.map((v) => norm(v, undefined))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(value).sort()) {
        if (IDENTITY_KEYS.has(k)) continue
        const v = (value as Record<string, unknown>)[k]
        if (v === undefined) continue
        out[k] = norm(v, k)
      }
      return out
    }
    return value
  }

  const { id: _id, objects, ...rest } = slide as Slide & Record<string, unknown>
  void _id
  return { ...(norm(rest, undefined) as object), objects: objects.map((o) => norm(o, undefined)) }
}

interface Run {
  text: string
  attrs: Record<string, unknown> | undefined
}

/** Adjacent runs with identical attributes are one run: how text is split
 *  into runs is the writer's business, what it says and how it looks is not. */
function mergeRuns(ops: ReadonlyArray<{ insert: unknown; attributes?: unknown }>): Run[] {
  const out: Run[] = []
  for (const op of ops) {
    if (typeof op.insert !== 'string') continue
    const attrs = (op.attributes ?? undefined) as Record<string, unknown> | undefined
    const last = out[out.length - 1]
    if (last !== undefined && JSON.stringify(last.attrs) === JSON.stringify(attrs)) {
      last.text += op.insert
    } else {
      out.push({ text: op.insert, attrs })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface Difference {
  slide: number
  /** JSON path inside the normalised slide, e.g. `objects[3].text[0].runs[1].text`. */
  path: string
  before: unknown
  after: unknown
}

function diffValues(a: unknown, b: unknown, path: string, out: Omit<Difference, 'slide'>[]): void {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > NUMBER_TOLERANCE) out.push({ path, before: a, after: b })
    return
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return
  const aObj = a !== null && typeof a === 'object'
  const bObj = b !== null && typeof b === 'object'
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      out.push({ path: `${path}.length`, before: a.length, after: b.length })
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      diffValues(a[i], b[i], `${path}[${i}]`, out)
    return
  }
  if (aObj && bObj && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
    for (const k of [...keys].sort()) {
      diffValues(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        path === '' ? k : `${path}.${k}`,
        out,
      )
    }
    return
  }
  out.push({ path, before: a, after: b })
}

/** Every difference between two imports of (supposedly) the same deck. */
export function diffDecks(before: ImportedDeck, after: ImportedDeck): Difference[] {
  const out: Difference[] = []
  if (before.slides.length !== after.slides.length) {
    out.push({
      slide: -1,
      path: 'slides.length',
      before: before.slides.length,
      after: after.slides.length,
    })
  }
  const indexOf = (deck: ImportedDeck): Map<string, number> =>
    new Map(deck.slides.map((s, i) => [s.id, i]))
  const beforeIndex = indexOf(before)
  const afterIndex = indexOf(after)
  for (let i = 0; i < Math.min(before.slides.length, after.slides.length); i++) {
    const local: Omit<Difference, 'slide'>[] = []
    const notesOf = (deck: ImportedDeck): unknown => deck.notes.get(deck.slides[i]!.id) ?? []
    diffValues(
      {
        ...(normaliseSlide(before.slides[i]!, before.assets, beforeIndex) as object),
        notes: notesOf(before),
      },
      {
        ...(normaliseSlide(after.slides[i]!, after.assets, afterIndex) as object),
        notes: notesOf(after),
      },
      '',
      local,
    )
    for (const d of local) out.push({ slide: i + 1, ...d })
  }
  return out
}

/** One line per difference, for test failures and the CLI. */
export function formatDifferences(differences: readonly Difference[]): string {
  const show = (v: unknown): string => {
    const j = JSON.stringify(v)
    return j === undefined ? 'undefined' : j.length > 120 ? `${j.slice(0, 117)}...` : j
  }
  return differences
    .map((d) => `slide ${d.slide} ${d.path}: ${show(d.before)} → ${show(d.after)}`)
    .join('\n')
}

/** import → export → import, and what changed on the way. */
export async function roundTrip(buffer: Buffer): Promise<{
  before: ImportedDeck
  after: ImportedDeck
  exported: Buffer
  differences: Difference[]
}> {
  const before = await importInMemory(buffer)
  const exported = await exportInMemory(before)
  const after = await importInMemory(exported)
  return { before, after, exported, differences: diffDecks(before, after) }
}
