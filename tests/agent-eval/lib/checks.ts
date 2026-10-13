/**
 * tests/agent-eval/lib/checks.ts — deterministic grading helpers.
 *
 * Graders read the document back through `query.deck` / `query.slide` /
 * `query.object` (the JSON forms a model sees) and compare structurally —
 * never CRDT bytes (CLAUDE.md), never an LLM's opinion.
 */

import type { Check, EvalTarget, Grade, ToolCall, Transcript, World } from './types.js'

// ---------------------------------------------------------------------------
// Check collector
// ---------------------------------------------------------------------------

/** Collects named checks, so a failure report lists every broken expectation, not just the first. */
export class Checks {
  private readonly list: Check[] = []

  ok(name: string, pass: boolean, detail?: string): boolean {
    this.list.push(pass || detail === undefined ? { name, pass } : { name, pass, detail })
    return pass
  }

  eq(name: string, actual: unknown, expected: unknown): boolean {
    const diff = structuralDiff(actual, expected)
    return this.ok(name, diff === null, diff ?? undefined)
  }

  /** Record a check that could not be evaluated (a read failed): always a failure. */
  error(name: string, err: unknown): void {
    this.ok(name, false, err instanceof Error ? err.message : String(err))
  }

  done(): Grade {
    return { pass: this.list.length > 0 && this.list.every((c) => c.pass), checks: [...this.list] }
  }
}

// ---------------------------------------------------------------------------
// Structural comparison
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  const s = JSON.stringify(value)
  if (s === undefined) return String(value)
  return s.length > 160 ? `${s.slice(0, 157)}...` : s
}

/**
 * `null` when `a` and `b` are structurally equal (JSON semantics: key order
 * does not matter, `undefined` members count as absent), otherwise a short
 * description of the first difference and where it is.
 */
export function structuralDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${path}: got ${describe(a)}, expected ${describe(b)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return `${path}: got ${describe(a)}, expected ${describe(b)}`
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length}, expected ${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = structuralDiff(a[i], b[i], `${path}[${i}]`)
      if (d !== null) return d
    }
    return null
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
  for (const k of [...keys].sort()) {
    if (ao[k] === undefined && bo[k] === undefined) continue
    const d = structuralDiff(ao[k], bo[k], `${path}.${k}`)
    if (d !== null) return d
  }
  return null
}

// ---------------------------------------------------------------------------
// Document reads (the query.* output shapes)
// ---------------------------------------------------------------------------

export interface RunView {
  text: string
  fontFamily?: string
  fontWeight?: string | number
  italic?: boolean
  underline?: boolean
  color?: unknown
  fontSize?: number
  [k: string]: unknown
}

export interface ParagraphView {
  runs: RunView[]
  list?: string
  level?: number
  [k: string]: unknown
}

export interface ObjectView {
  id: string
  type: string
  name?: string
  x: number
  y: number
  width: number
  height: number
  text?: string
  paragraphs?: ParagraphView[]
  fontFamily?: string
  fontWeight?: string | number
  fontSize?: number
  imageRect?: { x: number; y: number; width: number; height: number }
  rows?: Array<Array<Record<string, unknown>>>
  colWidths?: number[]
  [k: string]: unknown
}

export interface StepView {
  id: string
  objectId: string
  preset: string
  trigger: string
  duration: number
  delay: number
  easing: string
  /** Seconds from the slide start, as the editor's timeline shows it (query.slide). */
  start: number
  [k: string]: unknown
}

export interface SlideView {
  id: string
  index: number
  name?: string
  transition: { kind: string; durationMs: number; direction?: string }
  background: Record<string, unknown> | null
  objects: ObjectView[]
  animations: StepView[]
  notes: string
}

export interface DeckOutline {
  slideCount: number
  slides: Array<{
    id: string
    index: number
    name?: string
    title?: string
    transition: string
    objectCount: number
    animationCount: number
    layout?: { packId: string; layoutId: string; surface?: string }
  }>
  guides: unknown[]
  meta: { variant?: Record<string, string>; fields?: Record<string, string>; lang?: string }
}

export function readDeck(world: World, deckId: string): Promise<DeckOutline> {
  return world.run<DeckOutline>({ deckId }, 'query.deck', {})
}

export function readSlide(
  world: World,
  target: EvalTarget,
  slide: string | { index: number },
): Promise<SlideView> {
  return world.run<SlideView>(target, 'query.slide', { slide })
}

/** Every slide of a deck in full — the structural snapshot "nothing changed" / "revert restored it" compare. */
export async function deckSnapshot(world: World, deckId: string): Promise<SlideView[]> {
  const outline = await readDeck(world, deckId)
  const slides: SlideView[] = []
  for (const s of outline.slides) slides.push(await readSlide(world, { deckId }, s.id))
  return slides
}

export function objectById(slide: SlideView, id: string): ObjectView | undefined {
  return slide.objects.find((o) => o.id === id)
}

/** The paragraphs of a text object (or table cell), whether or not it carries formatting. */
export function paragraphsOf(body: {
  text?: unknown
  paragraphs?: ParagraphView[]
}): ParagraphView[] {
  if (Array.isArray(body.paragraphs)) return body.paragraphs
  const text = typeof body.text === 'string' ? body.text : ''
  return text.split('\n\n').map((p) => ({ runs: p.length > 0 ? [{ text: p }] : [] }))
}

export function paragraphText(p: ParagraphView): string {
  return p.runs.map((r) => r.text).join('')
}

/** Plain text of a text object, paragraphs joined by a blank line. */
export function plainText(body: { text?: unknown; paragraphs?: ParagraphView[] }): string {
  return paragraphsOf(body).map(paragraphText).join('\n\n')
}

/** Collapse whitespace and trim, for comparisons that should not hinge on spacing. */
export function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function isBoldWeight(weight: unknown): boolean {
  if (weight === 'bold' || weight === 'bolder') return true
  if (typeof weight === 'number') return weight >= 600
  if (typeof weight === 'string' && /^\d+$/.test(weight)) return Number(weight) >= 600
  return false
}

/** What a run actually renders with: its own attribute, else the box default. */
export interface EffectiveRun {
  text: string
  fontFamily: string | undefined
  bold: boolean
}

export function effectiveRuns(obj: ObjectView): EffectiveRun[] {
  const out: EffectiveRun[] = []
  for (const p of paragraphsOf(obj)) {
    for (const r of p.runs) {
      if (r.text.length === 0) continue
      out.push({
        text: r.text,
        fontFamily: r.fontFamily ?? obj.fontFamily,
        bold: isBoldWeight(r.fontWeight ?? obj.fontWeight),
      })
    }
  }
  return out
}

/**
 * Font family names compare case-insensitively and without quotes. A stack
 * ("Inter, system-ui, sans-serif" — what the Inspector's font picker stores
 * for Inter) is its primary family: that is the font it renders in.
 */
export function sameFamily(a: string | undefined, b: string): boolean {
  if (a === undefined) return false
  const primary = a.split(',')[0]!
  return primary.replace(/["']/g, '').trim().toLowerCase() === b.toLowerCase()
}

// ---------------------------------------------------------------------------
// Transcript reads
// ---------------------------------------------------------------------------

export function allCalls(transcript: Transcript): ToolCall[] {
  return transcript.steps.flatMap((s) => s.calls)
}

/** Narrative calls of `command`; `ok: true` keeps only the successful ones. */
export function callsOf(
  transcript: Transcript,
  command: string,
  opts: { ok?: boolean } = {},
): ToolCall[] {
  return allCalls(transcript).filter(
    (c) => c.command === command && (opts.ok !== true || !c.isError),
  )
}

/** Commands called inside `ops.apply` batches count too: they are the same edits. */
export function commandsUsed(transcript: Transcript): string[] {
  const out: string[] = []
  for (const c of allCalls(transcript)) {
    if (c.command === null) continue
    out.push(c.command)
    if (c.command === 'ops.apply' && Array.isArray(c.input['ops'])) {
      for (const op of c.input['ops'] as Array<{ command?: unknown }>) {
        if (typeof op.command === 'string') out.push(op.command.replace(/_/g, '.'))
      }
    }
  }
  return out
}

export function finalText(transcript: Transcript): string {
  return transcript.steps.at(-1)?.finalText ?? ''
}
