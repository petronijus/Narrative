/**
 * routes/agent.ts — the HTTP doors into the ServerHost (ADR 0011).
 *
 * Paths are as Fastify registers them; the reverse proxy adds `/api` in
 * front (Caddy strips one `/api`), so `/commands` is public `/api/commands`.
 *
 *   POST /commands   (public: /api/commands)
 *     The command API for scripts: run one command, or a batch of document
 *     commands as one change. Auth: a personal access token with the `api`
 *     scope, or a signed-in browser session — which must then come from
 *     Narrative's own origin (`requireSameOrigin`, http/sameOrigin.ts:
 *     SameSite=Lax alone is not enough for a route that runs any command
 *     with the caller's role); per-token rate limit.
 *     API session (what runs belong to, and what `runId` may attach to):
 *     one per personal access token, and one per BROWSER SESSION — keyed by
 *     an opaque hash of the session id (`RequestAuth.sessionKey`), not by the
 *     user, so a run started in one browser session cannot be attached from
 *     another (security review L3).
 *     Body: `{ target, command, input }` or `{ target, ops: [{command, input}], atomic? }`
 *       target  `{ deckId }` | `{ componentId }` | `{ folderId }` | `{}` — what the
 *               command's scope needs (a deck command names its deck, …)
 *       runId?  attach to this open run (from agent.startRun)
 *       client? a short client name, shown in the Agent activity popover
 *       confirm? the ids of commands the user explicitly confirmed for this
 *               request, e.g. `"confirm": ["deck.delete"]`: irreversible ones
 *               (`confirm: 'always'`) and calls that download from a URL
 *               (`confirmWhen`: a `{ url }` file source, unless every host is
 *               on AGENT_URL_FETCH_ALLOWED_HOSTS). Such a command without its id
 *               here is refused with 428 `confirmation_required` and nothing
 *               runs; there is deliberately no blanket "confirm everything"
 *               flag. API clients are scripts the user runs deliberately, so
 *               the list is trusted as the user's confirmation — unlike an MCP
 *               model, which never gets to assert one (docs/mcp.md). The
 *               confirmation is logged with the op (agent_ops.confirmation).
 *     200 `{ ok: true, result, runId }`; failures `{ ok: false, error: { code,
 *     message, issues, opIndex? }, runId }` with the status of `code` (below).
 *     A batch is `ops.apply`: document commands only, atomic by default.
 *
 *   GET  /decks/:id/agent-runs            (Agent activity popover, deck editor)
 *   GET  /components/:id/agent-runs       (the same popover, component master editor)
 *   POST /agent-runs/:runId/revert         (the popover's Revert button)
 *     Browser-session routes for people; they run the `agent.runs` /
 *     `agent.revert` commands through the same host (editor role on the
 *     run's deck or component master), which is why those commands claim
 *     them in `routes`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CommandErrorCode, CommandInvocation, CommandTarget } from '@narrative/commands'
import { authPreHandler, requireTokenScope } from '../auth/fastifyAuth.js'
import { agentRouteRateLimit } from '../http/rateLimit.js'
import { requireSameOrigin } from '../http/sameOrigin.js'
import type { AgentRuntime } from '../agent/runtime.js'
import type { HostResult } from '../agent/serverHost.js'

/** HTTP status for each command error code (the codes are a public contract, errors.ts). */
export const COMMAND_ERROR_STATUS: Readonly<Record<CommandErrorCode, number>> = {
  invalid_input: 400,
  unknown_command: 400,
  no_target: 400,
  not_batchable: 400,
  wrong_host: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  // 428 Precondition Required: the request is fine, the user's confirmation is missing.
  confirmation_required: 428,
  // The user was asked and declined (an out-of-band confirmation; the command API itself never asks).
  not_confirmed: 403,
  failed: 500,
}

const MAX_OPS = 500
const MAX_CLIENT_NAME = 80
const MAX_CONFIRMED = 20
const COMMAND_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,3}$/

interface ParsedBody {
  target: CommandTarget
  invocation?: CommandInvocation
  batch?: { ops: CommandInvocation[]; atomic?: boolean }
  runId?: string
  clientName?: string
  /** Command ids of irreversible commands the user confirmed (the body's `confirm`). */
  confirm?: string[]
}

class BodyError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseTarget(raw: unknown): CommandTarget {
  if (raw === undefined) return {}
  if (!isRecord(raw)) throw new BodyError('`target` must be an object')
  const target: CommandTarget = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'deckId' && key !== 'componentId' && key !== 'folderId') {
      throw new BodyError(`unknown target key '${key}' (use deckId, componentId or folderId)`)
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new BodyError(`target.${key} must be a non-empty id`)
    }
    target[key] = value
  }
  return target
}

function parseInvocation(raw: unknown, where: string): CommandInvocation {
  if (!isRecord(raw)) throw new BodyError(`${where} must be an object`)
  const { command, input, ...rest } = raw
  if (Object.keys(rest).length > 0)
    throw new BodyError(`${where} has unknown keys: ${Object.keys(rest).join(', ')}`)
  if (typeof command !== 'string' || command.length === 0)
    throw new BodyError(`${where}.command must be a command id`)
  return { command, input: input ?? {} }
}

export function parseCommandBody(body: unknown): ParsedBody {
  if (!isRecord(body)) throw new BodyError('the body must be a JSON object')
  const { target, command, input, ops, atomic, runId, client, confirm, ...rest } = body
  if (Object.keys(rest).length > 0)
    throw new BodyError(`unknown keys: ${Object.keys(rest).join(', ')}`)
  const parsed: ParsedBody = { target: parseTarget(target) }
  if (runId !== undefined) {
    if (typeof runId !== 'string' || runId.length === 0 || runId.length > 64)
      throw new BodyError('`runId` must be a run id')
    parsed.runId = runId
  }
  if (client !== undefined) {
    if (
      typeof client !== 'string' ||
      client.trim().length === 0 ||
      client.length > MAX_CLIENT_NAME
    ) {
      throw new BodyError(`\`client\` must be a short name (at most ${MAX_CLIENT_NAME} characters)`)
    }
    parsed.clientName = client.trim()
  }
  if (confirm !== undefined) {
    if (
      !Array.isArray(confirm) ||
      confirm.length === 0 ||
      confirm.length > MAX_CONFIRMED ||
      !confirm.every((c): c is string => typeof c === 'string' && COMMAND_ID.test(c)) ||
      new Set(confirm).size !== confirm.length
    ) {
      throw new BodyError(
        `\`confirm\` must list 1 to ${MAX_CONFIRMED} distinct command ids the user confirmed, e.g. ["deck.delete"]`,
      )
    }
    parsed.confirm = confirm
  }
  if (ops !== undefined) {
    if (command !== undefined || input !== undefined)
      throw new BodyError('send either `command` or `ops`, not both')
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) {
      throw new BodyError(`\`ops\` must be a list of 1 to ${MAX_OPS} commands`)
    }
    if (atomic !== undefined && typeof atomic !== 'boolean')
      throw new BodyError('`atomic` must be true or false')
    parsed.batch = {
      ops: ops.map((op, i) => parseInvocation(op, `ops[${i}]`)),
      ...(atomic === undefined ? {} : { atomic }),
    }
    return parsed
  }
  if (atomic !== undefined) throw new BodyError('`atomic` only applies to `ops`')
  parsed.invocation = parseInvocation({ command, input }, 'the body')
  return parsed
}

function sendHostResult(reply: FastifyReply, outcome: HostResult): FastifyReply {
  if (outcome.ok)
    return reply.status(200).send({ ok: true, result: outcome.result, runId: outcome.runId })
  return reply
    .status(COMMAND_ERROR_STATUS[outcome.error.code] ?? 500)
    .send({ ok: false, error: outcome.error, runId: outcome.runId })
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply
    .status(400)
    .send({ ok: false, error: { code: 'invalid_input', message, issues: [] }, runId: null })
}

/**
 * One API session per credential: each token its own, each browser session
 * its own (never shared across a user's browsers or devices). Only
 * BYPASS_AUTH's dev-user, which has no session, shares one.
 */
export function apiSessionKey(req: FastifyRequest, userId: string): string {
  const auth = req.auth
  if (auth?.kind === 'token' && auth.tokenId !== null) return `api:${userId}:token:${auth.tokenId}`
  if (auth?.kind === 'session' && auth.sessionKey !== null)
    return `api:${userId}:session:${auth.sessionKey}`
  return `api:${userId}:dev`
}

export async function registerAgentRoutes(
  app: FastifyInstance,
  deps: { agent: AgentRuntime },
): Promise<void> {
  app.post(
    '/commands',
    {
      config: agentRouteRateLimit,
      preHandler: [requireSameOrigin, requireTokenScope('api', { allowSession: true })],
    },
    async (req, reply) => {
      const userId = req.user?.sub
      if (userId === undefined) return reply.status(401).send({ error: 'Unauthorized' })
      let body: ParsedBody
      try {
        body = parseCommandBody(req.body)
      } catch (e) {
        if (e instanceof BodyError) return badRequest(reply, e.message)
        throw e
      }
      const outcome = await deps.agent.host.execute({
        actor: { userId, kind: 'agent' },
        surface: 'api',
        sessionKey: apiSessionKey(req, userId),
        target: body.target,
        ...(body.invocation === undefined ? {} : { invocation: body.invocation }),
        ...(body.batch === undefined ? {} : { batch: body.batch }),
        ...(body.runId === undefined ? {} : { runId: body.runId }),
        ...(body.clientName === undefined ? {} : { clientName: body.clientName }),
        ...(body.confirm === undefined
          ? {}
          : { confirmation: { commands: body.confirm, via: 'explicit' as const } }),
      })
      return sendHostResult(reply, outcome)
    },
  )

  /**
   * The Agent activity list of one document: the deck editor's popover, and
   * the component master editor's (an agent edits a master through the same
   * document commands, so its runs are listed and reverted the same way).
   */
  const listRuns = async (
    req: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string } }>,
    reply: FastifyReply,
    target: CommandTarget,
  ): Promise<FastifyReply> => {
    const userId = req.user?.sub
    if (userId === undefined) return reply.status(401).send({ error: 'Unauthorized' })
    let limit: number | undefined
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit)
      if (!Number.isInteger(limit)) return badRequest(reply, '`limit` must be an integer')
    }
    const outcome = await deps.agent.host.execute({
      actor: { userId, kind: 'human' },
      surface: 'api',
      target,
      invocation: { command: 'agent.runs', input: limit === undefined ? {} : { limit } },
    })
    if (!outcome.ok) return sendHostResult(reply, outcome)
    return reply.status(200).send(outcome.result)
  }

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/decks/:id/agent-runs',
    { preHandler: [authPreHandler] },
    (req, reply) => listRuns(req, reply, { deckId: req.params.id }),
  )

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/components/:id/agent-runs',
    { preHandler: [authPreHandler] },
    (req, reply) => listRuns(req, reply, { componentId: req.params.id }),
  )

  app.post<{ Params: { runId: string }; Body: { lastOps?: unknown } | undefined }>(
    '/agent-runs/:runId/revert',
    { preHandler: [authPreHandler] },
    async (req, reply) => {
      const userId = req.user?.sub
      if (userId === undefined) return reply.status(401).send({ error: 'Unauthorized' })
      const lastOps = isRecord(req.body) ? req.body['lastOps'] : undefined
      // The run names its document (a deck or a component master);
      // authorisation is then the usual check on that document (editor role)
      // inside the host. A run of a document the caller cannot access
      // answers 403 rather than 404 — run ids are 16 random nanoid
      // characters handed out only to people with access to the document,
      // so that difference does not help anyone enumerate runs.
      const document = await deps.agent.runs.documentOfRun(req.params.runId)
      if (document === null) {
        return reply.status(404).send({
          ok: false,
          error: {
            code: 'not_found',
            message: `run '${req.params.runId}' does not exist`,
            issues: [],
          },
          runId: null,
        })
      }
      const outcome = await deps.agent.host.execute({
        actor: { userId, kind: 'human' },
        surface: 'api',
        target:
          document.kind === 'deck'
            ? { deckId: document.deckId }
            : { componentId: document.componentId },
        invocation: {
          command: 'agent.revert',
          input:
            lastOps === undefined
              ? { runId: req.params.runId }
              : { runId: req.params.runId, lastOps },
        },
      })
      if (!outcome.ok) return sendHostResult(reply, outcome)
      return reply.status(200).send(outcome.result)
    },
  )
}
