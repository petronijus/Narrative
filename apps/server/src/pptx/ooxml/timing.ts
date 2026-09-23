/**
 * pptx/ooxml/timing.ts
 *
 * Slide animations ↔ `<p:timing>`.
 *
 * PowerPoint's timing tree is far richer than Narrative's flat list of
 * steps, and its effects are built from low-level behaviours, so the two do
 * not translate one to one. The writer does two things:
 *
 * - builds the tree PowerPoint itself writes — root, main sequence, one
 *   group per click, parallel / serial nodes for "with" / "after previous" —
 *   with a real preset (vocabulary ANIMATION) and behaviours that play it,
 *   so the deck animates in PowerPoint;
 * - puts the exact steps (easing, parameters, fractional times) in the
 *   timing's `<p:extLst>`, with a fingerprint of targets and presets.
 *
 * The reader takes the extension when its fingerprint matches what the
 * native tree says (nobody re-animated the slide in PowerPoint since), and
 * otherwise reads the native tree: trigger from `nodeType`, delay from the
 * effect's start condition, duration from its longest behaviour.
 */

import type { AnimationPreset, AnimationStep, AnimationTrigger } from '@narrative/shared'
import { isAnimationPreset, isAnimationTrigger, SLIDE_HEIGHT, SLIDE_WIDTH } from '@narrative/shared'
import { el, tag, type XmlElement } from './xml.js'
import { type XmlNode, findFirst, getAttrs, getChildren, getTag, walk } from './read.js'
import { ANIMATION, type AnimationToken } from './vocabulary.js'
import { bool, nonNeg, num, record, str, union } from './extSchema.js'

export const NARRATIVE_TIMING_EXT_URI = '{7C1A3E5B-2D4F-4B6A-8E9C-0A1B2C3D4E5F}'
export const NARRATIVE_TIMING_NS = 'urn:narrative:ooxml:timing:1'

const ms = (seconds: number): number => Math.max(0, Math.round(seconds * 1000))

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

class Ids {
  private n = 0
  next(): number {
    return ++this.n
  }
}

function target(spid: number): XmlElement {
  return tag('p:tgtEl', el('p:spTgt', { spid }))
}

function behaviourCtn(ids: Ids, durMs: number | 'indefinite', delayMs = 0): XmlElement {
  return el(
    'p:cTn',
    { id: ids.next(), dur: durMs, fill: 'hold' },
    tag('p:stCondLst', el('p:cond', { delay: delayMs })),
  )
}

function setVisibility(ids: Ids, spid: number, visible: boolean, atMs: number): XmlElement {
  return tag(
    'p:set',
    tag(
      'p:cBhvr',
      behaviourCtn(ids, 1, atMs),
      target(spid),
      tag('p:attrNameLst', tag('p:attrName', 'style.visibility')),
    ),
    tag('p:to', el('p:strVal', { val: visible ? 'visible' : 'hidden' })),
  )
}

function animEffect(
  ids: Ids,
  spid: number,
  dir: 'in' | 'out',
  filter: string,
  durMs: number,
): XmlElement {
  return el(
    'p:animEffect',
    { transition: dir, filter },
    tag('p:cBhvr', behaviourCtn(ids, durMs), target(spid)),
  )
}

/** `<p:anim>` of one property from a start value to an end value (strings as PowerPoint writes them). */
function animProp(
  ids: Ids,
  spid: number,
  attr: string,
  from: string,
  to: string,
  durMs: number,
): XmlElement {
  return el(
    'p:anim',
    { calcmode: 'lin', valueType: 'num' },
    el(
      'p:cBhvr',
      { additive: 'base' },
      behaviourCtn(ids, durMs),
      target(spid),
      tag('p:attrNameLst', tag('p:attrName', attr)),
    ),
    tag(
      'p:tavLst',
      el('p:tav', { tm: 0 }, tag('p:val', el('p:strVal', { val: from }))),
      el('p:tav', { tm: 100_000 }, tag('p:val', el('p:strVal', { val: to }))),
    ),
  )
}

function animRot(ids: Ids, spid: number, byDeg: number, durMs: number): XmlElement {
  return el(
    'p:animRot',
    { by: Math.round(byDeg * 60_000) },
    tag(
      'p:cBhvr',
      behaviourCtn(ids, durMs),
      target(spid),
      tag('p:attrNameLst', tag('p:attrName', 'r')),
    ),
  )
}

function animMotion(ids: Ids, spid: number, dx: number, dy: number, durMs: number): XmlElement {
  // Motion paths are in fractions of the slide.
  return el(
    'p:animMotion',
    {
      origin: 'layout',
      path: `M 0 0 L ${dx.toFixed(4)} ${dy.toFixed(4)} E`,
      pathEditMode: 'relative',
    },
    tag(
      'p:cBhvr',
      behaviourCtn(ids, durMs),
      target(spid),
      tag('p:attrNameLst', tag('p:attrName', 'ppt_x'), tag('p:attrName', 'ppt_y')),
    ),
  )
}

/** Where an animated object sits, for presets that move or turn it. */
export interface AnimatedTarget {
  spid: number
  /** Canvas px. */
  x: number
  y: number
  /** Degrees. */
  rotationDeg: number
}

/** Behaviours that play a preset in PowerPoint. */
function behaviours(ids: Ids, t: AnimatedTarget, step: AnimationStep): XmlElement[] {
  const spid = t.spid
  const d = Math.max(1, ms(step.duration))
  const p = step.params ?? {}
  switch (step.preset) {
    case 'fadeIn':
      return [setVisibility(ids, spid, true, 0), animEffect(ids, spid, 'in', 'fade', d)]
    case 'dissolveIn':
      return [setVisibility(ids, spid, true, 0), animEffect(ids, spid, 'in', 'dissolve', d)]
    case 'wipeIn':
      return [setVisibility(ids, spid, true, 0), animEffect(ids, spid, 'in', 'wipe(down)', d)]
    case 'slideIn':
      return [
        setVisibility(ids, spid, true, 0),
        animProp(ids, spid, 'ppt_y', '1+#ppt_h/2', '#ppt_y', d),
      ]
    case 'bounceIn':
      return [
        setVisibility(ids, spid, true, 0),
        animProp(ids, spid, 'ppt_y', '#ppt_y-0.25', '#ppt_y', d),
        animEffect(ids, spid, 'in', 'fade', d),
      ]
    case 'scaleIn':
    case 'zoomIn':
    case 'popIn':
      return [
        setVisibility(ids, spid, true, 0),
        animProp(ids, spid, 'ppt_w', '0', '#ppt_w', d),
        animProp(ids, spid, 'ppt_h', '0', '#ppt_h', d),
      ]
    case 'flipIn':
      return [setVisibility(ids, spid, true, 0), animProp(ids, spid, 'ppt_w', '0', '#ppt_w', d)]
    case 'rotateIn':
      return [
        setVisibility(ids, spid, true, 0),
        animRot(ids, spid, 360, d),
        animEffect(ids, spid, 'in', 'fade', d),
      ]
    case 'fadeOut':
      return [animEffect(ids, spid, 'out', 'fade', d), setVisibility(ids, spid, false, d - 1)]
    case 'slideOut':
      return [
        animProp(ids, spid, 'ppt_y', '#ppt_y', '1+#ppt_h/2', d),
        setVisibility(ids, spid, false, d - 1),
      ]
    case 'scaleOut':
      return [
        animProp(ids, spid, 'ppt_w', '#ppt_w', '0', d),
        animProp(ids, spid, 'ppt_h', '#ppt_h', '0', d),
        setVisibility(ids, spid, false, d - 1),
      ]
    case 'rotateTo': {
      // `angleDeg` is the angle to end at; PowerPoint rotates by a delta.
      const to = typeof p['angleDeg'] === 'number' ? (p['angleDeg'] as number) : t.rotationDeg
      return [animRot(ids, spid, to - t.rotationDeg, d)]
    }
    case 'moveTo': {
      // `targetX/Y` is where the object ends up (canvas px); PowerPoint's
      // motion path is a delta in fractions of the slide.
      const tx = typeof p['targetX'] === 'number' ? (p['targetX'] as number) : t.x
      const ty = typeof p['targetY'] === 'number' ? (p['targetY'] as number) : t.y
      return [animMotion(ids, spid, (tx - t.x) / SLIDE_WIDTH, (ty - t.y) / SLIDE_HEIGHT, d)]
    }
  }
}

function nodeTypeFor(trigger: AnimationTrigger, firstInGroup: boolean): string {
  if (trigger === 'onClick') return 'clickEffect'
  if (trigger === 'withPrevious') return 'withEffect'
  if (trigger === 'afterPrevious') return 'afterEffect'
  // onEnter: the slide's opening effects, after the previous one.
  return firstInGroup ? 'afterEffect' : 'withEffect'
}

function effectNode(
  ids: Ids,
  target: AnimatedTarget,
  step: AnimationStep,
  firstInGroup: boolean,
): XmlElement {
  const t: AnimationToken = ANIMATION.toXml(step.preset)
  return tag(
    'p:par',
    el(
      'p:cTn',
      {
        id: ids.next(),
        presetID: t.presetID,
        presetClass: t.presetClass,
        presetSubtype: t.presetSubtype,
        fill: 'hold',
        grpId: 0,
        nodeType: nodeTypeFor(step.trigger, firstInGroup),
      },
      tag('p:stCondLst', el('p:cond', { delay: ms(step.delay) })),
      tag('p:childTnLst', behaviours(ids, target, step)),
    ),
  )
}

interface Group {
  /** Starts on click (true) or with the slide (false, onEnter). */
  onClick: boolean
  /** Serial sub-sequences; steps in one sub-sequence start together. */
  sequences: AnimationStep[][]
}

function groupSteps(steps: readonly AnimationStep[]): Group[] {
  const groups: Group[] = []
  for (const s of steps) {
    const last = groups[groups.length - 1]
    if (
      s.trigger === 'onClick' ||
      last === undefined ||
      (s.trigger === 'onEnter' && last.onClick)
    ) {
      groups.push({ onClick: s.trigger === 'onClick', sequences: [[s]] })
    } else if (s.trigger === 'withPrevious') {
      last.sequences[last.sequences.length - 1]!.push(s)
    } else {
      last.sequences.push([s])
    }
  }
  return groups
}

const seqEnd = (seq: readonly AnimationStep[]): number =>
  Math.max(0, ...seq.map((s) => ms(s.delay) + ms(s.duration)))

function writeNativeTree(
  steps: readonly AnimationStep[],
  targetOf: (id: string) => AnimatedTarget | undefined,
): XmlElement {
  const ids = new Ids()
  const rootId = ids.next()
  const seqId = ids.next()
  const groups = groupSteps(steps).map((g) => {
    let at = 0
    const subs = g.sequences.map((seq) => {
      const node = tag(
        'p:par',
        el(
          'p:cTn',
          { id: ids.next(), fill: 'hold' },
          tag('p:stCondLst', el('p:cond', { delay: at })),
          tag(
            'p:childTnLst',
            seq.flatMap((s, i) => {
              const t = targetOf(s.objectId)
              return t === undefined ? [] : [effectNode(ids, t, s, i === 0)]
            }),
          ),
        ),
      )
      at += seqEnd(seq)
      return node
    })
    return tag(
      'p:par',
      el(
        'p:cTn',
        { id: ids.next(), fill: 'hold' },
        tag(
          'p:stCondLst',
          el('p:cond', { delay: 'indefinite' }),
          !g.onClick && el('p:cond', { evt: 'onBegin', delay: 0 }, el('p:tn', { val: seqId })),
        ),
        tag('p:childTnLst', subs),
      ),
    )
  })
  return tag(
    'p:tnLst',
    tag(
      'p:par',
      el(
        'p:cTn',
        { id: rootId, dur: 'indefinite', restart: 'never', nodeType: 'tmRoot' },
        tag(
          'p:childTnLst',
          el(
            'p:seq',
            { concurrent: 1, nextAc: 'seek' },
            el(
              'p:cTn',
              { id: seqId, dur: 'indefinite', nodeType: 'mainSeq' },
              tag('p:childTnLst', groups),
            ),
            tag(
              'p:prevCondLst',
              el('p:cond', { evt: 'onPrev', delay: 0 }, tag('p:tgtEl', tag('p:sldTgt'))),
            ),
            tag(
              'p:nextCondLst',
              el('p:cond', { evt: 'onNext', delay: 0 }, tag('p:tgtEl', tag('p:sldTgt'))),
            ),
          ),
        ),
      ),
    ),
  )
}

/** Fingerprint of a step list as the native tree carries it. */
function fingerprint(entries: ReadonlyArray<{ spid: number; token: AnimationToken }>): string {
  return entries
    .map((e) => `${e.spid}:${e.token.presetClass}:${e.token.presetID}:${e.token.presetSubtype}`)
    .join('|')
}

export function writeTiming(
  steps: readonly AnimationStep[],
  targetOf: (objectId: string) => AnimatedTarget | undefined,
): XmlElement | null {
  const placed = steps.filter((s) => targetOf(s.objectId) !== undefined)
  if (placed.length === 0) return null
  const fp = fingerprint(
    placed.map((s) => ({ spid: targetOf(s.objectId)!.spid, token: ANIMATION.toXml(s.preset) })),
  )
  const exact = placed.map((s) => {
    const { id: _id, objectId, ...rest } = s
    void _id
    return { ...rest, spid: targetOf(objectId)!.spid }
  })
  return tag(
    'p:timing',
    writeNativeTree(placed, targetOf),
    tag(
      'p:extLst',
      el(
        'p:ext',
        { uri: NARRATIVE_TIMING_EXT_URI },
        el('nx:steps', {
          'xmlns:nx': NARRATIVE_TIMING_NS,
          fingerprint: fp,
          values: JSON.stringify(exact),
        }),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A step as read, targeting a shape by its `spid`. */
export interface ReadAnimationStep {
  spid: number
  preset: AnimationPreset
  trigger: AnimationTrigger
  /** Seconds. */
  duration: number
  /** Seconds. */
  delay: number
  easing?: string
  params?: Record<string, unknown>
}

const maxBehaviourDur = (effect: XmlNode): number => {
  let max = 0
  for (const n of walk(getChildren(effect, 'p:cTn'))) {
    if (getTag(n) !== 'p:cTn') continue
    const d = Number(getAttrs(n)['@dur'])
    if (Number.isFinite(d) && d > max) max = d
  }
  return max
}

function readNative(timing: XmlNode): ReadAnimationStep[] {
  const out: ReadAnimationStep[] = []
  for (const node of walk([timing])) {
    if (getTag(node) !== 'p:cTn') continue
    const a = getAttrs(node)
    const presetClass = String(a['@presetClass'] ?? '')
    if (
      presetClass !== 'entr' &&
      presetClass !== 'exit' &&
      presetClass !== 'emph' &&
      presetClass !== 'path'
    )
      continue
    let spid = -1
    for (const d of walk([node])) {
      if (getTag(d) !== 'p:spTgt') continue
      const n = Number(getAttrs(d)['@spid'])
      if (Number.isFinite(n)) {
        spid = n
        break
      }
    }
    if (spid < 0) continue
    const preset = ANIMATION.fromXml({
      presetClass,
      presetID: Number(a['@presetID'] ?? 0),
      presetSubtype: Number(a['@presetSubtype'] ?? 0),
    })
    const nodeType = String(a['@nodeType'] ?? '')
    const trigger: AnimationTrigger =
      nodeType === 'clickEffect'
        ? 'onClick'
        : nodeType === 'withEffect'
          ? 'withPrevious'
          : nodeType === 'afterEffect'
            ? 'afterPrevious'
            : 'onEnter'
    const cond = findFirst(
      getChildren(findFirst(getChildren(node, 'p:cTn'), 'p:stCondLst') ?? {}, 'p:stCondLst'),
      'p:cond',
    )
    const delayMs = cond !== undefined ? Number(getAttrs(cond)['@delay']) : 0
    const durMs = maxBehaviourDur(node) || Number(a['@dur']) || 500
    out.push({
      spid,
      preset,
      trigger,
      duration: durMs / 1000,
      delay: Number.isFinite(delayMs) ? delayMs / 1000 : 0,
    })
  }
  return out
}

/** A GSAP ease name such as `power2.out` or `back.out(1.7)`. */
const easingName = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z0-9.(), -]{1,64}$/.test(v) ? v : undefined

/**
 * Preset parameters, as the extension may carry them: a flat map of
 * primitives. The file is untrusted input; the animation compiler clamps
 * the values it uses, this bounds what reaches it at all.
 */
const stepParams = (v: unknown): Record<string, unknown> | undefined =>
  record(/^[A-Za-z][A-Za-z0-9]{0,31}$/, union<unknown>(num, bool, str(100)), 32)(v)

/** Animation steps from a slide's `<p:timing>`, exact when the extension still matches. */
export function readTiming(sldChildren: XmlNode[]): ReadAnimationStep[] {
  const timing = findFirst(sldChildren, 'p:timing')
  if (timing === undefined) return []
  const native = readNative(timing)
  const extLst = findFirst(getChildren(timing, 'p:timing'), 'p:extLst')
  if (extLst !== undefined) {
    for (const ext of getChildren(extLst, 'p:extLst')) {
      if (getTag(ext) !== 'p:ext' || getAttrs(ext)['@uri'] !== NARRATIVE_TIMING_EXT_URI) continue
      const steps = findFirst(getChildren(ext, 'p:ext'), 'nx:steps')
      if (steps === undefined) continue
      const fp = fingerprint(
        native.map((s) => ({ spid: s.spid, token: ANIMATION.toXml(s.preset) })),
      )
      if (getAttrs(steps)['@fingerprint'] !== fp) break
      try {
        const values = JSON.parse(String(getAttrs(steps)['@values'] ?? '[]')) as unknown
        if (!Array.isArray(values)) break
        const exact: ReadAnimationStep[] = []
        for (const v of values as Array<Record<string, unknown>>) {
          if (
            typeof v['spid'] !== 'number' ||
            typeof v['preset'] !== 'string' ||
            !isAnimationPreset(v['preset'])
          )
            break
          if (typeof v['trigger'] !== 'string' || !isAnimationTrigger(v['trigger'])) break
          const step: ReadAnimationStep = {
            spid: v['spid'],
            preset: v['preset'],
            trigger: v['trigger'],
            duration: nonNeg(v['duration']) ?? 0.5,
            delay: nonNeg(v['delay']) ?? 0,
          }
          const easing = easingName(v['easing'])
          if (easing !== undefined) step.easing = easing
          const params = stepParams(v['params'])
          if (params !== undefined) step.params = params
          exact.push(step)
        }
        if (exact.length === native.length) return exact
      } catch {
        /* malformed extension: fall back to the native tree */
      }
      break
    }
  }
  return native
}
