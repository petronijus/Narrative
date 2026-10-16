/**
 * sharedShapes.ts — the shared input shapes stay in step with what the
 * commands really produce, in both directions; the tools carry only the
 * compact forms and the instructions carry the notes.
 */

import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from '@narrative/commands'
import { Guidance } from './guidance.js'
import { ToolCatalog, commandInputJsonSchema, type ConfirmationMode } from './tools.js'
import {
  SHAPE_MIN_SAVED_BYTES,
  SHAPE_MIN_TOOLS,
  SHARED_SHAPES,
  compactSharedShapes,
} from './sharedShapes.js'

const registry = createDefaultRegistry()

/** JSON of every object (not array) subtree of a schema. */
function subtrees(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) subtrees(v, into)
  else if (value !== null && typeof value === 'object') {
    into.push(JSON.stringify(value))
    for (const v of Object.values(value as Record<string, unknown>)) subtrees(v, into)
  }
  return into
}

/** subtree → { tools carrying it, occurrences } over the commands' schemas before the shapes apply. */
function shapeCounts(): Map<string, { tools: number; n: number }> {
  const counts = new Map<string, { tools: number; n: number }>()
  for (const def of registry.list()) {
    const { root } = commandInputJsonSchema(def, { keepShapes: true })
    const here = subtrees(root)
    for (const s of new Set(here)) {
      const c = counts.get(s) ?? { tools: 0, n: 0 }
      c.tools++
      c.n += here.filter((x) => x === s).length
      counts.set(s, c)
    }
  }
  return counts
}

describe('shared input shapes', () => {
  const counts = shapeCounts()
  const listed = new Set(SHARED_SHAPES.map((s) => JSON.stringify(s.match)))
  const compactForms = SHARED_SHAPES.map((s) => JSON.stringify(s.compact))
  /** A compact form, or a piece of one: what the shapes leave behind on purpose. */
  const leftByShapes = (s: string): boolean => compactForms.some((c) => c.includes(s))

  it('match a shape some command still produces (a changed zod schema fails here)', () => {
    const stale = SHARED_SHAPES.filter((s) => !counts.has(JSON.stringify(s.match))).map(
      (s) => s.name,
    )
    expect(stale).toEqual([])
  })

  it('cover every shape repeated widely enough to be worth compacting', () => {
    // A shape inside a listed one is compacted with it; count what is left.
    const compacted = new Map<string, { tools: number; n: number }>()
    for (const def of registry.list()) {
      const { root } = commandInputJsonSchema(def)
      const here = subtrees(root)
      for (const s of new Set(here)) {
        const c = compacted.get(s) ?? { tools: 0, n: 0 }
        c.tools++
        c.n += here.filter((x) => x === s).length
        compacted.set(s, c)
      }
    }
    const missing = [...compacted.entries()]
      .filter(
        ([s, c]) =>
          c.tools >= SHAPE_MIN_TOOLS &&
          // A bare type (`{"type":"number"}`) has nothing to leave out.
          s.length >= 60 &&
          (c.n - 1) * s.length >= SHAPE_MIN_SAVED_BYTES &&
          !listed.has(s) &&
          !leftByShapes(s) &&
          // The transport arguments and whole command inputs are not shapes.
          !s.startsWith('{"deckId"') &&
          !s.includes('"runId"'),
      )
      .map(([s, c]) => `${c.tools} tools ×${c.n}: ${s.slice(0, 160)}`)
    expect(missing, 'add these to SHARED_SHAPES in sharedShapes.ts').toEqual([])
  })

  it('leave only the compact forms in every tool, in every confirmation mode', () => {
    const catalog = new ToolCatalog(registry)
    for (const mode of ['form', 'url', 'link'] satisfies ConfirmationMode[]) {
      for (const tool of catalog.list(mode)) {
        const left = subtrees(tool.inputSchema).filter((s) => listed.has(s))
        expect(left, `${mode} ${tool.name}`).toEqual([])
      }
    }
  })

  it('compact the outermost match, and nothing else', () => {
    const colour = SHARED_SHAPES.find((s) => s.name === 'colour or token')!
    const other = { type: 'object', properties: { fill: colour.match, n: { type: 'number' } } }
    expect(compactSharedShapes(other)).toEqual({
      type: 'object',
      properties: { fill: colour.compact, n: { type: 'number' } },
    })
  })

  it('say every note in the server instructions', () => {
    const instructions = new Guidance(registry).instructions()
    for (const { note } of SHARED_SHAPES) if (note !== '') expect(instructions).toContain(note)
  })

  it('match a shape written with $refs, and leave a bare $ref to its compacted definition', () => {
    const colour = SHARED_SHAPES.find((s) => s.name === 'colour or token')!
    const body = SHARED_SHAPES.find((s) => s.name === 'text body')!
    // The text body with its run colour hoisted into $defs, as zod writes it
    // when the colour is used elsewhere in the same input.
    const hoisted = JSON.parse(
      JSON.stringify(body.match).replace(
        JSON.stringify(SHARED_SHAPES.find((s) => s.name === 'colour')!.match),
        '{"$ref":"#/$defs/c"}',
      ),
    )
    const out = compactSharedShapes({
      type: 'object',
      properties: { text: hoisted, fill: { $ref: '#/$defs/t' }, stroke: { $ref: '#/$defs/t' } },
      $defs: {
        c: SHARED_SHAPES.find((s) => s.name === 'colour')!.match,
        t: colour.match,
      },
    }) as Record<string, Record<string, unknown>>
    expect(out['properties']!['text']).toEqual(body.compact)
    // c is no longer used: dropped. t is compacted in place, still shared.
    expect(out['properties']!['fill']).toEqual({ $ref: '#/$defs/t' })
    expect(out['$defs']).toEqual({ t: colour.compact })
  })
})
