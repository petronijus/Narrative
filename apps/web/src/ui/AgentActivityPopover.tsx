/**
 * ui/AgentActivityPopover.tsx
 *
 * The editor's one piece of agent UI (agentic A1, plan §6): a toolbar
 * button opening a popover of the recent agent runs on this deck — or, in
 * the component master editor, on this component master — each with a
 * Revert button while the server can still undo it, so a person can undo an
 * agent without going back to Claude.
 *
 * - Editors and owners only (the toolbar gates it; the server answers 403
 *   to viewers anyway).
 * - The list is polled every few seconds while the popover is open, and
 *   only then. Whether an agent is working RIGHT NOW is read for free from
 *   awareness (the agent peer "Claude (MCP)"), and shown as a dot on the
 *   button.
 * - Revert has a confirm step (the app's inline Confirm / Cancel pattern);
 *   Escape backs out of the confirm step before it closes the popover. A
 *   revert is a server-side document change, so it arrives in the canvas
 *   over Yjs like any other remote edit and never touches the local undo
 *   stack.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Loader2, RotateCcw } from 'lucide-react'
import type { AgentRunSummary } from '@narrative/commands'
import { ApiRequestError, useApi, type AgentRunTarget } from '../api/client.js'
import { useAuth } from '../state/AuthContext.js'
import { useRemotePeers } from '../state/useAwareness.js'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isAgentPeer } from './peerPresence.js'
import {
  AGENT_RUNS_LIMIT,
  type AgentActivityDocument,
  AGENT_RUNS_POLL_MS,
  RUN_STATUS_LABEL,
  formatRelativeTime,
  notRevertibleText,
  runChangesText,
  runClientLabel,
  runRequestText,
  runRequester,
} from './agentActivity.js'

// ---------------------------------------------------------------------------
// Toolbar button
// ---------------------------------------------------------------------------

export function AgentActivityButton({ target }: { target: AgentRunTarget }) {
  const [open, setOpen] = useState(false)
  // Set while a row asks for confirmation, so Escape can cancel that first.
  const [confirmingRunId, setConfirmingRunId] = useState<string | null>(null)
  const remotePeers = useRemotePeers()
  const agentWorking = remotePeers.some(isAgentPeer)
  const label = agentWorking ? 'Agent activity — an agent is working now' : 'Agent activity'

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) setConfirmingRunId(null)
  }, [])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant={open ? 'default' : 'ghost'}
              size="icon"
              aria-label={label}
              data-agent-working={agentWorking || undefined}
              className="relative h-7 w-7"
            >
              <Bot className="h-3.5 w-3.5" aria-hidden="true" />
              {agentWorking && (
                <span
                  aria-hidden="true"
                  className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-background motion-safe:animate-pulse"
                />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-96 p-0"
        aria-label="Agent activity"
        onEscapeKeyDown={(e) => {
          if (confirmingRunId !== null) {
            e.preventDefault()
            setConfirmingRunId(null)
          }
        }}
      >
        <AgentActivityPanel
          target={target}
          confirmingRunId={confirmingRunId}
          setConfirmingRunId={setConfirmingRunId}
        />
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Run list
// ---------------------------------------------------------------------------

interface AgentActivityPanelProps {
  target: AgentRunTarget
  confirmingRunId: string | null
  setConfirmingRunId: (runId: string | null) => void
}

function documentOf(target: AgentRunTarget): AgentActivityDocument {
  return 'deckId' in target ? 'deck' : 'component master'
}

function errorText(e: unknown, fallback: string, subject: AgentActivityDocument): string {
  if (e instanceof ApiRequestError) {
    if (e.status === 403)
      return `You need edit access to this ${subject} to see or revert agent runs.`
    return e.message
  }
  return fallback
}

/** Mounted only while the popover is open, so it polls only then. */
function AgentActivityPanel({
  target,
  confirmingRunId,
  setConfirmingRunId,
}: AgentActivityPanelProps) {
  const api = useApi()
  const subject = documentOf(target)
  // Primitive dependencies: the caller may pass a fresh target object on
  // every render, which must not restart the poll.
  const targetId = 'deckId' in target ? target.deckId : target.componentId
  const { user } = useAuth()
  const localUserId = user?.sub ?? null

  const [runs, setRuns] = useState<AgentRunSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Bumped to re-read immediately (after a revert) instead of waiting for the poll.
  const [reloadToken, setReloadToken] = useState(0)
  const [revertingRunId, setRevertingRunId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Sequential poll: the next read is scheduled after the previous settles,
  // so a slow server never stacks requests.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      try {
        const next = await api.listAgentRuns(
          subject === 'deck' ? { deckId: targetId } : { componentId: targetId },
          AGENT_RUNS_LIMIT,
        )
        if (cancelled) return
        setRuns(next)
        setLoadError(null)
      } catch (e) {
        if (cancelled) return
        setLoadError(errorText(e, 'Could not load agent activity.', subject))
      } finally {
        if (!cancelled) timer = setTimeout(() => void tick(), AGENT_RUNS_POLL_MS)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [api, subject, targetId, reloadToken])

  const revert = useCallback(
    async (run: AgentRunSummary) => {
      setRevertingRunId(run.id)
      setNotice(null)
      setRowErrors(({ [run.id]: _dropped, ...rest }) => rest)
      try {
        const result = await api.revertAgentRun(run.id)
        if (!mountedRef.current) return
        const n = result.revertedChanges
        setNotice(`Reverted ${n === 1 ? '1 change' : `${n} changes`}.`)
      } catch (e) {
        if (!mountedRef.current) return
        setRowErrors((prev) => ({
          ...prev,
          [run.id]: errorText(e, 'Could not revert this run. Try again.', subject),
        }))
      } finally {
        if (mountedRef.current) {
          setRevertingRunId(null)
          setConfirmingRunId(null)
          setReloadToken((t) => t + 1)
          // The confirm buttons are gone; keep keyboard focus on the row.
          rowRefs.current.get(run.id)?.focus()
        }
      }
    },
    [api, subject, setConfirmingRunId],
  )

  const now = Date.now()

  return (
    <div className="flex max-h-[min(32rem,70vh)] flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Agent activity</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Changes AI agents made to this {subject}. Revert undoes only the agent&rsquo;s edits.
        </p>
      </div>

      <div role="status" aria-live="polite" className="empty:hidden px-4 pt-2 text-xs">
        {notice !== null && (
          <span className="text-emerald-600 dark:text-emerald-300">{notice}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs === null && loadError === null && (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Loading agent activity…
          </div>
        )}
        {loadError !== null && (
          <p role="alert" className="px-4 py-3 text-xs text-destructive">
            {loadError}
          </p>
        )}
        {runs !== null && runs.length === 0 && (
          <p className="px-4 py-6 text-xs text-muted-foreground">
            No agent has worked on this {subject} yet.
          </p>
        )}
        {runs !== null && runs.length > 0 && (
          <ul aria-label="Recent agent runs" className="divide-y divide-border">
            {runs.map((run) => (
              <AgentRunRow
                key={run.id}
                run={run}
                now={now}
                localUserId={localUserId}
                subject={subject}
                confirming={confirmingRunId === run.id}
                reverting={revertingRunId === run.id}
                busy={revertingRunId !== null}
                error={rowErrors[run.id] ?? null}
                onAskRevert={() => setConfirmingRunId(run.id)}
                onCancelRevert={() => setConfirmingRunId(null)}
                onConfirmRevert={() => void revert(run)}
                rowRef={(el) => {
                  if (el === null) rowRefs.current.delete(run.id)
                  else rowRefs.current.set(run.id, el)
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

interface AgentRunRowProps {
  run: AgentRunSummary
  now: number
  localUserId: string | null
  subject: AgentActivityDocument
  confirming: boolean
  reverting: boolean
  /** Another revert is in flight — hold this row's Revert until it settles. */
  busy: boolean
  error: string | null
  onAskRevert: () => void
  onCancelRevert: () => void
  onConfirmRevert: () => void
  rowRef: (el: HTMLElement | null) => void
}

const STATUS_BADGE_CLASS: Readonly<Record<AgentRunSummary['status'], string>> = {
  open: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  closed: 'border-border bg-muted text-muted-foreground',
  reverted: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
}

function AgentRunRow({
  run,
  now,
  localUserId,
  subject,
  confirming,
  reverting,
  busy,
  error,
  onAskRevert,
  onCancelRevert,
  onConfirmRevert,
  rowRef,
}: AgentRunRowProps) {
  const revertButtonRef = useRef<HTMLButtonElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const wasConfirmingRef = useRef(confirming)

  // Focus follows the confirm step: into it on "Revert…" (onto Cancel, the
  // safe choice), back to "Revert…" when it is cancelled.
  useEffect(() => {
    if (confirming && !wasConfirmingRef.current) cancelButtonRef.current?.focus()
    if (!confirming && wasConfirmingRef.current && !reverting) revertButtonRef.current?.focus()
    wasConfirmingRef.current = confirming
  }, [confirming, reverting])

  const requestText = runRequestText(run)
  const isAutomatic = run.request === null || run.request.trim() === ''
  const reason = notRevertibleText(run, localUserId, now, subject)

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      data-run-id={run.id}
      data-run-status={run.status}
      className="px-4 py-3 outline-none focus-visible:bg-accent/50"
    >
      <div className="flex items-start justify-between gap-3">
        <p
          className={
            'min-w-0 flex-1 break-words text-sm ' +
            (isAutomatic ? 'italic text-muted-foreground' : 'text-foreground')
          }
        >
          {requestText}
        </p>
        <span
          className={
            'inline-flex h-5 flex-shrink-0 items-center rounded-full border px-2 text-[10px] font-medium ' +
            STATUS_BADGE_CLASS[run.status]
          }
        >
          {RUN_STATUS_LABEL[run.status]}
        </span>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        {runRequester(run, localUserId)} · {runClientLabel(run)} ·{' '}
        <time dateTime={run.lastActivityAt} title={new Date(run.lastActivityAt).toLocaleString()}>
          {formatRelativeTime(run.lastActivityAt, now)}
        </time>{' '}
        · {runChangesText(run)}
      </p>

      <div className="mt-2 flex min-h-7 items-center justify-between gap-2">
        {run.revertible ? (
          confirming ? (
            <div
              role="group"
              aria-label={`Confirm reverting: ${requestText}`}
              className="flex w-full items-center justify-end gap-2"
            >
              <span className="mr-auto text-xs text-foreground">
                Revert{' '}
                {run.revertibleChanges === 1 ? '1 change' : `${run.revertibleChanges} changes`}?
              </span>
              <Button
                ref={cancelButtonRef}
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={reverting}
                onClick={onCancelRevert}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={reverting}
                aria-busy={reverting}
                onClick={onConfirmRevert}
              >
                {reverting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                Confirm revert
              </Button>
            </div>
          ) : (
            <Button
              ref={revertButtonRef}
              variant="outline"
              size="sm"
              className="ml-auto h-7 gap-1.5 px-2 text-xs"
              disabled={busy}
              aria-label={`Revert: ${requestText}`}
              onClick={onAskRevert}
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Revert…
            </Button>
          )
        ) : (
          reason !== null && <p className="text-xs text-muted-foreground">{reason}</p>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  )
}
