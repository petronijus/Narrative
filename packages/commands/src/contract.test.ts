/**
 * Contract suite — runs over EVERY registered command, so a new command is
 * covered the moment it is registered:
 *   1. every example runs against the fixture deck and returns output that
 *      matches the declared schema;
 *   2. every document command, pointed at ids that do not exist, fails with
 *      `not_found` and leaves the document byte-for-byte unchanged (the
 *      "validate before the first write" rule — a Yjs transaction cannot be
 *      rolled back, so a half-applied command would be permanent).
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { LOCAL_ORIGIN } from '@narrative/slide-model'
import { createDefaultRegistry } from './catalog.js'
import { runCommandSync } from './run.js'
import { CommandError } from './errors.js'
import { createFixtureDeck } from './testing/fixtureDeck.js'
import type { CommandContext } from './types.js'

const registry = createDefaultRegistry()

function ctxFor(): CommandContext {
  return {
    actor: { userId: 'u1', role: 'owner', kind: 'agent' },
    host: 'server',
    origin: LOCAL_ORIGIN,
    deck: createFixtureDeck(),
  }
}

/** Every id that exists in the fixture deck. */
const FIXTURE_IDS = new Set([
  's1',
  's2',
  's3',
  'r1',
  'e1',
  't1',
  't2',
  'img1',
  'img2',
  'tbl1',
  'tbl2',
  'lock1',
  'ga',
  'gb',
  'a1',
  'a2',
  'gd1',
])

/**
 * Replace every fixture id (bare string or `{ id }`) and every positional
 * slide ref (an object whose only key is `index`) with something that does
 * not exist. Other numbers — insertion positions, offsets — are left alone.
 */
function breakRefs(value: unknown): { value: unknown; changed: boolean } {
  let changed = false
  const walk = (v: unknown, depth = 0): unknown => {
    if (typeof v === 'string' && FIXTURE_IDS.has(v)) {
      changed = true
      return `missing-${v}`
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    if (typeof v === 'object' && v !== null) {
      const keys = Object.keys(v)
      // depth > 0: the command input itself is never a ref (slide.add takes { index }).
      if (depth > 0 && keys.length === 1 && keys[0] === 'index') {
        changed = true
        return { index: 9999 }
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]))
    }
    return v
  }
  return { value: walk(value), changed }
}

describe('command contract', () => {
  for (const def of registry.list()) {
    describe(def.id, () => {
      it('has at least one example and a real description', () => {
        expect(def.examples.length).toBeGreaterThan(0)
        expect(def.description.length).toBeGreaterThanOrEqual(40)
      })

      def.examples.forEach((example, i) => {
        it(`example ${i + 1} runs: ${example.title}`, () => {
          const ctx = ctxFor()
          expect(() => runCommandSync(registry, ctx, def.id, example.input)).not.toThrow()
        })
      })

      if (def.effects.includes('doc') && def.transaction !== 'self') {
        it('fails cleanly on missing ids without touching the document', () => {
          const broken = def.examples.map((e) => breakRefs(e.input)).filter((b) => b.changed)
          if (broken.length === 0) return // nothing to break (e.g. slide.add with no refs)
          for (const { value } of broken) {
            const ctx = ctxFor()
            const before = Y.encodeStateVector(ctx.deck!.doc)
            let error: unknown
            try {
              runCommandSync(registry, ctx, def.id, value)
            } catch (e) {
              error = e
            }
            expect(error, `expected ${def.id} to fail on ${JSON.stringify(value)}`).toBeInstanceOf(
              CommandError,
            )
            expect(['not_found', 'invalid_input', 'conflict']).toContain(
              (error as CommandError).code,
            )
            expect(Y.encodeStateVector(ctx.deck!.doc)).toEqual(before)
          }
        })
      }
    })
  }
})
