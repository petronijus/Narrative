/**
 * commands/src/commands/agent.ts — agent runs: the unit of attribution and
 * of revert for everything an agent changes (plan §6, ADR 0011).
 *
 * A run is one agent session's work on one document — a deck or a component
 * master. The server host opens one implicitly on the session's first write
 * to a document and splits it after 10
 * minutes of inactivity; `agent.startRun` opens one explicitly per user
 * request, so "undo what you just did" maps to exactly that request.
 * `agent.revert` is the safety net: it undoes a run's document changes and
 * keeps everything people edited in the meantime.
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import { requireServices } from '../services.js'
import type { RunDocument } from '../services/runs.js'
import type { CommandContext } from '../types.js'

const agentCommand = {
  domain: 'agent',
  scope: 'deck',
  effects: ['server'],
  confirm: 'never',
  acceptsComponent: true,
  hosts: ['server'],
  implementedWith: [],
} as const

const RunIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe('Run id, as returned by agent.startRun or listed by agent.runs')

const RunStatusSchema = z.enum(['open', 'closed', 'reverted'])

const RunSummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string().nullable(),
  surface: z.enum(['mcp', 'api']),
  clientName: z.string().nullable(),
  request: z.string().nullable(),
  status: RunStatusSchema,
  createdAt: z.string(),
  lastActivityAt: z.string(),
  revertedAt: z.string().nullable(),
  revertedBy: z.string().nullable(),
  opCount: z.number().int().min(0),
  changeCount: z.number().int().min(0),
  revertibleChanges: z.number().int().min(0),
  revertible: z.boolean(),
  notRevertibleReason: z
    .enum(['reverted', 'nothing_to_revert', 'unloaded', 'expired', 'not_document'])
    .nullable(),
})

/**
 * The document a run command acts on: the deck, or the component master the
 * host resolved (runs work on either — an agent edits a master through the
 * same document commands, and those edits must be revertible too).
 */
function runDocumentOf(ctx: CommandContext, commandId: string): RunDocument {
  const { deckId, componentId } = ctx.target ?? {}
  if (deckId !== undefined) return { kind: 'deck', deckId }
  if (componentId !== undefined) return { kind: 'component', componentId }
  throw new CommandError(
    'no_target',
    `${commandId} works on a deck or a component master: name it (deckId or componentId)`,
  )
}

export const agentStartRun = defineCommand({
  ...agentCommand,
  id: 'agent.startRun',
  title: 'Start an agent run',
  description:
    "Start a new run on this deck (or component master) for the user's current request, and return its runId. " +
    'Call it once at the start of every new user request that will change the document ("make slide 3 ' +
    'shorter", "restyle the deck"), ' +
    'before the first edit, with the request in a short sentence. Everything you change afterwards belongs to ' +
    'this run, is listed under it in the Agent activity popover the user sees in the editor (deck or master), ' +
    'and can be undone ' +
    'as one unit with agent.revert — so one run per request is what makes "undo that" precise. ' +
    'Without it your edits still land in an automatic run per session and document (split after 10 minutes ' +
    'of inactivity), which lumps separate requests together. Starting a run closes your previous run on the ' +
    'same deck or master; it changes nothing in the document.',
  input: z
    .object({
      request: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("The user's request in one short sentence, as the user would recognise it"),
    })
    .strict(),
  output: z.object({ runId: z.string() }),
  role: 'editor',
  undo: 'n/a',
  examples: [
    {
      title: 'Start a run before shortening a slide',
      input: { request: 'Shorten slide 3 to three bullets' },
    },
  ],
  async handler(ctx, input) {
    const target = runDocumentOf(ctx, 'agent.startRun')
    if (ctx.session === undefined) {
      throw new CommandError(
        'wrong_host',
        'agent.startRun is only available to agent sessions (MCP or the API)',
      )
    }
    return requireServices(ctx).runs.startRun({
      userId: ctx.actor.userId,
      session: ctx.session,
      target,
      request: input.request,
    })
  },
})

export const agentRuns = defineCommand({
  ...agentCommand,
  id: 'agent.runs',
  title: 'List agent runs',
  description:
    'List the recent agent runs on this deck (or component master), newest first: who asked, the request, when, how many commands ' +
    'ran and how many of them changed something, the status (open, closed, reverted) and whether the run can ' +
    'still be reverted (with the reason when it cannot). Covers runs of every agent session and user on the ' +
    'document, not just yours. Use it to find the runId to pass to agent.revert, or to tell the user what ' +
    'agents did to it. Read-only.',
  input: z
    .object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('How many runs to return (default 10)'),
    })
    .strict(),
  output: z.object({ runs: z.array(RunSummarySchema) }),
  role: 'editor',
  readOnly: true,
  undo: 'n/a',
  routes: [
    { method: 'GET', path: '/decks/:id/agent-runs' },
    { method: 'GET', path: '/components/:id/agent-runs' },
  ],
  examples: [
    { title: 'The ten most recent runs', input: {} },
    { title: 'Just the last three runs', input: { limit: 3 } },
  ],
  async handler(ctx, input) {
    const target = runDocumentOf(ctx, 'agent.runs')
    const runs = await requireServices(ctx).runs.listRuns({
      userId: ctx.actor.userId,
      target,
      limit: input.limit ?? 10,
    })
    return { runs }
  },
})

export const agentRevert = defineCommand({
  ...agentCommand,
  id: 'agent.revert',
  title: 'Revert an agent run',
  description:
    "Undo an agent run's changes to this deck (or component master): the whole run, or only its last N changes (`lastOps`). Only " +
    "that run's changes are undone — edits people (or other runs) made in the meantime stay, although an " +
    'object the run created disappears together with anything added to it. Use it when the user asks to ' +
    'undo what you did; find the runId with agent.runs (or keep the one agent.startRun returned). It is the ' +
    'safety net, so it never asks for confirmation. It only works while the deck or master is loaded on the server ' +
    '(someone has it open, or a run on it is active): once the document unloads, or after a server restart, ' +
    'the run reports it is no longer revertible and the changes have to be undone by editing. Deck renames, ' +
    'sharing and other server-side actions of the run are not undone — only document edits.',
  input: z
    .object({
      runId: RunIdSchema,
      lastOps: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe(
          "Undo only the run's last N changes (commands that changed the deck); omit to undo the whole run",
        ),
    })
    .strict(),
  output: z.object({
    runId: z.string(),
    revertedChanges: z.number().int().min(0),
    remainingChanges: z.number().int().min(0),
    status: RunStatusSchema,
  }),
  role: 'editor',
  undo: 'n/a',
  routes: [{ method: 'POST', path: '/agent-runs/:runId/revert' }],
  examples: [
    { title: 'Undo a whole run', input: { runId: 'run_fixture' } },
    { title: 'Undo only the last change of a run', input: { runId: 'run_fixture', lastOps: 1 } },
  ],
  async handler(ctx, input) {
    const target = runDocumentOf(ctx, 'agent.revert')
    return requireServices(ctx).runs.revertRun({
      userId: ctx.actor.userId,
      target,
      runId: input.runId,
      ...(input.lastOps === undefined ? {} : { lastOps: input.lastOps }),
    })
  },
})

export const agentCommands = [agentStartRun, agentRuns, agentRevert]
