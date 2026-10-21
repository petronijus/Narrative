/**
 * renderer/experimental/textEngine/spike/scenes.ts — the text scenes of the
 * E7 spike page (EXPERIMENTAL, dev only).
 *
 *   - `crowded`: the 120 texts (+ probe) of the perf harness's crowded slide
 *     (`crowdedSlideOps`, packages/perf), Arial — the editor bench scene;
 *   - `present`: the first text slides of `presentTextOps` in Inter (a
 *     registered, embedded face: the WebKit 100 ms path);
 *   - `features`: one box per feature our markup has (lists, levels, mixed
 *     sizes, runs, underline, spacing, alignment, wrap none, transforms,
 *     tight / loose lines, stroke, long words, Inter weights, fallbacks,
 *     paragraph spacing) — the fidelity matrix.
 */

import * as Y from 'yjs'
import { crowdedSlideOps, presentTextOps, type Op } from '@narrative/perf'
import { PARAGRAPH_SEP } from '@narrative/slide-model'
import type { TextObject } from '../../../types'

interface Run {
  text: string
  attrs?: Record<string, unknown>
}
interface Para {
  runs: Run[]
  block?: Record<string, unknown>
}

const doc = new Y.Doc()
const holder = doc.getArray<Y.Text>('texts')

/** A Y.Text of paragraphs (each ends in a separator carrying its block attributes). */
function richText(paras: Para[]): Y.Text {
  const yt = new Y.Text()
  holder.push([yt])
  let at = 0
  paras.forEach((p) => {
    for (const r of p.runs) {
      yt.insert(at, r.text, r.attrs ?? {})
      at += r.text.length
    }
    yt.insert(at, PARAGRAPH_SEP, p.block ?? {})
    at += 1
  })
  return yt
}

function plain(lines: string[]): Y.Text {
  return richText(lines.map((l) => ({ runs: [{ text: l }] })))
}

function hex(c: unknown): number {
  return typeof c === 'string' ? Number.parseInt(c.replace('#', ''), 16) : Number(c ?? 0)
}

/** A text `object.create` op of the perf scenes as the renderer's TextObject. */
function fromOp(op: Op): TextObject | null {
  if (op.command !== 'object.create') return null
  const input = op.input as { id: string; object: Record<string, unknown> }
  const o = input.object
  if (o['type'] !== 'text') return null
  const body = o['text'] as { paragraphs: Array<{ text: string }> }
  const t: Record<string, unknown> = {
    ...o,
    id: input.id,
    text: plain(body.paragraphs.map((p) => p.text)),
    color: hex(o['color']),
  }
  return t as unknown as TextObject
}

export function crowdedScene(): TextObject[] {
  const { ops } = crowdedSlideOps({ texts: 120, images: 0, rects: 0 }, ['none'])
  return ops.map(fromOp).filter((t): t is TextObject => t !== null)
}

export function presentScene(slides = 3): TextObject[] {
  const { ops } = presentTextOps(slides, 'Inter')
  // Slides side by side would overlap; the scene only times rasters, so keep them stacked.
  return ops.map(fromOp).filter((t): t is TextObject => t !== null)
}

function box(
  id: string,
  col: number,
  row: number,
  text: Y.Text,
  extra: Partial<TextObject> = {},
): TextObject {
  return {
    id,
    type: 'text',
    x: 40 + col * 620,
    y: 40 + row * 260,
    width: 560,
    height: 220,
    rotation: 0,
    opacity: 1,
    text,
    fontSize: 24,
    fontWeight: 400,
    color: 0x1a1a1a,
    align: 'left',
    ...extra,
  } as unknown as TextObject
}

const LOREM =
  'The quick brown fox jumps over the lazy dog while seventeen wizards quietly box jumping zebras.'

export function featuresScene(): TextObject[] {
  const out: TextObject[] = []
  let n = 0
  const add = (id: string, text: Y.Text, extra: Partial<TextObject> = {}): void => {
    out.push(box(id, n % 3, Math.floor(n / 3), text, extra))
    n++
  }
  add('plain', plain([LOREM]))
  add(
    'bullets',
    richText([
      { runs: [{ text: 'First point of the list' }], block: { list: 'bullet' } },
      {
        runs: [{ text: 'Nested point that wraps onto a second line here' }],
        block: { list: 'bullet', level: 1 },
      },
      { runs: [{ text: 'Third level' }], block: { list: 'bullet', level: 2 } },
      { runs: [{ text: 'Back to the top' }], block: { list: 'bullet' } },
    ]),
  )
  add(
    'numbers',
    richText([
      { runs: [{ text: 'Numbered one' }], block: { list: 'number' } },
      { runs: [{ text: 'Numbered two' }], block: { list: 'number' } },
      {
        runs: [{ text: 'Sub a' }],
        block: { list: 'number', level: 1, numberFormat: 'lowerAlpha' },
      },
      { runs: [{ text: 'Numbered three' }], block: { list: 'number' } },
    ]),
  )
  add(
    'mixed-sizes',
    richText([
      {
        runs: [
          { text: 'Small ' },
          { text: 'Large', attrs: { fontSize: 44 } },
          { text: ' small again and wrapping' },
        ],
      },
      { runs: [{ text: 'A second paragraph at the frame size.' }] },
    ]),
  )
  add(
    'runs',
    richText([
      {
        runs: [
          { text: 'Plain, ' },
          { text: 'bold', attrs: { fontWeight: 700 } },
          { text: ', ' },
          { text: 'italic', attrs: { italic: true } },
          { text: ', ' },
          { text: 'red', attrs: { color: 0xcc2233 } },
          { text: ', ' },
          { text: 'underlined', attrs: { underline: true } },
          { text: ' and Georgia', attrs: { fontFamily: 'Georgia' } },
          { text: ' in one paragraph.' },
        ],
      },
    ]),
  )
  add('letter-spacing', plain(['Tracked out by four pixels', 'and centred']), {
    letterSpacing: 4,
    align: 'center',
  })
  add('right', plain([LOREM]), { align: 'right' })
  add('wrap-none', plain(['No wrap, a line longer than its box is', 'second']), { wrap: 'none' })
  add('uppercase', plain(['upper case transform', 'ß and ﬁ ligature']), {
    textTransform: 'uppercase',
  })
  add('capitalize', plain(["capitalize each word's start, o'neil x-ray"]), {
    textTransform: 'capitalize',
  })
  add('tight', plain(['Tight lines at 0.8', 'Second line', 'Third line']), {
    lineHeight: 0.8,
    fontSize: 36,
  })
  add('loose', plain(['Loose lines at spacing 1.6', 'Second line']), { lineSpacing: 1.6 })
  add('stroke', plain(['Stroked outline']), {
    fontSize: 48,
    fontWeight: 700,
    stroke: 0x2244aa,
    strokeWidth: 2,
    color: 0xffffff,
  })
  add('long-word', plain(['Supercalifragilisticexpialidociousandmuchlongerthanthebox ends']))
  add('hyphens', plain(['well-known state-of-the-art — dashes – and/or hyphen-ation']))
  add(
    'inter-weights',
    richText([
      {
        runs: [
          { text: 'Inter light ', attrs: { fontWeight: 300 } },
          { text: 'semibold ', attrs: { fontWeight: 600 } },
          { text: 'italic ', attrs: { italic: true } },
          { text: 'black', attrs: { fontWeight: 900 } },
        ],
      },
    ]),
    { fontFamily: 'Inter' },
  )
  add('fallback', plain(['café naïve Ελληνικά 日本語 → ★']))
  add('para-spacing', plain(['Paragraph one', 'Paragraph two', 'Paragraph three']), {
    paragraphSpaceBefore: 10,
    paragraphSpaceAfter: 6,
  })
  add(
    'small',
    plain(['Eleven pixel caption text that wraps across a few lines in a narrow box.']),
    {
      fontSize: 11,
    },
  )
  add('huge', plain(['Ag']), { fontSize: 160 })
  add('inter-body', plain([LOREM]), { fontFamily: 'Inter', fontSize: 20 })
  return out
}

export type SceneName = 'crowded' | 'present' | 'features'

export function sceneFor(name: SceneName): TextObject[] {
  if (name === 'crowded') return crowdedScene()
  if (name === 'present') return presentScene()
  return featuresScene()
}
