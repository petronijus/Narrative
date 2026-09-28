/**
 * agent/serverHost.ts — the ServerHost (plan §4.3, ADR 0011 point 2): the
 * ONE way commands execute on the server, for every agent surface (MCP,
 * the HTTP command API) and for the editor routes that are commands too
 * (the Agent activity popover).
 *
 * Order of an invocation — each step only runs when the previous succeeded:
 *   1. Look the command up (no side effects).
 *   2. AUTHORISE, per the command's scope, before anything touches a
 *      document: a Hocuspocus direct connection skips `onAuthenticate`, so a
 *      document opened before this check would be an IDOR.
 *        deck      → the user's role on the deck (share links never apply)
 *        component → the user's role on the master (its folder's owner)
 *        folder    → the user's role on the folder (its owner)
 *        user      → owner of their own account
 *      No access → `forbidden`, and nothing is opened. A role below the
 *      command's → `forbidden` too, still before any document is loaded.
 *      `ctx.actor.role` is the resolved role, so the runner's own role
 *      check sees the same thing (viewers can run read commands only).
 *   3. Resolve the run (agents only): the session's current run on the
 *      target, opened now if this is a write and there is none.
 *   4. For commands that use the document: take a lease on the live
 *      document (agent/documents.ts), build `ctx.deck` on it, and let the
 *      runner validate the input and await the command's async `load` phase
 *      (`prepareInvocation`) — all BEFORE any transaction opens.
 *   5. Writes: attach the run's undo history, then run the handler inside
 *      ONE `connection.transact(doc => …)`, in which ONE
 *      `doc.transact(fn, agentOrigin(runId))` wraps the whole command or
 *      batch (the runner opens it; the host opens the same origin around it
 *      so nothing inside can escape it). Editors receive exactly one
 *      update, attributed to the run. The lease is released in `finally`.
 *   6. Log the op to `agent_ops` (seq, command, input, target, result or
 *      error) — failures included — and move the agent's presence peer.
 * Errors come back as transport-neutral results (`code`, `message`,
 * `issues`, `opIndex`); transports map codes to their own status (see
 * routes/agent.ts for HTTP). An exception that is not a CommandError (a
 * database or storage failure) is reported as a generic `failed` with a
 * correlation id; the detail goes only to the server log under that id, so
 * internals never reach a client.
 *
 * Commands that need the user's explicit confirmation (ADR 0011 point 7)
 * — `confirm: 'always'` (sharing, invitations, deletes) and, for this input,
 * `confirmWhen` (a `{ url }` file source: the server would download from a
 * host the model chose) — are refused here, in the one host every transport
 * shares, unless the request carries a confirmation that covers them, so no
 * transport can forget the human in the loop:
 *   - `elicitation`: the MCP client showed Narrative's question in the same
 *     tool call and the user accepted it;
 *   - `out_of_band`: a server-issued confirmation id the user approved on
 *     Narrative's confirmation page (agent/confirmations.ts) — accepted only
 *     if approved, unexpired, unused and bound to the same session, user,
 *     command, canonical input hash and target; consumed on use;
 *   - `explicit`: the command API's `confirm: [<command ids>]` — scripts the
 *     user runs deliberately.
 * A model-settable flag is NOT a confirmation (there is none any more). A
 * URL download is exempt when every host it names is on the operator's
 * allowlist (`urlFetchAllowedHosts`, AGENT_URL_FETCH_ALLOWED_HOSTS); its
 * redirects must then stay on the allowlist (net/fetchAudit.ts). How an op
 * was confirmed is written next to it in `agent_ops.confirmation`, and every
 * host a command's downloads contacted in `agent_ops.fetched_hosts`.
 * `confirmationFor` answers, before anything runs, whether a call needs a
 * confirmation and what the user would be approving (the MCP layer asks the
 * user with it). Batches never contain such commands (run.ts `isBatchable`).
 */

import type { Document } from '@hocuspocus/server'
import {
  CommandError,
  ROLE_RANK,
  commandUsesDocument,
  prepareInvocation,
  type AgentSessionInfo,
  type AnyCommandDef,
  type CommandContext,
  type CommandErrorCode,
  type CommandInvocation,
  type CommandIssue,
  type CommandRegistry,
  type CommandScope,
  type CommandTarget,
  type ConditionalConfirmation,
  type Role,
  type ServerServices,
} from '@narrative/commands'
import {
  agentOrigin,
  getComponentDocName,
  hydrateSlideDoc,
  type DeckMutationContext,
} from '@narrative/slide-model'
import type { FastifyBaseLogger } from 'fastify'
import { randomUUID } from 'node:crypto'
import { runWithFetchAudit, type FetchAuditPolicy } from '../net/fetchAudit.js'
import type { AgentAccess } from './access.js'
import {
  buildConfirmationSummary,
  failSafeLookups,
  type ConfirmationLookups,
} from './confirmationSummary.js'
import {
  confirmationInputHash,
  type AgentConfirmations,
  type ConfirmationBinding,
  type ConfirmationReason,
  type ConfirmationSummary,
} from './confirmations.js'
import type { AgentDocuments } from './documents.js'
import type { OpConfirmation } from './runStore.js'
import { collectTouched, type Touched } from './touched.js'
import {
  isWriteCommand,
  type ActiveRun,
  type RunManager,
  type RunTarget,
} from '../services/runs.js'

type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

/**
 * Transaction origin for server-host invocations that belong to no run
 * (reads, and people using command routes). Such invocations never write a
 * document — the host refuses document writes without a run — so this
 * origin only ever labels read-only work.
 */
export const SERVER_READ_ORIGIN = Symbol('server-host-read')

/**
 * Origin of the one-off seeding of a never-opened, empty deck with its
 * default slide (what the editor does on first open). Kept out of the run
 * so reverting the run does not leave a deck with no slides.
 */
export const DECK_HYDRATION_ORIGIN = Symbol('deck-hydration')

/**
 * The user's explicit confirmation for ONE request (see the file header).
 *   `elicitation` / `explicit`: `commands` lists every command id the user
 *   agreed to (the MCP question just accepted, or the command API's
 *   `confirm` list); anything else that needs confirming is refused.
 *   `out_of_band`: the id of a confirmation the user approved on Narrative's
 *   confirmation page; it covers exactly the call it was created for.
 */
export type HostConfirmation =
  | { via: 'elicitation' | 'explicit'; commands: readonly string[] }
  | { via: 'out_of_band'; confirmationId: string }

/** `agent_ops.confirmation`: how a confirmed op was confirmed, by whom and why (agent/runStore.ts). */
export type OpConfirmationRecord = OpConfirmation

/** Where the host records how a confirmed op was confirmed (agent_ops.confirmation). */
export interface OpConfirmationAudit {
  recordConfirmation(runId: string, seq: number, confirmation: OpConfirmationRecord): Promise<void>
}

/** What a call needs confirmed, before it runs (`ServerHost.confirmationFor`). */
export interface ConfirmationRequirement {
  /** The exact call a confirmation must be bound to. */
  binding: ConfirmationBinding
  /** What the user would approve (titles looked up on the server). */
  summary: ConfirmationSummary
}

export type ConfirmationCheck =
  | { status: 'none' }
  | { status: 'required'; requirement: ConfirmationRequirement }
  | { status: 'error'; error: HostError }

export interface HostActor {
  userId: string
  /**
   * `agent` (default): an MCP session or API client — gets runs, op logging
   * and presence. `human`: a person using an editor route that is a
   * command (the Agent activity popover); no run, no document writes.
   */
  kind?: 'agent' | 'human'
}

export interface HostRequest {
  actor: HostActor
  surface: 'mcp' | 'api'
  /** Identifies the agent session (MCP session id, or `api:<user>:<token>`). */
  sessionKey?: string
  clientName?: string
  /** The credential the caller authenticated with (auth/agentSessions.ts credential keys). */
  credentialKey?: string
  /** Attach the invocation to this open run instead of the session's current one. */
  runId?: string
  /** Required for `confirm: 'always'` commands; see {@link HostConfirmation}. */
  confirmation?: HostConfirmation
  target: CommandTarget
  /** One command… */
  invocation?: CommandInvocation
  /** …or a batch, run as `ops.apply` (document commands only, one change). */
  batch?: { ops: CommandInvocation[]; atomic?: boolean }
}

export interface HostError {
  code: CommandErrorCode
  message: string
  issues: CommandIssue[]
  opIndex?: number
}

export type HostResult =
  | { ok: true; command: string; result: unknown; runId: string | null; seq: number | null }
  | { ok: false; command: string; error: HostError; runId: string | null; seq: number | null }

export interface ServerHostDeps {
  registry: CommandRegistry
  access: AgentAccess
  documents: AgentDocuments
  runs: RunManager
  services: ServerServices
  log: Log
  /** Records confirmations of irreversible ops; optional in tests. */
  audit?: OpConfirmationAudit
  /** Pending out-of-band confirmations (agent/confirmations.ts); without it `out_of_band` never verifies. */
  confirmations?: AgentConfirmations
  /** Database lookups for confirmation summaries; without them titles show as unknown. */
  confirmationLookups?: ConfirmationLookups
  /**
   * Hostnames (lower-case, no port) a URL download may contact without the
   * user confirming it (AGENT_URL_FETCH_ALLOWED_HOSTS; empty by default).
   */
  urlFetchAllowedHosts?: ReadonlySet<string>
}

/** Lookups that know nothing: summaries then name targets by id only. */
const NO_LOOKUPS: ConfirmationLookups = {
  deckTitle: async () => null,
  folderName: async () => null,
  componentName: async () => null,
  collaborator: async () => null,
  invite: async () => null,
  shareLink: async () => null,
  asset: async () => null,
  componentInFolder: async () => null,
  ownedFolder: async () => null,
  folderDeckCount: async () => 0,
}

/** What an invalid call "needs": nothing — it never runs. */
const NO_REQUIREMENT: CallRequirement = { reasons: [], conditional: null, fetchPolicy: {} }

/** Why one call needs confirming, after the host's URL allowlist is applied. */
interface CallRequirement {
  reasons: ConfirmationReason[]
  /** `confirmWhen`'s answer when it still applies (not exempted by the allowlist). */
  conditional: ConditionalConfirmation | null
  /** Set when a URL download runs unconfirmed because the allowlist exempts it. */
  fetchPolicy: FetchAuditPolicy
}

const TARGET_KEYS = ['deckId', 'componentId', 'folderId'] as const

/** Check the target has exactly the shape the command's scope needs. */
function targetFor(def: AnyCommandDef, raw: CommandTarget): CommandTarget {
  const scope: CommandScope = def.scope ?? 'deck'
  const present = TARGET_KEYS.filter((k) => typeof raw[k] === 'string' && raw[k] !== '')
  const describe = (): string => (present.length === 0 ? 'none' : present.join(', '))
  if (scope === 'deck') {
    const docKeys = present.filter((k) => k !== 'folderId')
    if (docKeys.length !== 1 || present.includes('folderId')) {
      throw new CommandError(
        'no_target',
        `this command acts on a deck: name exactly one deckId (or componentId for a component master); got ${describe()}`,
      )
    }
    if (raw.deckId !== undefined) return { deckId: raw.deckId }
    // Refused here, before any access check or document load, with the
    // reason — not deep inside the handler as a generic "name the deck".
    if (def.acceptsComponent !== true) {
      throw new CommandError(
        'no_target',
        `'${def.id}' works on decks only, not on a component master; name the deck (deckId)`,
      )
    }
    return { componentId: raw.componentId! }
  }
  if (scope === 'folder') {
    if (present.length !== 1 || present[0] !== 'folderId') {
      throw new CommandError(
        'no_target',
        `this command acts on a folder: name its folderId; got ${describe()}`,
      )
    }
    return { folderId: raw.folderId! }
  }
  if (present.length > 0) {
    throw new CommandError(
      'no_target',
      `this command acts on your account and takes no deck, component or folder; got ${describe()}`,
    )
  }
  return {}
}

function runTargetOf(target: CommandTarget): RunTarget {
  if (target.deckId !== undefined) return { kind: 'deck', deckId: target.deckId }
  if (target.componentId !== undefined)
    return { kind: 'component', componentId: target.componentId }
  return { kind: 'account' }
}

function documentNameOf(target: CommandTarget): string | null {
  if (target.deckId !== undefined) return target.deckId
  if (target.componentId !== undefined) return getComponentDocName(target.componentId)
  return null
}

/**
 * A client-safe CommandError. CommandErrors carry messages written for the
 * caller and pass through — except a `failed` that merely wraps another
 * exception (the runner does that for handler crashes inside a batch).
 * Anything else becomes a generic `failed` naming a correlation id, which
 * the caller logs together with the real exception.
 */
function toClientError(e: unknown): { error: CommandError; correlationId: string | null } {
  const internal = !(e instanceof CommandError)
    ? true
    : e.code === 'failed' && e.cause !== undefined && !(e.cause instanceof CommandError)
  if (!internal) return { error: e as CommandError, correlationId: null }
  const correlationId = randomUUID()
  const opIndex = e instanceof CommandError ? e.opIndex : undefined
  const message =
    `${opIndex === undefined ? '' : `op ${opIndex}: `}the server failed to run this command ` +
    `(internal error, reference ${correlationId}); it may be temporary — try again, and report the ` +
    'reference if it persists'
  return {
    error: new CommandError('failed', message, {
      cause: e,
      ...(opIndex === undefined ? {} : { opIndex }),
    }),
    correlationId,
  }
}

function hostError(e: CommandError): HostError {
  return {
    code: e.code,
    message: e.message,
    issues: [...e.issues],
    ...(e.opIndex === undefined ? {} : { opIndex: e.opIndex }),
  }
}

/** The hostname of a `URL#host` value (lower-case, port dropped); null when it does not parse. */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The agent session a request belongs to (what runs and confirmations are bound to). */
function sessionKeyFor(req: HostRequest, userId: string): string {
  return req.sessionKey ?? `${req.surface}:${userId}`
}

function writesDocument(def: AnyCommandDef): boolean {
  return def.effects.includes('doc') || def.transaction === 'self'
}

export class ServerHost {
  constructor(private readonly deps: ServerHostDeps) {}

  /** The role the user has on the target, per scope; null = no access. */
  private async authorise(
    scope: CommandScope,
    target: CommandTarget,
    userId: string,
  ): Promise<Role | null> {
    const { access } = this.deps
    if (scope === 'user') return 'owner'
    if (scope === 'folder') return access.folderRole(target.folderId!, userId)
    if (target.componentId !== undefined) return access.componentRole(target.componentId, userId)
    return access.deckRole(target.deckId!, userId)
  }

  /**
   * Look the command up, shape the target and authorise the user — steps 1
   * and 2 of `execute`, shared with `confirmationFor`. Throws CommandError.
   */
  private async admit(
    commandId: string,
    rawTarget: CommandTarget,
    userId: string,
  ): Promise<{ def: AnyCommandDef; target: CommandTarget; role: Role }> {
    const def = this.deps.registry.get(commandId)
    if (def === undefined) {
      throw new CommandError('unknown_command', `unknown command '${commandId}'`)
    }
    const scope = def.scope ?? 'deck'
    const target = targetFor(def, rawTarget)
    const role = await this.authorise(scope, target, userId)
    if (role === null) {
      throw new CommandError(
        'forbidden',
        'you do not have access to this target (or it does not exist)',
      )
    }
    if (ROLE_RANK[role] < ROLE_RANK[def.role]) {
      throw new CommandError(
        'forbidden',
        `command '${commandId}' needs the ${def.role} role; you are ${role}`,
      )
    }
    return { def, target, role }
  }

  /**
   * Why this call needs the user's confirmation: `confirm: 'always'` and
   * `confirmWhen` evaluated on the validated input; a URL download whose
   * every host is on the allowlist is exempt, and its redirects are then
   * held to the allowlist. Null when the input is invalid — such a call can
   * never run (the runner refuses it with `invalid_input`), so there is
   * nothing to confirm, and it must never be put to the user.
   */
  private requirementOf(def: AnyCommandDef, input: unknown): CallRequirement | null {
    const parsed = def.input.safeParse(input)
    if (!parsed.success) return null
    const reasons: ConfirmationReason[] = def.confirm === 'always' ? ['irreversible'] : []
    let conditional = def.confirmWhen?.(parsed.data) ?? null
    let fetchPolicy: FetchAuditPolicy = {}
    if (conditional !== null && conditional.kind === 'url_fetch') {
      const allowed = this.deps.urlFetchAllowedHosts ?? new Set<string>()
      const hostnames = conditional.hosts.map(hostnameOf)
      if (allowed.size > 0 && hostnames.every((h): h is string => h !== null && allowed.has(h))) {
        conditional = null
        fetchPolicy = { restrictToHostnames: allowed }
      }
    }
    if (conditional !== null) reasons.push(conditional.kind)
    return { reasons, conditional, fetchPolicy }
  }

  /**
   * Before anything runs: does this call need the user's confirmation, and
   * what exactly would they approve? Looks up and authorises like `execute`
   * (a call the user may not make is an error here too, so no confirmation
   * is ever offered for it), validates the input, and builds the summary from
   * the server's own records. Writes nothing and logs no op.
   */
  async confirmationFor(req: {
    actor: HostActor
    surface: 'mcp' | 'api'
    sessionKey?: string
    clientName?: string
    target: CommandTarget
    invocation: CommandInvocation
  }): Promise<ConfirmationCheck> {
    const userId = req.actor.userId
    try {
      const { def, target } = await this.admit(req.invocation.command, req.target, userId)
      const requirement = this.requirementOf(def, req.invocation.input)
      if (requirement === null) {
        // Report it as the runner would; `execute` then logs the refusal.
        const parsed = def.input.safeParse(req.invocation.input)
        throw new CommandError('invalid_input', `invalid input for '${def.id}'`, {
          issues: parsed.success
            ? []
            : parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        })
      }
      if (requirement.reasons.length === 0) return { status: 'none' }
      const summary = await buildConfirmationSummary({
        def,
        target,
        input: req.invocation.input,
        userId,
        reasons: requirement.reasons,
        conditional: requirement.conditional,
        clientName: req.clientName ?? null,
        lookups: failSafeLookups(this.deps.confirmationLookups ?? NO_LOOKUPS, (lookup, err) =>
          this.deps.log.error({ lookup, err }, 'agent host: confirmation summary lookup failed'),
        ),
      })
      return {
        status: 'required',
        requirement: {
          binding: {
            userId,
            sessionKey: sessionKeyFor(req, userId),
            commandId: def.id,
            inputHash: confirmationInputHash(req.invocation.input),
            target,
          },
          summary,
        },
      }
    } catch (e) {
      const { error, correlationId } = toClientError(e)
      if (error.code === 'failed')
        this.deps.log.error(
          { command: req.invocation.command, user: userId, err: e, correlationId },
          'agent host: confirmation check failed',
        )
      return { status: 'error', error: hostError(error) }
    }
  }

  /**
   * Check that `confirmation` covers a call with `requirement`; throws the
   * refusal otherwise. Consumes an out-of-band confirmation (single use).
   * Returns what the audit log records about it.
   */
  private verifyConfirmation(
    def: AnyCommandDef,
    requirement: CallRequirement,
    confirmation: HostConfirmation | undefined,
    binding: ConfirmationBinding,
  ): { confirmationId?: string; approvedAt?: string } {
    const what =
      requirement.reasons.includes('irreversible') && requirement.conditional !== null
        ? `'${def.id}' is irreversible and downloads from ${requirement.conditional.hosts.join(', ')}`
        : requirement.conditional !== null
          ? `'${def.id}' would download from ${requirement.conditional.hosts.join(', ')}`
          : `'${def.id}' is irreversible`
    if (confirmation === undefined) {
      throw new CommandError(
        'confirmation_required',
        `${what}; it runs only with the user's explicit confirmation of this call. Nothing was done.`,
      )
    }
    if (confirmation.via !== 'out_of_band') {
      if (confirmation.commands.includes(def.id)) return {}
      throw new CommandError(
        'confirmation_required',
        `${what}; the confirmation of this request does not name '${def.id}'. Nothing was done.`,
      )
    }
    const confirmations = this.deps.confirmations
    const used = confirmations?.consume(confirmation.confirmationId, binding)
    if (used === undefined) {
      throw new CommandError(
        'confirmation_required',
        `${what}; this server cannot verify confirmation ids. Nothing was done.`,
      )
    }
    if (used.ok) {
      return {
        confirmationId: used.record.id,
        ...(used.record.decidedAt === null
          ? {}
          : { approvedAt: used.record.decidedAt.toISOString() }),
      }
    }
    if (used.state === 'declined') {
      throw new CommandError(
        'not_confirmed',
        `the user declined "${def.title}" on Narrative's confirmation page. Nothing was done; do not retry ` +
          'or work around it — tell the user it was not done and ask how they want to proceed.',
      )
    }
    if (used.state === 'pending') {
      throw new CommandError(
        'confirmation_required',
        `${what}; the user has not approved it yet. Ask them to open the confirmation link and approve it, ` +
          'then call again with the same arguments and confirmationId. Nothing was done.',
      )
    }
    const why =
      used.why === 'mismatch'
        ? 'was issued for a different call (the command, its arguments or the target differ)'
        : used.why === 'expired'
          ? 'has expired'
          : used.why === 'used'
            ? 'has already been used'
            : 'is not valid for this session'
    throw new CommandError(
      'confirmation_required',
      `${what}; the confirmationId ${why}. Nothing was done.`,
    )
  }

  async execute(req: HostRequest): Promise<HostResult> {
    const commandId = req.batch !== undefined ? 'ops.apply' : (req.invocation?.command ?? '')
    const input =
      req.batch !== undefined
        ? {
            ops: req.batch.ops,
            ...(req.batch.atomic === undefined ? {} : { atomic: req.batch.atomic }),
          }
        : req.invocation?.input
    const kind = req.actor.kind ?? 'agent'
    const userId = req.actor.userId
    const session: AgentSessionInfo | undefined =
      kind === 'agent'
        ? {
            key: req.sessionKey ?? `${req.surface}:${userId}`,
            surface: req.surface,
            ...(req.clientName === undefined ? {} : { clientName: req.clientName }),
            ...(req.credentialKey === undefined ? {} : { credential: req.credentialKey }),
          }
        : undefined

    let target: CommandTarget = {}
    let runTarget: RunTarget | undefined
    let run: ActiveRun | undefined
    /** Set once a call that needed confirming passed the check; recorded with its op. */
    let confirmed: OpConfirmationRecord | undefined
    /** Hosts the command's downloads contacted (agent_ops.fetched_hosts). */
    let fetchedHosts: readonly string[] = []
    const auditConfirmation = async (runId: string, seq: number): Promise<void> => {
      if (confirmed === undefined || this.deps.audit === undefined) return
      try {
        await this.deps.audit.recordConfirmation(runId, seq, confirmed)
      } catch (err) {
        this.deps.log.error({ runId, seq, err }, 'agent host: recording a confirmation failed')
      }
    }

    const logRun = (): ActiveRun | undefined => {
      if (session === undefined || runTarget === undefined) return run
      // After agent.startRun the session's current run is the new one; after
      // a revert of the current run it is none, and the op belongs to the
      // run it was issued in.
      return this.deps.runs.currentRun(session, runTarget) ?? run
    }

    try {
      // 1. Look up.
      const def = this.deps.registry.get(commandId)
      if (def === undefined) {
        throw new CommandError('unknown_command', `unknown command '${commandId}'`)
      }
      target = targetFor(def, req.target)
      // Known from here on, so a refused op is still logged in the session's
      // current run on this target (if it has one; a refusal never opens one).
      runTarget = runTargetOf(target)

      // 2. Authorise — before any document is opened.
      const { role } = await this.admit(commandId, target, userId)

      // 2b. The user's confirmation, when this call needs one.
      // Invalid input: nothing to confirm — the runner refuses it below, after
      // the run is resolved, so the refusal is logged like any other.
      const requirement = this.requirementOf(def, input) ?? NO_REQUIREMENT
      if (requirement.reasons.length > 0) {
        const proof = this.verifyConfirmation(def, requirement, req.confirmation, {
          userId,
          sessionKey: sessionKeyFor(req, userId),
          commandId,
          inputHash: confirmationInputHash(input),
          target,
        })
        confirmed = {
          via: req.confirmation!.via,
          by: userId,
          surface: req.surface,
          at: new Date().toISOString(),
          reasons: [...requirement.reasons],
          ...(requirement.conditional === null
            ? {}
            : { hosts: [...requirement.conditional.hosts] }),
          ...proof,
        }
      }

      // 3. The run (agents only).
      if (session !== undefined) {
        run = await this.deps.runs.runFor({
          userId,
          session,
          target: runTargetOf(target),
          write: isWriteCommand(def),
          ...(req.runId === undefined ? {} : { runId: req.runId }),
        })
      }

      const ctx: CommandContext = {
        actor: { userId, role, kind },
        host: 'server',
        target,
        services: this.deps.services,
        origin: run === undefined ? SERVER_READ_ORIGIN : agentOrigin(run.id),
        ...(run === undefined ? {} : { run: { runId: run.id, surface: req.surface } }),
        ...(session === undefined ? {} : { session }),
      }

      // 4–5. Execute, recording every host a download contacts.
      const result = await runWithFetchAudit(
        requirement.fetchPolicy,
        () => this.run(def, ctx, commandId, input, target, run),
        (hosts) => {
          fetchedHosts = hosts
        },
      )

      // 6. Log.
      const into = logRun()
      let seq: number | null = null
      if (into !== undefined) {
        seq = await this.deps.runs.recordOp(into, {
          command: commandId,
          input,
          target: { ...target },
          result,
          ...(fetchedHosts.length > 0 ? { fetchedHosts: [...fetchedHosts] } : {}),
        })
        await auditConfirmation(into.id, seq)
        await this.deps.runs.touch(into)
      }
      return { ok: true, command: commandId, result, runId: into?.id ?? null, seq }
    } catch (e) {
      const { error, correlationId } = toClientError(e)
      if (error.code === 'failed') {
        this.deps.log.error(
          { command: commandId, user: userId, err: e, correlationId },
          'agent host: command failed',
        )
      }
      const into = logRun()
      let seq: number | null = null
      if (into !== undefined) {
        seq = await this.deps.runs.recordOp(into, {
          command: commandId,
          input,
          target: { ...target },
          error: hostError(error),
          ...(fetchedHosts.length > 0 ? { fetchedHosts: [...fetchedHosts] } : {}),
        })
        await auditConfirmation(into.id, seq)
        await this.deps.runs.touch(into)
      }
      return {
        ok: false,
        command: commandId,
        error: hostError(error),
        runId: into?.id ?? null,
        seq,
      }
    }
  }

  private async run(
    def: AnyCommandDef,
    ctx: CommandContext,
    commandId: string,
    input: unknown,
    target: CommandTarget,
    run: ActiveRun | undefined,
  ): Promise<unknown> {
    const documentName = documentNameOf(target)
    if (documentName === null || !commandUsesDocument(def)) {
      const prepared = await prepareInvocation(this.deps.registry, ctx, commandId, input)
      return prepared.execute()
    }

    const write = writesDocument(def)
    if (write && run === undefined) {
      // Every document write is attributed to a run; people write documents
      // in the editor (BrowserHost), not through command routes.
      throw new CommandError(
        'wrong_host',
        `command '${commandId}' writes the document; it runs in the editor`,
      )
    }

    const lease = await this.deps.documents.acquire(documentName)
    try {
      const document = lease.document
      const deck: DeckMutationContext = { doc: document, slides: document.getArray('slides') }
      const docCtx: CommandContext = { ...ctx, deck }
      // Validation and the async `load` phase happen here, before any transaction.
      const prepared = await prepareInvocation(this.deps.registry, docCtx, commandId, input)
      if (!prepared.synchronous) return await prepared.execute()

      const activeRun = run!
      await this.deps.runs.beforeDocumentWrite(activeRun, lease)
      let output: unknown
      let touched: Touched | null = null
      try {
        await lease.transact((doc: Document) => {
          if (target.deckId !== undefined && doc.getArray('slides').length === 0) {
            // A deck nobody has opened yet has no slides; the editor would
            // seed one on first open. Do the same, outside the run.
            doc.transact(() => hydrateSlideDoc(doc), DECK_HYDRATION_ORIGIN)
          }
          touched = collectTouched(doc.getArray('slides'), () => {
            doc.transact(() => {
              output = prepared.execute()
            }, ctx.origin)
          })
        })
      } finally {
        // Always close the op's undo step — also when the handler threw —
        // so the next op never merges into this one.
        this.deps.runs.afterDocumentWrite(activeRun, document, touched)
      }
      return output
    } finally {
      lease.release()
    }
  }

  /** The agent session ended (MCP session closed): close its runs and drop its pending confirmations. */
  endSession(sessionKey: string): Promise<void> {
    this.deps.confirmations?.forgetSession(sessionKey)
    return this.deps.runs.endSession(sessionKey)
  }
}
