/**
 * commands/src/testing/harness.ts — test helper: a fixture deck plus
 * one-liners to run a command, expect a failure code, read an object, and
 * check that a failed command left the document untouched.
 */

import * as Y from 'yjs'
import { LOCAL_ORIGIN, getSlideObjectsCtx, yMapToPlainObject } from '@narrative/slide-model'
import { createDefaultRegistry } from '../catalog.js'
import { runCommandSync } from '../run.js'
import { CommandError } from '../errors.js'
import type { CommandContext } from '../types.js'
import { createFixtureDeck } from './fixtureDeck.js'
import { createFixtureFolderTokens } from './fixtureTokens.js'

const registry = createDefaultRegistry()

export interface Harness {
  ctx: CommandContext
  deck: NonNullable<CommandContext['deck']>
  run<T = Record<string, unknown>>(command: string, input: unknown): T
  /** Run a command that must fail; returns the error and asserts the document did not change. */
  fail(command: string, input: unknown): CommandError
  /** The live Y.Map of an object. */
  map(slideId: string, objectId: string): Y.Map<unknown>
  /** An object as a plain snapshot (text bodies stay live Y.Text). */
  plain(slideId: string, objectId: string): Record<string, unknown>
  /** An object's text body (text object, or a table cell). */
  text(slideId: string, objectId: string, cell?: { row: number; col: number }): Y.Text
}

export function harness(): Harness {
  const deck = createFixtureDeck()
  const ctx: CommandContext = {
    actor: { userId: 'u1', role: 'owner', kind: 'agent' },
    host: 'server',
    origin: LOCAL_ORIGIN,
    deck,
    folderTokens: createFixtureFolderTokens(),
  }
  const map = (slideId: string, objectId: string): Y.Map<unknown> => {
    const objects = getSlideObjectsCtx(deck, slideId)
    const found = objects?.objects.toArray().find((m) => m.get('id') === objectId)
    if (found === undefined) throw new Error(`test: ${slideId}/${objectId} not found`)
    return found
  }
  return {
    ctx,
    deck,
    run: <T>(command: string, input: unknown) => runCommandSync(registry, ctx, command, input) as T,
    fail(command, input) {
      const before = Y.encodeStateVector(deck.doc)
      let error: unknown
      try {
        runCommandSync(registry, ctx, command, input)
      } catch (e) {
        error = e
      }
      if (!(error instanceof CommandError)) {
        throw new Error(`expected ${command} to fail with a CommandError, got ${String(error)}`)
      }
      const after = Y.encodeStateVector(deck.doc)
      if (before.length !== after.length || before.some((b, i) => b !== after[i])) {
        throw new Error(`${command} failed (${error.code}) but changed the document`)
      }
      return error
    },
    map,
    plain: (slideId, objectId) =>
      yMapToPlainObject(map(slideId, objectId)) as unknown as Record<string, unknown>,
    text(slideId, objectId, cell) {
      const m = map(slideId, objectId)
      if (cell === undefined) return m.get('text') as Y.Text
      const rows = m.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>>
      return rows.get(cell.row).get(cell.col).get('text') as Y.Text
    },
  }
}
