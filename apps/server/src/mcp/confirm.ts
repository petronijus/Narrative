/**
 * mcp/confirm.ts — the human in the loop for tool calls that need the user's
 * explicit confirmation: irreversible commands (`confirm: 'always'`:
 * sharing, invitations, deleting a deck, folder, font or media) and calls
 * whose input needs it (`confirmWhen`: a `{ url }` file source makes the
 * server download from a host the model chose). ADR 0011 point 7.
 *
 * What the user sees is built on the server from the exact call
 * (agent/confirmationSummary.ts): the action, the deck / folder title, the
 * recipient and role, the download host — one fact per line. The model's
 * own words never reach the question.
 *
 * Three ways to ask, in order of preference:
 *
 *   1. Form elicitation (client declared `elicitation` / `elicitation.form`):
 *      `elicitation/create` on the tool call's own stream with one required
 *      yes/no field. Only `accept` with the box ticked runs the command;
 *      `decline` or an unticked box refuse, and nothing runs. `cancel` (the
 *      question dismissed without an answer), a timeout (5 min) or a failed
 *      request fall back to path 3: nothing runs, and the user may still
 *      approve on the page. Headless Claude Code (`claude -p`) declares form
 *      elicitation but has no one to ask: earlier versions cancelled at once;
 *      2.1.288 leaves the question open until the timeout (measured
 *      2026-10-03), unless an `Elicitation` hook answers it (the agent eval's
 *      does, tests/agent-eval/lib/claude.ts).
 *   2. URL-mode elicitation (client declared `elicitation.url`, MCP
 *      2025-11-25): a pending confirmation is created (agent/confirmations.ts)
 *      and the client is sent its Narrative page with `elicitation/create`
 *      `mode: 'url'`. The tool call stays open until the user approves or
 *      declines on the page (or it expires); then `notifications/elicitation/
 *      complete` is sent and the command runs — no retry needed.
 *   3. Out of band (a client that can do neither — the model cannot answer
 *      for the user): a pending confirmation is created and the call fails
 *      with `confirmation_required`, carrying the page URL and the
 *      confirmation id. The user opens the page in their signed-in browser
 *      and decides; the model retries with the same arguments plus the
 *      server-issued `confirmationId`, which the server host accepts only if
 *      approved, unexpired, unused and bound to this session, user, command,
 *      input and target.
 *
 * There is no model-settable "confirmed" flag on any path. A call that
 * arrives WITH a `confirmationId` is checked first: approved → it runs;
 * still pending → the same link again (or, with URL mode, the wait resumes);
 * declined → refused; anything else (expired, used, for another call) → a
 * fresh confirmation.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { ClientCapabilities, RequestId } from '@modelcontextprotocol/sdk/types.js'
import type { AnyCommandDef } from '@narrative/commands'
import { toolNameForCommand } from '@narrative/commands'
import { summaryLines } from '../agent/confirmationSummary.js'
import type { AgentConfirmations, ConfirmationRecord } from '../agent/confirmations.js'
import type { ConfirmationRequirement, HostConfirmation } from '../agent/serverHost.js'
import type { ToolErrorBody } from './results.js'

/** How long a form confirmation question waits for the user. */
export const CONFIRMATION_TIMEOUT_MS = 5 * 60_000

/** Which elicitation modes the client declared at initialize. */
export interface ElicitationSupport {
  form: boolean
  url: boolean
}

export function clientElicitation(
  capabilities: ClientCapabilities | undefined,
): ElicitationSupport {
  const elicitation = capabilities?.elicitation as Record<string, unknown> | undefined
  if (elicitation === undefined || elicitation === null || typeof elicitation !== 'object')
    return { form: false, url: false }
  // Protocol 2025-06-18 declared form elicitation as `elicitation: {}`; the
  // SDK normalises that to `{ form: {} }`, but accept both.
  const empty = Object.keys(elicitation).length === 0
  return { form: empty || elicitation['form'] !== undefined, url: elicitation['url'] !== undefined }
}

/** The question shown to the user: every fact on its own line. */
export function confirmationMessage(requirement: ConfirmationRequirement): string {
  const { summary } = requirement
  const client = summary.clientName ?? 'Claude'
  return [
    `${client} wants to do this in Narrative:`,
    '',
    ...summaryLines(summary),
    '',
    summary.action,
    '',
    'Allow it?',
  ].join('\n')
}

export type ConfirmationOutcome =
  | { ok: true; confirmation: HostConfirmation }
  | { ok: false; error: ToolErrorBody }

export interface ConfirmRequest {
  server: Server
  support: ElicitationSupport
  def: AnyCommandDef
  requirement: ConfirmationRequirement
  confirmations: AgentConfirmations
  /** The Narrative page of a confirmation (`<SPA>/confirm/<id>`). */
  confirmUrl: (id: string) => string
  /** A server-issued id the model passed back (`confirmationId`), if any. */
  confirmationId?: string
  relatedRequestId: RequestId
  signal: AbortSignal
  timeoutMs?: number
}

function declined(def: AnyCommandDef, how: string): ConfirmationOutcome {
  return {
    ok: false,
    error: {
      code: 'not_confirmed',
      message:
        `The user ${how} "${def.title}". Nothing was done. Do not retry or work around it; ` +
        'tell the user it was not done and ask how they want to proceed.',
    },
  }
}

/** `confirmation_required` with the page link: the out-of-band path, for the model to relay. */
function linkError(
  req: ConfirmRequest,
  record: ConfirmationRecord,
  preface: string | null,
): ConfirmationOutcome {
  const tool = toolNameForCommand(req.def.id)
  const url = req.confirmUrl(record.id)
  return {
    ok: false,
    error: {
      code: 'confirmation_required',
      message: [
        ...(preface === null ? [] : [preface]),
        `${tool} needs the user's confirmation, and this client cannot show Narrative's confirmation ` +
          'dialog. Nothing was done.',
        'Tell the user what it would do:',
        ...summaryLines(record.summary).map((line) => `  ${line}`),
        `Then give them this link to approve or decline it in Narrative (signed in, valid for 5 minutes): ${url}`,
        `Only after they say they approved it, call ${tool} again with exactly the same arguments plus ` +
          `"confirmationId": "${record.id}". You cannot approve it yourself, and changed arguments need a new ` +
          'confirmation.',
      ].join('\n'),
      confirmation: {
        confirmationId: record.id,
        url,
        expiresAt: record.expiresAt.toISOString(),
      },
    },
  }
}

async function askWithForm(req: ConfirmRequest): Promise<ConfirmationOutcome> {
  const tool = toolNameForCommand(req.def.id)
  let result
  try {
    result = await req.server.elicitInput(
      {
        mode: 'form',
        message: confirmationMessage(req.requirement),
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: `Yes, ${req.def.title.toLowerCase()}`,
              description: 'Tick to allow exactly what is listed above.',
              default: false,
            },
          },
          required: ['confirm'],
        },
      },
      {
        relatedRequestId: req.relatedRequestId,
        signal: req.signal,
        timeout: req.timeoutMs ?? CONFIRMATION_TIMEOUT_MS,
      },
    )
  } catch (e) {
    if (req.signal.aborted) return declined(req.def, 'cancelled the request for')
    // The question could not be shown or answered (a headless client, a
    // timeout): the user can still decide on Narrative's page.
    return linkError(
      req,
      req.confirmations.create(req.requirement.binding, req.requirement.summary),
      `The confirmation question for ${tool} could not be completed (${(e as Error).message}).`,
    )
  }
  if (result.action === 'accept' && result.content?.['confirm'] === true)
    return { ok: true, confirmation: { via: 'elicitation', commands: [req.def.id] } }
  if (result.action === 'cancel') {
    // Dismissed without an answer (a client with no one to ask, such as
    // headless Claude Code with an Elicitation hook). Not a "no": offer
    // the page, where only the signed-in user can approve. An explicit
    // decline (or an unticked box) stays final.
    return linkError(
      req,
      req.confirmations.create(req.requirement.binding, req.requirement.summary),
      'The confirmation question was dismissed without an answer.',
    )
  }
  return declined(
    req.def,
    result.action === 'accept' ? 'did not tick the confirmation for' : 'declined',
  )
}

/**
 * URL mode: send the page, then keep the call open until the user decides
 * there. A client that fails the request falls back to the link error.
 */
async function askWithUrl(
  req: ConfirmRequest,
  record: ConfirmationRecord,
): Promise<ConfirmationOutcome> {
  const userId = req.requirement.binding.userId
  let result
  try {
    result = await req.server.elicitInput(
      {
        mode: 'url',
        message: `${confirmationMessage(req.requirement)}\n\nOpen Narrative to approve or decline it.`,
        url: req.confirmUrl(record.id),
        elicitationId: record.id,
      },
      {
        relatedRequestId: req.relatedRequestId,
        signal: req.signal,
        timeout: req.timeoutMs ?? CONFIRMATION_TIMEOUT_MS,
      },
    )
  } catch {
    return linkError(req, record, null)
  }
  if (result.action !== 'accept') {
    // The user refused even to open the page: nothing may run on this id.
    req.confirmations.decide(record.id, userId, false)
    return declined(req.def, result.action === 'decline' ? 'declined' : 'cancelled')
  }
  const outcome = await req.confirmations.waitForDecision(record.id, req.signal)
  if (outcome === 'approved') {
    try {
      await req.server.createElicitationCompletionNotifier(record.id, {
        relatedRequestId: req.relatedRequestId,
      })()
    } catch {
      // Informational for the client; the approval stands.
    }
    return { ok: true, confirmation: { via: 'out_of_band', confirmationId: record.id } }
  }
  if (outcome === 'declined') return declined(req.def, 'declined on Narrative’s page')
  if (outcome === 'aborted') return declined(req.def, 'cancelled the request for')
  return linkError(req, record, 'The confirmation expired before the user decided.')
}

export async function obtainConfirmation(req: ConfirmRequest): Promise<ConfirmationOutcome> {
  const { binding, summary } = req.requirement
  let preface: string | null = null
  if (req.confirmationId !== undefined) {
    const inspected = req.confirmations.inspect(req.confirmationId, binding)
    if (inspected.state === 'approved')
      return { ok: true, confirmation: { via: 'out_of_band', confirmationId: inspected.record.id } }
    if (inspected.state === 'declined') return declined(req.def, 'declined on Narrative’s page')
    if (inspected.state === 'pending') {
      if (req.support.url) return askWithUrl(req, inspected.record)
      return linkError(req, inspected.record, 'The user has not approved it yet.')
    }
    preface =
      inspected.why === 'mismatch'
        ? 'That confirmationId was issued for a different call (the command, arguments or target differ); a new confirmation is needed.'
        : inspected.why === 'expired'
          ? 'That confirmationId has expired; a new confirmation is needed.'
          : inspected.why === 'used'
            ? 'That confirmationId was already used; a new confirmation is needed.'
            : 'That confirmationId is not valid for this session; a new confirmation is needed.'
  }
  // A client that can ask in a form is asked there (an unusable id changes nothing).
  if (req.support.form) return askWithForm(req)
  const record = req.confirmations.create(binding, summary)
  if (req.support.url) return askWithUrl(req, record)
  return linkError(req, record, preface)
}
