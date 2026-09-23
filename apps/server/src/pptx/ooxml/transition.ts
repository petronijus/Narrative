/**
 * pptx/ooxml/transition.ts
 *
 * Slide transitions, both directions.
 *
 * The base PresentationML schema knows fade and push but not the transitions
 * PowerPoint added later — Cube is `p14:prism` (2010), Morph `p159:morph`
 * (2016) — nor an exact duration (`p14:dur`; the base schema only has
 * slow/medium/fast). PowerPoint writes those inside `mc:AlternateContent`: a
 * `Choice` for readers that know the extension and a base-schema `Fallback`
 * for everyone else. The writer does the same, and the reader looks inside
 * the Choice first, which the importer did not: Morph and exact durations
 * came in as a generic fade.
 */

import type { SlideTransition } from '@narrative/shared'
import { el, tag, NS, type XmlElement } from './xml.js'
import { type XmlNode, findFirst, getAttrs, getChildren, getTag } from './read.js'
import { DIRECTION } from './vocabulary.js'

/** Base-schema speed for a duration, for readers without `p14:dur`. */
function speedFor(ms: number): 'fast' | 'med' | 'slow' {
  if (ms <= 500) return 'fast'
  if (ms <= 750) return 'med'
  return 'slow'
}

/** Base-schema speed → the duration PowerPoint uses for it. */
function durationForSpeed(spd: string): number {
  if (spd === 'fast') return 500
  if (spd === 'slow') return 1000
  return 750
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function effect(t: SlideTransition, extended: boolean): XmlElement {
  const dir = t.direction !== undefined ? DIRECTION.toXml(t.direction) : undefined
  if (t.kind === 'push') return el('p:push', { dir })
  if (extended && t.kind === 'cube') return el('p14:prism', { dir })
  if (extended && t.kind === 'magic') return el('p159:morph', { option: 'byObject' })
  // Fade, and the base-schema stand-in for Cube / Morph.
  return tag('p:fade')
}

/**
 * The slide's transition element, or null for "none". Everything is wrapped
 * in `mc:AlternateContent` so the exact duration (and Cube / Morph) reach
 * readers that understand them while the Fallback stays base-schema valid.
 */
export function writeTransition(t: SlideTransition | undefined): XmlElement | null {
  if (t === undefined || t.kind === 'none') return null
  const ms = Math.max(0, Math.round(t.durationMs))
  const spd = speedFor(ms)
  const needs = t.kind === 'magic' ? 'p159' : 'p14'
  return el(
    'mc:AlternateContent',
    { 'xmlns:mc': NS.mc },
    el(
      'mc:Choice',
      {
        Requires: needs,
        'xmlns:p14': NS.p14,
        ...(needs === 'p159' ? { 'xmlns:p159': NS.p159 } : {}),
      },
      el('p:transition', { spd, 'p14:dur': ms }, effect(t, true)),
    ),
    tag('mc:Fallback', el('p:transition', { spd }, effect(t, false))),
  )
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Extension namespaces the reader understands in an AlternateContent Choice. */
const UNDERSTOOD = new Set(['p14', 'p159'])

/**
 * The `<p:transition>` a reader that knows p14 / p159 would use: the first
 * Choice whose `Requires` it understands, else the Fallback, else a bare
 * `<p:transition>` child of the slide.
 */
export function findTransitionNode(sldChildren: XmlNode[]): XmlNode | undefined {
  for (const node of sldChildren) {
    const t = getTag(node)
    if (t === 'p:transition') return node
    if (t !== 'mc:AlternateContent') continue
    const kids = getChildren(node, 'mc:AlternateContent')
    for (const choice of kids) {
      if (getTag(choice) !== 'mc:Choice') continue
      const req = String(getAttrs(choice)['@Requires'] ?? '').split(/\s+/)
      if (!req.every((r) => UNDERSTOOD.has(r))) continue
      const tr = findFirst(getChildren(choice, 'mc:Choice'), 'p:transition')
      if (tr !== undefined) return tr
    }
    const fb = findFirst(kids, 'mc:Fallback')
    if (fb !== undefined) {
      const tr = findFirst(getChildren(fb, 'mc:Fallback'), 'p:transition')
      if (tr !== undefined) return tr
    }
  }
  return undefined
}

export function readTransition(sldChildren: XmlNode[]): SlideTransition | undefined {
  const trans = findTransitionNode(sldChildren)
  if (trans === undefined) return undefined
  const a = getAttrs(trans)
  const exact = Number(a['@p14:dur'] ?? a['@dur'])
  const durationMs =
    Number.isFinite(exact) && exact >= 0 ? exact : durationForSpeed(String(a['@spd'] ?? 'med'))

  const dirOf = (node: XmlNode): SlideTransition['direction'] => {
    const d = getAttrs(node)['@dir']
    return typeof d === 'string' ? DIRECTION.fromXml(d) : undefined
  }
  // The effect is the transition's one element child other than its sound
  // action and extension list. `<p:transition spd advClick/>` with none —
  // common: it only carries advance settings — shows no transition at all.
  const effects = getChildren(trans, 'p:transition').filter((ch) => {
    const t = getTag(ch)
    return t !== null && t !== 'p:sndAc' && t !== 'p:extLst'
  })
  if (effects.length === 0) return undefined
  for (const ch of effects) {
    const tag = getTag(ch)
    if (tag === null) continue
    if (tag === 'p:fade' || tag === 'p:cut' || tag === 'p:dissolve')
      return { kind: 'fade', durationMs }
    if (tag === 'p159:morph') return { kind: 'magic', durationMs }
    if (tag === 'p:push' || tag === 'p:cover' || tag === 'p:pull' || tag === 'p:wipe') {
      const direction = dirOf(ch) ?? 'left'
      return { kind: 'push', durationMs, direction }
    }
    if (
      tag === 'p14:prism' ||
      tag === 'p14:flythrough' ||
      tag === 'p14:doors' ||
      tag === 'p14:switch' ||
      tag === 'p14:flip'
    ) {
      const direction = dirOf(ch)
      return direction !== undefined
        ? { kind: 'cube', durationMs, direction }
        : { kind: 'cube', durationMs }
    }
  }
  // A transition PowerPoint has and Narrative does not: fade is the closest.
  return { kind: 'fade', durationMs }
}
