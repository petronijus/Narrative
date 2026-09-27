/**
 * vocabulary.ts — the shared field descriptions stay in step with what the
 * commands really say, in both directions, and the instructions carry what
 * the tools no longer do.
 */

import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from '@narrative/commands'
import { Guidance } from './guidance.js'
import { ToolCatalog, commandInputJsonSchema, type ConfirmationMode } from './tools.js'
import {
  SHARED_DESCRIPTIONS,
  SHARED_FIELDS,
  SHARED_MIN_SAVED_BYTES,
  SHARED_MIN_TOOLS,
} from './vocabulary.js'

const registry = createDefaultRegistry()

/** Every `description` string in a JSON Schema. */
function descriptionsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) descriptionsIn(v, into)
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'description' && typeof v === 'string') into.add(v)
      else descriptionsIn(v, into)
    }
  }
  return into
}

/** description → how many commands' input schemas carry it (before the vocabulary removes it). */
function toolsPerDescription(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const def of registry.list()) {
    const { root } = commandInputJsonSchema(def, { keepShared: true })
    for (const d of descriptionsIn(root)) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  return counts
}

describe('shared field vocabulary', () => {
  const counts = toolsPerDescription()

  it('lists each description once', () => {
    expect(SHARED_DESCRIPTIONS.size).toBe(SHARED_FIELDS.length)
  })

  it('matches a description some command still has (a reworded .describe() fails here)', () => {
    const stale = SHARED_FIELDS.map((f) => f.description).filter((d) => !counts.has(d))
    expect(stale).toEqual([])
  })

  it('covers every description repeated widely enough to be worth saying once', () => {
    const missing = [...counts.entries()]
      .filter(
        ([d, n]) =>
          n >= SHARED_MIN_TOOLS &&
          (n - 1) * (JSON.stringify(d).length + '"description":,'.length) >=
            SHARED_MIN_SAVED_BYTES &&
          !SHARED_DESCRIPTIONS.has(d),
      )
      .map(([d, n]) => `${n}× ${d}`)
    expect(missing, 'add these to SHARED_FIELDS in vocabulary.ts').toEqual([])
  })

  it('leaves the shared descriptions out of every tool, in every confirmation mode', () => {
    const catalog = new ToolCatalog(registry)
    for (const mode of ['form', 'url', 'link'] satisfies ConfirmationMode[]) {
      for (const tool of catalog.list(mode)) {
        const left = [...descriptionsIn(tool.inputSchema)].filter((d) => SHARED_DESCRIPTIONS.has(d))
        expect(left, `${mode} ${tool.name}`).toEqual([])
      }
    }
  })

  it('says every note in the server instructions', () => {
    const instructions = new Guidance(registry).instructions()
    for (const { note } of SHARED_FIELDS) if (note !== '') expect(instructions).toContain(note)
  })
})
