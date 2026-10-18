/**
 * commands/src/types.ts
 *
 * The capability registry's contract. Every user-visible capability of
 * Narrative is one `CommandDef`: the editor UI dispatches it, and agents
 * (over MCP) get exactly the same set. See ADR 0010 and
 * docs/plans/agentic-layer.md §4.2.
 */

import type { z } from 'zod'
import type { DeckMutationContext, FolderTokensSnapshot } from '@narrative/slide-model'
import type { ServerServices } from './services.js'
import type { FontFaceWeight } from './text/fontWeights.js'
import type { StylePack } from '@narrative/shared'
import type { BatchForks } from './batchForks.js'

/** Deck roles, ordered: a higher role may do everything a lower one may. */
export type Role = 'viewer' | 'editor' | 'owner'

export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, editor: 1, owner: 2 }

/**
 * The role a command needs on `target`: `roleOn.component` on a component
 * master, `roleOn.folder` on a folder named in place of a deck
 * (`acceptsFolder`), else `role`.
 */
export function requiredRole(
  def: { role: Role; scope?: CommandScope; roleOn?: { component?: Role; folder?: Role } },
  target: CommandTarget | undefined,
): Role {
  if ((def.scope ?? 'deck') !== 'deck' || target === undefined) return def.role
  if (target.componentId !== undefined) return def.roleOn?.component ?? def.role
  if (target.deckId === undefined && target.folderId !== undefined)
    return def.roleOn?.folder ?? def.role
  return def.role
}

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

/**
 * Can the effect of a command be taken back, and how?
 *
 *   `undoable`      Document commands (`doc` effects): the change is one step
 *                   of the editor's undo (browser host), and for an agent one
 *                   change of its run, which `agent.revert` undoes. Server
 *                   commands (no document effect): a COUNTER-COMMAND exists
 *                   that takes it back, named in `undoneBy` (required, and
 *                   checked to exist) — e.g. `deck.rename` is undone by
 *                   `deck.rename` (rename back), `deck.create` by
 *                   `deck.delete`, `media.upload` by `media.delete`.
 *                   `agent.revert` does NOT undo server commands: a run's
 *                   revert only touches documents.
 *   `irreversible`  Nothing takes it back (a delete, a revoke, a message sent
 *                   to someone, a move whose previous place is not kept).
 *                   Outward-facing or destructive ones are `confirm: 'always'`
 *                   (registry.ts `commandConfirmationProblems`).
 *   `n/a`           Changes nothing that would need undoing: reads, and
 *                   commands whose only effect is transient (a run opened,
 *                   an editor pointed at a slide, a signed link issued).
 */
export type UndoPolicy = 'undoable' | 'irreversible' | 'n/a'

/**
 * Human-in-the-loop policy for agents. `always`: an agent must obtain the
 * user's explicit confirmation before the command runs — used for
 * irreversible, outward-facing commands (share, invite, delete). How the
 * user confirms depends on the transport (MCP: a question in the client, or
 * a confirmation page in Narrative for clients that cannot ask; the command
 * API: an explicit per-command list). Input-dependent confirmation is
 * `confirmWhen` on the command.
 */
export type ConfirmPolicy = 'always' | 'never'

/** One line of what the user is asked to approve ("Downloads from": "example.com"). */
export interface ConfirmationDetail {
  label: string
  value: string
}

/**
 * Why ONE invocation of a command needs the user's explicit confirmation
 * although the command itself is not `confirm: 'always'` — decided from its
 * input by `CommandDef.confirmWhen`. Metadata, not transport code: every
 * host evaluates it next to `confirm`, and each transport asks the user its
 * own way.
 *
 *   `url_fetch`  the server would download a file from a URL the caller
 *                chose. A URL is an exfiltration channel (its path and query
 *                can carry anything the model read), so the user approves
 *                the host first. `hosts` lists every host the input names;
 *                the server host skips the question when all of them are on
 *                its configured allowlist (AGENT_URL_FETCH_ALLOWED_HOSTS).
 */
export interface ConditionalConfirmation {
  kind: 'url_fetch'
  /** One sentence for the user, e.g. "Narrative will download a file from the web." */
  reason: string
  /** What exactly, one line each (shown as separate lines). */
  details: readonly ConfirmationDetail[]
  /** `url_fetch`: the hosts the input names (lower-case, as `URL#host` spells them). */
  hosts: readonly string[]
}

export interface Actor {
  /** Narrative user id the command runs as. Agents always act on behalf of a user. */
  userId: string
  /** The user's role on the target (a folder role counts on the folder's decks and components). */
  role: Role
  /** Who is at the keyboard. Agents never get more than the user's role. */
  kind: 'human' | 'agent'
}

/**
 * What a command acts on — and therefore how a host authorises it before
 * the runner checks `role` against `actor.role`:
 * - `deck`: one deck. The host resolves the actor's role ON THAT DECK (the
 *   transport names it: the MCP adapter adds a `deckId` argument, the editor
 *   knows its open deck) and, for `doc` effects, provides its document.
 * - `folder`: one folder (tokens, fonts, components). The host resolves the
 *   actor's folder access.
 * - `user`: the actor's own account (list decks, create a folder, …). No
 *   target; services scope everything to `actor.userId`, and the host sets
 *   `actor.role` to `owner` (a user owns their own account).
 */
export type CommandScope = 'deck' | 'folder' | 'user'

/** Which deck or folder a `deck`/`folder`-scoped invocation targets. */
export interface CommandTarget {
  deckId?: string
  /**
   * A component master instead of a deck: every document command also works
   * on a component's document (`component:<id>`), which is how an agent
   * edits a master. The host opens and authorises it like a deck.
   */
  componentId?: string
  folderId?: string
}

/** The agent run an invocation belongs to (server host only). */
export interface AgentRunInfo {
  runId: string
  surface: 'mcp' | 'api'
}

/**
 * The agent session an invocation arrives through (server host only): one
 * MCP session, or one API client. Runs are opened per session and target
 * (see `agent.startRun`), so commands that manage runs need to know it.
 */
export interface AgentSessionInfo {
  /** Stable id of the session for as long as it lives (MCP session id, or `api:<user>:<token>`). */
  key: string
  surface: 'mcp' | 'api'
  /** Client name the session reported (e.g. "claude-code"), when it reported one. */
  clientName?: string
  /**
   * The credential the session authenticated with, as the server's
   * revocation paths name it (`token:<pat id>`, `token:oauth:<grant id>`):
   * what it opens (an upload session) dies when that credential is revoked.
   */
  credential?: string
}

export interface CommandContext {
  actor: Actor
  host: Host
  /** Resolved target of a `deck`/`folder`-scoped command. */
  target?: CommandTarget
  /**
   * Server capabilities (deck/folder CRUD, sharing, media, PPTX, components,
   * editor presence, agent runs). Provided by the server host; required by
   * commands with the `server` effect. See services.ts.
   */
  services?: ServerServices
  /** Set by the server host for agent invocations that belong to a run. */
  run?: AgentRunInfo
  /** Set by the server host for every agent invocation. */
  session?: AgentSessionInfo
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
  /**
   * The design tokens (colours, text styles, effect styles) of the folder
   * the target deck or component master belongs to, read-only — for
   * commands that resolve a token or apply a text style
   * (`readsFolderTokens`). `null`: the target has no folder, or its folder
   * has no tokens yet. Absent: the host did not provide them; a command
   * that needs them then fails with `conflict` rather than guess. The
   * browser host passes the editor's live snapshot (FolderDocProvider), the
   * server host reads the folder document for the commands that declare
   * the flag (agent/folderTokens.ts).
   */
  folderTokens?: FolderTokensSnapshot | null
  /**
   * The font faces uploaded to that folder (family and weight), read-only —
   * for commands that resolve a family's cuts (`readsFolderFonts`, e.g. the
   * weight a text box snaps to when its family changes). Same states as
   * `folderTokens`: `null` = no folder or no uploaded fonts, absent = the
   * host did not provide them. The browser host passes the editor's folder
   * font list once loaded, the server host reads the folder's font assets
   * (agent/folderFonts.ts).
   */
  folderFonts?: ReadonlyArray<FontFaceWeight> | null
  /**
   * The style pack of that folder (agentic A4.4), read-only — for commands
   * that lay slides out with it (`readsStylePack`: `slide.applyLayout`,
   * `style.deck.apply`). `null`: no folder, or the folder has no pack;
   * absent: the host did not provide it. The browser host passes the
   * folder document's live pack, the server host reads it
   * (agent/folderStylePack.ts).
   */
  stylePack?: StylePack | null
  /**
   * Where atomic batches (`ops.apply`) get their fork of `deck.doc`: a
   * host that runs many batches on the same documents keeps one fork per
   * document in step with it (batchForks.ts; the server host). Absent:
   * each batch copies the document (the editor).
   */
  batchForks?: BatchForks
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

export interface CommandDef<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
  L = undefined,
> {
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
  /** Defaults to `deck`. See {@link CommandScope}. */
  scope?: CommandScope
  /**
   * `deck`-scoped commands only: the command also works on a component
   * master (target `{ componentId }` instead of `{ deckId }`). Document
   * commands do — a master is a document like a deck, which is how an agent
   * edits one — and so do the run commands (`agent.*`), so edits to a master
   * are listed and revertible. Commands that need an actual deck (sharing,
   * media, PowerPoint, deck CRUD, the user's open editors) do not, and the
   * host refuses a `componentId` for them before anything runs. Drives the
   * MCP tool's target arguments (only these tools offer `componentId`).
   * The registry keeps it consistent (registry.ts `commandTargetProblems`):
   * only deck-scoped commands may set it, and every pure document edit
   * (effects exactly `['doc']`) must; the contract suite runs every example
   * of every command that sets it against a component master too.
   */
  acceptsComponent?: true
  /**
   * `deck`-scoped server commands only: the command also works on a folder
   * (target `{ folderId }` instead of `{ deckId }`) — `media.delete` removes
   * a picture or video the folder itself owns. The host resolves the folder
   * role for it. A folder has no document, so a command that edits or reads
   * the target document cannot set it (registry.ts `commandTargetProblems`).
   * Drives the MCP tool's target arguments.
   */
  acceptsFolder?: true
  /**
   * The role needed on a target other than a deck, where it differs from
   * `role` (deck-scoped commands; `component` needs `acceptsComponent`,
   * `folder` needs `acceptsFolder`). `media.delete` deletes a deck's asset
   * for the deck's owner, but hands a master's picture to its folder for a
   * folder editor. See `requiredRole`.
   */
  roleOn?: { component?: Role; folder?: Role }
  /**
   * `folder`-scoped reads only: who may run the command besides a folder
   * MEMBER (folder_permissions, the default). `'content'`: also a guest of
   * one of the folder's decks, as a viewer — for what a folder shares with
   * every deck in it (its tokens, its fonts), which the editor already shows
   * such a guest (auth/permissions.ts `resolveFolderContentAccess`), so their
   * agent reads what they see. The service the command calls must check the
   * same reader itself (`requireFolderContentReader`) and write nothing — the
   * host trusts `readOnly`, and the role table in
   * commands/serverCommands.test.ts pins which commands set this. A share
   * link never counts: an agent always acts as a
   * signed-in user. The registry allows it only on read-only commands with
   * the viewer role (registry.ts `commandTargetProblems`).
   */
  folderReaders?: 'content'
  effects: readonly Effect[]
  /**
   * The handler reads the target document (to resolve slide/object refs)
   * although it does not write it — e.g. `editor.show`. The server host then
   * provides `ctx.deck` too. Implied for `doc` effects and for effect-free
   * commands (document queries); only commands with other effects set it.
   */
  readsDocument?: boolean
  /**
   * The handler reads the target folder's design tokens (`ctx.folderTokens`):
   * it resolves a colour token or applies a text style. The server host
   * loads them only for such commands (and for an `ops.apply` batch that
   * contains one — see `commandReadsFolderTokens`).
   */
  readsFolderTokens?: true
  /**
   * The handler reads the target folder's uploaded font faces
   * (`ctx.folderFonts`). Loaded like `readsFolderTokens` (see
   * `commandReadsFolderFonts`).
   */
  readsFolderFonts?: true
  /**
   * The handler reads the target folder's style pack (`ctx.stylePack`).
   * Loaded like `readsFolderTokens` (see `commandReadsStylePack`).
   */
  readsStylePack?: true
  /**
   * The command changes nothing anywhere: no document, no database row, no
   * file, no message to anyone — it only reads and returns (lists, gets,
   * queries, signed URLs). Drives MCP's `readOnlyHint`, so a client can run
   * it without asking the user. Declared explicitly rather than inferred,
   * because effects cannot tell a server read (`effects: ['server']`, e.g.
   * `deck.list`) from a server write (`deck.rename`). The registry refuses
   * inconsistent metadata (registry.ts `commandMetadataProblems`): a
   * read-only command has no document effect, `undo: 'n/a'` and
   * `confirm: 'never'`; an effect-free command and every `query.*` command
   * must declare it.
   */
  readOnly?: true
  /**
   * For writes: repeating the command with the same input succeeds again and
   * leaves the target exactly as the first call left it (set-to-value
   * commands such as renames, `text.set`, `slide.setBackground`; not
   * relative or additive ones such as `object.move` by dx/dy, `slide.add`,
   * or deletes, whose repeat fails with `not_found`). Drives MCP's
   * `idempotentHint`, which tells a client a retry after a lost response is
   * safe. Read-only commands are idempotent by definition and must not set
   * it.
   */
  idempotent?: true
  undo: UndoPolicy
  /**
   * A server command with `undo: 'undoable'` and no document effect: the
   * command that takes it back (see {@link UndoPolicy}). Required exactly
   * there (registry.ts `commandMetadataProblems`); the registry test checks
   * the named command exists.
   */
  undoneBy?: string
  confirm: ConfirmPolicy
  /**
   * Input-dependent confirmation (see {@link ConditionalConfirmation}):
   * called with the VALIDATED input, returns why this invocation needs the
   * user's confirmation, or null when it does not. Every command whose input
   * can make the server fetch a URL (the shared file source) must declare it
   * (registry.ts `commandConfirmationProblems`). A command with it never
   * runs inside a batch (`ops.apply` cannot stop to ask). Pure and
   * synchronous: no I/O, no document access.
   */
  confirmWhen?(input: z.output<I>): ConditionalConfirmation | null
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
  /**
   * Optional asynchronous phase that runs BEFORE the transaction opens —
   * e.g. `component.stamp` reads the component master through a server
   * service. Its result is passed to the handler, which then writes
   * synchronously inside one transaction, as every document handler must.
   * Commands with `load` cannot run in an atomic batch (a batch is
   * synchronous by design) and cannot be run with `runCommandSync`.
   */
  // Method syntax (not function-typed properties) on purpose: methods are
  // bivariant in their parameters, which is what lets a registry hold
  // commands of different input types as `AnyCommandDef`.
  load?(ctx: CommandContext, input: z.output<I>): Promise<L>
  /**
   * Undo what `load` staged outside the document (media copied for the
   * write, registered before the document is touched) when the handler will
   * never run: the host gave up between `load` and the write (a refused
   * run, a lost connection). The runner calls it through
   * `PreparedInvocation.abandon`. A handler that refuses before its first
   * write cleans up itself. Best effort: it must not throw.
   */
  release?(loaded: L): Promise<void>
  /**
   * Reconcile what `load` staged with the world AFTER the handler's write
   * has committed — e.g. `component.stamp` links media of the deck's folder
   * as it was at `load`; if the deck moved to another folder meanwhile, the
   * stamp's linked media is copied into it now. The runner calls it through
   * `PreparedInvocation.settle` once the handler returned (outside the
   * document transaction). Best effort: it must not throw.
   */
  settle?(loaded: L): Promise<void>
  handler(ctx: CommandContext, input: z.output<I>, loaded: L): z.input<O> | Promise<z.input<O>>
}

/** A command invocation as it travels over the wire (MCP, HTTP, batches). */
export interface CommandInvocation {
  command: string
  input: unknown
}
