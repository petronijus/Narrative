/**
 * state/useCommand.ts — the editor's BrowserHost (ADR 0010).
 *
 * UI code changes the document by dispatching commands from the shared
 * registry instead of calling slide-model mutations directly: the same
 * commands agents use over MCP, so every capability a user has is also an
 * agent capability by construction. The runner validates input, checks the
 * user's deck role and wraps each command in ONE `LOCAL_ORIGIN` transaction,
 * so each dispatch is exactly one undo step. The one-door lint rule
 * (apps/web/eslint.one-door.js) keeps the editor from writing any other way.
 */

import { useCallback, useMemo } from 'react'
import {
  CommandError,
  createDefaultRegistry,
  runBatch,
  runCommandSync,
  runGroup,
  type BatchResult,
  type CommandContext,
  type CommandInvocation,
} from '@narrative/commands'
import { LOCAL_ORIGIN } from '@narrative/slide-model'
import { useSlideDoc } from './useSlideDoc.js'
import { useDeckRole } from './DeckRoleContext.js'
import { useAuth } from './AuthContext.js'

/** One registry per page: definitions are stateless, so sharing it is safe. */
const registry = createDefaultRegistry()

/** Dispatch one command inside a {@link CommandDispatch.group}. */
export type GroupRun = <T = unknown>(command: string, input: unknown) => T

/**
 * Failures a gesture can meet without anything being wrong in the editor: a
 * collaborator deleted or changed what the gesture was aimed at a moment
 * before it landed. Everything else (invalid input, a role the UI should
 * not have offered the action to) is a bug and is thrown.
 */
const RACE_CODES = new Set(['not_found', 'conflict'])

export interface CommandDispatch {
  /** Run one document command synchronously; throws `CommandError`. */
  run: <T = unknown>(command: string, input: unknown) => T
  /**
   * `run`, for gestures that may race a collaborator: a `not_found` /
   * `conflict` refusal is logged and answered with `null` (nothing was
   * written), any other failure is thrown.
   */
  tryRun: <T = unknown>(command: string, input: unknown) => T | null
  /**
   * Several commands as ONE change and one undo step, without the fork an
   * atomic batch makes (see `runGroup`): for gestures that are more than
   * one command. A race refusal inside is logged and answered with `null`,
   * like `tryRun`; what ran before it stays applied.
   */
  group: <T>(fn: (run: GroupRun) => T) => T | null
  /** Run several document commands as one atomic change and one undo step. */
  batch: (ops: ReadonlyArray<CommandInvocation>) => BatchResult
}

function raceOrThrow(e: unknown, what: string): null {
  if (e instanceof CommandError && RACE_CODES.has(e.code)) {
    console.warn(`[command] ${what} did not apply: ${e.message}`)
    return null
  }
  throw e
}

export function useCommand(): CommandDispatch {
  const { deckCtx } = useSlideDoc()
  const { role } = useDeckRole()
  const { user } = useAuth()
  const userId = user?.sub ?? 'anonymous'

  const ctx = useMemo<CommandContext>(
    () => ({
      actor: { userId, role, kind: 'human' },
      host: 'browser',
      origin: LOCAL_ORIGIN,
      deck: deckCtx,
    }),
    [userId, role, deckCtx],
  )

  const run = useCallback(
    <T = unknown>(command: string, input: unknown): T =>
      runCommandSync(registry, ctx, command, input) as T,
    [ctx],
  )
  const tryRun = useCallback(
    <T = unknown>(command: string, input: unknown): T | null => {
      try {
        return runCommandSync(registry, ctx, command, input) as T
      } catch (e) {
        return raceOrThrow(e, command)
      }
    },
    [ctx],
  )
  const group = useCallback(
    <T>(fn: (run: GroupRun) => T): T | null => {
      try {
        return runGroup(registry, ctx, fn)
      } catch (e) {
        return raceOrThrow(e, 'command group')
      }
    },
    [ctx],
  )
  const batch = useCallback(
    (ops: ReadonlyArray<CommandInvocation>) => runBatch(registry, ctx, ops),
    [ctx],
  )

  return useMemo(() => ({ run, tryRun, group, batch }), [run, tryRun, group, batch])
}
