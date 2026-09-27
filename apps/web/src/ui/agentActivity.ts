/**
 * ui/agentActivity.ts
 *
 * Wording for the Agent activity popover (agentic A1, plan §6): pure
 * functions from an `AgentRunSummary` to the words a person reads. Kept out
 * of the component so the wording rules live in one testable place.
 */

import type { AgentRunStatus, AgentRunSummary } from '@narrative/commands'

/** How often the popover re-reads the run list while it is open. */
export const AGENT_RUNS_POLL_MS = 3_000
/** How many runs the popover lists. */
export const AGENT_RUNS_LIMIT = 20

/**
 * What the popover's runs worked on, as a person names it in a sentence
 * ("this deck", "this component master"). Agents edit component masters
 * too, and the popover is shown in the master editor as well.
 */
export type AgentActivityDocument = 'deck' | 'component master'

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const RELATIVE_STEPS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { unit: 'year', seconds: 365 * 24 * 3600 },
  { unit: 'month', seconds: 30 * 24 * 3600 },
  { unit: 'week', seconds: 7 * 24 * 3600 },
  { unit: 'day', seconds: 24 * 3600 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'minute', seconds: 60 },
]

/**
 * "just now", "5 minutes ago", "yesterday", … for an ISO timestamp.
 * An unparseable timestamp yields an empty string rather than "NaN years ago".
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const elapsed = Math.round((now - at) / 1000)
  // Clock skew between server and browser can put a fresh run slightly in
  // the future; it is still "just now".
  if (elapsed < 45) return 'just now'
  for (const { unit, seconds } of RELATIVE_STEPS) {
    if (elapsed >= seconds) return relativeFormat.format(-Math.floor(elapsed / seconds), unit)
  }
  return relativeFormat.format(-1, 'minute')
}

/** Who asked for the run: "You", the user's name, or their id as a last resort. */
export function runRequester(run: AgentRunSummary, localUserId: string | null): string {
  if (localUserId !== null && run.userId === localUserId) return 'You'
  return run.userName ?? run.userId
}

/** The request as the agent stated it, or "Automatic run" for implicit runs. */
export function runRequestText(run: AgentRunSummary): string {
  const request = run.request?.trim() ?? ''
  return request === '' ? 'Automatic run' : request
}

/** Which client ran it, in the same words as the agent's peer chip: "Claude (MCP)". */
export function runClientLabel(run: AgentRunSummary): string {
  if (run.surface === 'mcp') return `${run.clientName ?? 'Claude'} (MCP)`
  return `${run.clientName ?? 'Script'} (API)`
}

export function runChangesText(run: AgentRunSummary): string {
  return run.changeCount === 1 ? '1 change' : `${run.changeCount} changes`
}

export const RUN_STATUS_LABEL: Readonly<Record<AgentRunStatus, string>> = {
  open: 'Active',
  closed: 'Closed',
  reverted: 'Reverted',
}

/**
 * Why a run cannot be reverted, in plain words — or null when it can.
 * `revertedBy` is a user id (the API carries no name for it), so it is named
 * only when it is the local user or the run's own requester.
 */
export function notRevertibleText(
  run: AgentRunSummary,
  localUserId: string | null,
  now: number = Date.now(),
  document: AgentActivityDocument = 'deck',
): string | null {
  if (run.revertible) return null
  switch (run.notRevertibleReason) {
    case 'reverted': {
      let by = ''
      if (run.revertedBy !== null) {
        if (localUserId !== null && run.revertedBy === localUserId) by = ' by you'
        else if (run.revertedBy === run.userId && run.userName !== null) by = ` by ${run.userName}`
        else by = ' by another collaborator'
      }
      const when = run.revertedAt === null ? '' : ` ${formatRelativeTime(run.revertedAt, now)}`
      return `Reverted${by}${when}`.trimEnd()
    }
    case 'nothing_to_revert':
      return `Nothing to revert — this run did not change the ${document}`
    case 'unloaded':
      return `No longer revertible — the ${document} was closed on the server`
    case 'expired':
      return 'No longer revertible — newer agent runs replaced its undo history'
    case 'not_document':
      return `Not revertible — this run did not edit the ${document}`
    case null:
      // Not revertible without a reason (should not happen): say so plainly.
      return 'Not revertible'
  }
}
