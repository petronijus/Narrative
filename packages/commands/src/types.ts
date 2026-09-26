/**
 * commands/src/types.ts
 *
 * The capability registry's contract. Every user-visible capability of
 * Narrative is one `CommandDef`: the editor UI dispatches it, and agents
 * (over MCP) get exactly the same set. See ADR 0010 and
 * docs/plans/agentic-layer.md §4.2.
 */

import type { z } from 'zod'
import type { DeckMutationContext } from '@narrative/slide-model'

/** Deck roles, ordered: a higher role may do everything a lower one may. */
export type Role = 'viewer' | 'editor' | 'owner'

export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, editor: 1, owner: 2 }

/**
 * What a command touches. Only commands whose effects are exactly `['doc']`
 * (or read-only, `[]`) may run inside an atomic batch, because a batch is
 * executed on a fork of the deck document and applied as one delta.
 */
export type Effect = 'doc' | 'folderDoc' | 'componentDoc' | 'server' | 'render' | 'external'

/** Where a handler can run. Server-only commands are forwarded by browser hosts. */
export type Host = 'browser' | 'server'

export type Domain =
  | 'deck'
  | 'folder'
  | 'token'
  | 'slide'
  | 'object'
  | 'text'
  | 'table'
  | 'animation'
  | 'guide'
  | 'media'
  | 'component'
  | 'share'
  | 'style'
  | 'query'
  | 'editor'
  | 'ops'
  | 'agent'

export type UndoPolicy = 'undoable' | 'irreversible' | 'n/a'

/**
 * Human-in-the-loop policy for agents. `always`: an agent must obtain the
 * user's explicit confirmation (MCP elicitation) before the command runs —
 * used for irreversible, outward-facing commands (share, invite, delete).
 */
export type ConfirmPolicy = 'always' | 'never'

export interface Actor {
  /** Narrative user id the command runs as. Agents always act on behalf of a user. */
  userId: string
  /** The user's role on the target deck (folder owner counts as owner). */
  role: Role
  /** Who is at the keyboard. Agents never get more than the user's role. */
  kind: 'human' | 'agent'
}

export interface CommandContext {
  actor: Actor
  host: Host
  /**
   * Yjs transaction origin for everything this invocation writes. The
   * runner wraps the handler in ONE transaction with this origin; the
   * outermost origin wins over the `LOCAL_ORIGIN` slide-model mutations
   * pass themselves (see slide-model/src/origins.ts). Browser hosts pass
   * `LOCAL_ORIGIN` so the editor's undo keeps working; the server host
   * passes `agentOrigin(runId)`.
   */
  origin: unknown
  /** The deck document the command targets. Required by `doc` effects. */
  deck?: DeckMutationContext
}

/**
 * An HTTP route of the Narrative API server, with the path exactly as
 * Fastify registers it (`/decks/:id`, `/api/media/:assetId/url`; the
 * reverse proxy's extra `/api` prefix is not part of it). `ALL` is a route
 * registered for every method (the tus upload endpoints). Param names do
 * not matter when routes are compared (see parity/routes.ts).
 */
export interface RouteRef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL'
  path: string
}

export interface CommandExample<I> {
  /** What the example demonstrates, written for a model reading the tool docs. */
  title: string
  /** Input as an agent would send it (JSON-compatible). Runs against the fixture deck in tests. */
  input: I
}

export interface CommandDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** `<domain>.<verb>` or `<domain>.<noun>.<verb>`, lower camelCase segments. */
  id: string
  domain: Domain
  /** Short human label, e.g. "Duplicate objects". */
  title: string
  /**
   * Written for a model: what it does, when to use it, what it does NOT do
   * and which command to use instead. This becomes the MCP tool description.
   */
  description: string
  input: I
  output: O
  role: Role
  effects: readonly Effect[]
  undo: UndoPolicy
  confirm: ConfirmPolicy
  hosts: readonly Host[]
  /**
   * The `@narrative/slide-model` exports the handler relies on. The parity
   * test cross-checks this against the slide-model's writer inventory, so a
   * new writer without a command (or a known-missing entry) fails the build.
   */
  implementedWith: readonly string[]
  /**
   * The server routes this command is the agent-facing equivalent of (it
   * calls the same service the route calls). The route guard in
   * apps/server/src/routes/agentParity.test.ts counts a route as covered when
   * a command declares it here, so a new route without a command (or a
   * known-missing / allowlist entry) fails the server suite. Document-only
   * commands have none.
   */
  routes?: readonly RouteRef[]
  examples: readonly CommandExample<z.input<I>>[]
  /**
   * `wrap` (default): the runner opens the transaction. `self`: the handler
   * manages transactions itself (only `ops.apply`, which forks the document).
   */
  transaction?: 'wrap' | 'self'
  /**
   * Doc handlers MUST be synchronous and MUST check every precondition
   * (ids exist, indices in range) before their first write: a Yjs
   * transaction cannot be rolled back, so a throw after a write would leave
   * a half-applied command. The contract suite enforces this for every
   * command by running it against missing ids and asserting the document
   * is untouched.
   */
  handler: (ctx: CommandContext, input: z.output<I>) => z.input<O> | Promise<z.input<O>>
}

/** A command invocation as it travels over the wire (MCP, HTTP, batches). */
export interface CommandInvocation {
  command: string
  input: unknown
}
