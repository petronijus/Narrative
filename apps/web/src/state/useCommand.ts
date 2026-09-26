/**
 * state/useCommand.ts — the editor's BrowserHost (ADR 0010).
 *
 * UI code changes the document by dispatching commands from the shared
 * registry instead of calling slide-model mutations directly: the same
 * commands agents use over MCP, so every capability a user has is also an
 * agent capability by construction. The runner validates input, checks the
 * user's deck role and wraps each command in ONE `LOCAL_ORIGIN` transaction,
 * so each dispatch is exactly one undo step.
 */

import { useCallback, useMemo } from 'react'
import {
  createDefaultRegistry,
  runBatch,
  runCommandSync,
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

export interface CommandDispatch {
  /** Run one document command synchronously; throws `CommandError`. */
  run: <T = unknown>(command: string, input: unknown) => T
  /** Run several document commands as one atomic change and one undo step. */
  batch: (ops: ReadonlyArray<CommandInvocation>) => BatchResult
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
  const batch = useCallback(
    (ops: ReadonlyArray<CommandInvocation>) => runBatch(registry, ctx, ops),
    [ctx],
  )

  return useMemo(() => ({ run, batch }), [run, batch])
}
