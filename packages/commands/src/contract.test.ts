/**
 * Contract suite — runs over EVERY registered command, so a new command is
 * covered the moment it is registered:
 *   1. every example runs against the fixture deck and returns output that
 *      matches the declared schema;
 *   2. every document command, pointed at ids that do not exist, fails with
 *      `not_found` and leaves the document byte-for-byte unchanged (the
 *      "validate before the first write" rule — a Yjs transaction cannot be
 *      rolled back, so a half-applied command would be permanent);
 *   3. every command marked `idempotent` runs each example twice, and the
 *      second run succeeds, returns the same result, and leaves the document
 *      structurally as the first left it AND the server fakes' state exactly
 *      as the first left it (MCP's idempotentHint promises exactly that;
 *      without the fakes' state a server command such as `deck.rename`
 *      would pass vacuously — it never touches the document). Structural
 *      equality (`Y.Doc#toJSON`), never bytes: a repeated write adds Yjs
 *      items even when it sets the same value;
 *   4. every deck command runs its examples against a component master
 *      (target `{ componentId }`): one with `acceptsComponent` must accept
 *      it (any failure is about the input, never the target), one without
 *      must refuse it with `no_target` — so the metadata the MCP tools and
 *      the host rely on matches what the handlers really do; and against a
 *      folder (target `{ folderId }`, no document), which only commands
 *      with `acceptsFolder` take.
 *
 * Examples run the way the server host runs them: `runCommand` on the
 * server host, with the fixture deck as the target document and in-memory
 * fakes of the server services (testing/fakeServices.ts), so commands with
 * the `server` effect or an async `load` phase are held to the same
 * standard as document commands instead of being exempted.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { LOCAL_ORIGIN } from '@narrative/slide-model'
import { createDefaultRegistry } from './catalog.js'
import { runCommand } from './run.js'
import { CommandError } from './errors.js'
import { createFixtureDeck } from './testing/fixtureDeck.js'
import { createFixtureFolderFonts, createFixtureFolderTokens } from './testing/fixtureTokens.js'
import {
  FIXTURE_COMPONENT_ID,
  FIXTURE_DECK_ID,
  FIXTURE_FOLDER_ID,
  createFakeServices,
  FIXTURE_RUN_ID,
  type FakeServices,
} from './testing/fakeServices.js'
import type { CommandContext, CommandTarget } from './types.js'

const registry = createDefaultRegistry()

function ctxFor(
  target: CommandTarget = { deckId: FIXTURE_DECK_ID, folderId: FIXTURE_FOLDER_ID },
): CommandContext & { services: FakeServices } {
  return {
    actor: { userId: 'u1', role: 'owner', kind: 'agent' },
    host: 'server',
    origin: LOCAL_ORIGIN,
    deck: createFixtureDeck(),
    folderTokens: createFixtureFolderTokens(),
    folderFonts: createFixtureFolderFonts(),
    target,
    services: createFakeServices(),
    session: { key: 'mcp:contract', surface: 'mcp', clientName: 'contract-suite' },
    // The session's current run, as an agent that changed the deck has one
    // (query.render's compare shows the deck before it).
    run: { runId: FIXTURE_RUN_ID, surface: 'mcp' },
  }
}

/**
 * The document as plain data, including what `Y.Doc#toJSON` drops: a Y.Text
 * becomes its delta (formatting attributes included), so `text.format` is
 * compared on what it changes. Structural, never bytes (see the header).
 */
function structure(value: unknown): unknown {
  if (value instanceof Y.Doc)
    return Object.fromEntries(
      [...value.share.keys()].sort().map((k) => [k, structure(value.get(k))]),
    )
  if (value instanceof Y.Text) return { text: value.toDelta() as unknown }
  if (value instanceof Y.Map)
    return Object.fromEntries([...value.keys()].sort().map((k) => [k, structure(value.get(k))]))
  if (value instanceof Y.Array) return value.toArray().map(structure)
  if (value instanceof Y.AbstractType) return value.toJSON()
  return value
}

/**
 * Idempotent commands whose output reports what THIS call changed, so a
 * repeat legitimately answers differently (the state still must not move).
 * Their second and third answers must agree instead.
 */
const REPORTS_ITS_OWN_CHANGE: Readonly<Record<string, string>> = {
  'deck.moveToFolder': '`moved` is false on a repeat: the deck already is in that folder',
  'token.update':
    '`previous` holds the value the first run set: the repeat replaced it with itself',
  'token.seedDefaults':
    '`seeded` / `migrated` are false on a repeat: nothing is left to add or bring up to date',
  'component.restamp':
    '`added` / `removed` are empty on a repeat: the stamps already match the master, so what the first run added is among `updated`',
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
  'hd1',
  'ga',
  'gb',
  'a1',
  'a2',
  'gd1',
  'st_bar',
  'st_title',
  'st_old',
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
        it(`example ${i + 1} runs: ${example.title}`, async () => {
          const ctx = ctxFor()
          // Rejects on any failure, including output that violates the schema.
          await runCommand(registry, ctx, def.id, example.input)
        })
      })

      if (def.idempotent === true) {
        it('is idempotent: repeating an example changes nothing more', async () => {
          let changedSomething = false
          for (const example of def.examples) {
            const ctx = ctxFor()
            const state = () => ({
              doc: structure(ctx.deck!.doc),
              services: ctx.services.snapshot(),
            })
            const before = state()
            const first = await runCommand(registry, ctx, def.id, example.input)
            const once = state()
            const second = await runCommand(registry, ctx, def.id, example.input)
            expect(state(), example.title).toEqual(once)
            if (REPORTS_ITS_OWN_CHANGE[def.id] === undefined) {
              expect(second, example.title).toEqual(first)
            } else {
              const third = await runCommand(registry, ctx, def.id, example.input)
              expect(third, example.title).toEqual(second)
              expect(state(), example.title).toEqual(once)
            }
            if (JSON.stringify(once) !== JSON.stringify(before)) changedSomething = true
          }
          // Not vacuous: some example changes something the check can see (an
          // example may set the value already there, but not all of them).
          expect(changedSomething, 'no example changes the document or the server state').toBe(true)
        })
      }

      if ((def.scope ?? 'deck') === 'deck') {
        const accepts = def.acceptsComponent === true
        it(`${accepts ? 'accepts' : 'refuses'} a component master as its target`, async () => {
          for (const example of def.examples) {
            const ctx = ctxFor({ componentId: FIXTURE_COMPONENT_ID })
            let error: unknown
            try {
              await runCommand(registry, ctx, def.id, example.input)
            } catch (e) {
              error = e
            }
            if (accepts) {
              // The fixture master may lack an id the example names (a run
              // of the deck, say); what matters is that the target is taken.
              if (error !== undefined) {
                expect(error, example.title).toBeInstanceOf(CommandError)
                expect(['no_target', 'wrong_host'], example.title).not.toContain(
                  (error as CommandError).code,
                )
              }
            } else {
              expect(error, example.title).toBeInstanceOf(CommandError)
              expect((error as CommandError).code, example.title).toBe('no_target')
            }
          }
        })
      }

      if ((def.scope ?? 'deck') === 'deck') {
        const accepts = def.acceptsFolder === true
        it(`${accepts ? 'accepts' : 'refuses'} a folder as its target`, async () => {
          for (const example of def.examples) {
            // A folder has no document: the host provides none.
            const { deck: _deck, ...ctx } = ctxFor({ folderId: FIXTURE_FOLDER_ID })
            let error: unknown
            try {
              await runCommand(registry, ctx, def.id, example.input)
            } catch (e) {
              error = e
            }
            if (accepts) {
              if (error !== undefined) {
                expect(error, example.title).toBeInstanceOf(CommandError)
                expect(['no_target', 'wrong_host'], example.title).not.toContain(
                  (error as CommandError).code,
                )
              }
            } else {
              expect(error, example.title).toBeInstanceOf(CommandError)
              expect((error as CommandError).code, example.title).toBe('no_target')
            }
          }
        })
      }

      if (def.effects.includes('doc') && def.transaction !== 'self') {
        it('fails cleanly on missing ids without touching the document', async () => {
          const broken = def.examples.map((e) => breakRefs(e.input)).filter((b) => b.changed)
          if (broken.length === 0) return // nothing to break (e.g. slide.add with no refs)
          for (const { value } of broken) {
            const ctx = ctxFor()
            const before = Y.encodeStateVector(ctx.deck!.doc)
            let error: unknown
            try {
              // runCommand, not runCommandSync: commands with a `load` phase
              // (component.stamp, deck.insertFrom) must hold to this too.
              await runCommand(registry, ctx, def.id, value)
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
