/**
 * pages/ConfirmAgentAction.tsx — `/confirm/:id`: the signed-in user approves
 * or declines an agent request that needs their confirmation (an
 * irreversible command such as sharing or deleting, or a download from a
 * web address). Agentic A1, docs/mcp.md "Confirmation".
 *
 * The agent (a Claude client that cannot ask the user itself) handed the
 * user this link. Everything shown comes from the server, which built it
 * from the exact call — the agent cannot word it. The page is lazy-loaded
 * (App.tsx); the API refuses tokens and foreign origins, so only this
 * browser session can decide (apps/server/src/routes/agentConfirmations.ts).
 */

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, Bot, Check, ChevronLeft, ShieldAlert, X } from 'lucide-react'
import { ApiRequestError, useApi, type AgentConfirmation } from '../api/client.js'
import { Button } from '@/components/ui/button'

const TARGET_WORDS: Record<AgentConfirmation['summary']['target']['kind'], string> = {
  deck: 'Deck',
  folder: 'Folder',
  component: 'Component master',
  account: 'Where',
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

const STATUS_WORDS: Record<Exclude<AgentConfirmation['status'], 'pending'>, string> = {
  approved: 'You approved this request. The agent can now go ahead.',
  used: 'You approved this request, and the agent has carried it out.',
  declined: 'You declined this request. Nothing was done.',
  expired:
    'This request has expired. Nothing was done; ask the agent to try again if you still want it.',
}

export function ConfirmAgentAction() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const api = useApi()
  const [confirmation, setConfirmation] = useState<AgentConfirmation | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.getAgentConfirmation(id).then(
      (c) => {
        if (cancelled) return
        setConfirmation(c)
        setState(c === null ? 'missing' : 'ready')
      },
      () => {
        if (!cancelled) setState('error')
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, id])

  const decide = async (decision: 'approve' | 'decline'): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      setConfirmation(await api.decideAgentConfirmation(id, decision))
    } catch (e) {
      setActionError(e instanceof ApiRequestError ? e.message : 'Could not save your answer.')
      // Show the current state (e.g. expired) instead of stale buttons.
      const fresh = await api.getAgentConfirmation(id).catch(() => null)
      if (fresh !== null) setConfirmation(fresh)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="panel border-b border-border px-8 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => void navigate('/')}
            aria-label="Back to folders"
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Folders
          </button>
          <span className="shrink-0 text-muted-foreground/40" aria-hidden="true">
            /
          </span>
          <ShieldAlert className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <h1 className="text-sm font-semibold text-foreground">Confirm an agent request</h1>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-xl gap-6 px-8 py-8">
          {state === 'loading' && <p className="text-sm text-muted-foreground">Loading…</p>}
          {state === 'error' && (
            <p role="alert" className="text-sm text-destructive-foreground">
              Could not load this request. Reload the page to try again.
            </p>
          )}
          {state === 'missing' && (
            <p role="alert" className="text-sm text-muted-foreground">
              This request does not exist, has expired, or belongs to another account. Nothing was
              done.
            </p>
          )}
          {state === 'ready' && confirmation !== null && (
            <ConfirmationCard
              confirmation={confirmation}
              busy={busy}
              actionError={actionError}
              onDecide={(d) => void decide(d)}
            />
          )}
        </div>
      </main>
    </div>
  )
}

function ConfirmationCard({
  confirmation,
  busy,
  actionError,
  onDecide,
}: {
  confirmation: AgentConfirmation
  busy: boolean
  actionError: string | null
  onDecide: (decision: 'approve' | 'decline') => void
}) {
  const { summary } = confirmation
  const client = summary.clientName ?? 'An agent'
  return (
    <section aria-labelledby="confirm-heading" className="grid gap-5">
      <div className="flex items-start gap-3">
        <Bot className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <h2 id="confirm-heading" className="text-base font-semibold text-foreground">
            {client} wants to: {summary.title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{summary.action}</p>
        </div>
      </div>

      <dl
        data-testid="confirm-details"
        className="panel grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 rounded-lg border border-border px-4 py-3 text-sm"
      >
        <dt className="text-muted-foreground">{TARGET_WORDS[summary.target.kind]}</dt>
        <dd className="break-words font-medium">
          {summary.target.kind === 'account'
            ? 'Your Narrative account'
            : (summary.target.label ?? 'Untitled or not found')}
        </dd>
        {summary.details.map((d, i) => (
          <div key={i} className="contents">
            <dt className="text-muted-foreground">{d.label}</dt>
            <dd className="break-words font-medium">{d.value}</dd>
          </div>
        ))}
        <dt className="text-muted-foreground">Requested</dt>
        <dd>
          <time dateTime={confirmation.createdAt}>{formatTime(confirmation.createdAt)}</time>
        </dd>
      </dl>

      {summary.reasons.includes('irreversible') && (
        <p className="flex items-start gap-2 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
          This cannot be undone with Revert.
        </p>
      )}
      {summary.reasons.includes('url_fetch') && (
        <p className="flex items-start gap-2 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
          Narrative will download from {summary.hosts.join(', ')}. The web address itself is sent to
          that site, so allow it only if you expect this download.
        </p>
      )}

      {confirmation.status === 'pending' ? (
        <>
          <p className="rounded-md border-l-2 border-amber-500 pl-3 text-sm text-foreground">
            <strong>Only approve if you just asked the agent to do this.</strong> If you did not
            start it, decline: something in a deck or a document may be trying to act for you.
          </p>
          {actionError !== null && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {actionError}
            </p>
          )}
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1 gap-1.5"
              disabled={busy}
              onClick={() => onDecide('decline')}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Decline
            </Button>
            <Button
              className="btn-brand flex-1 gap-1.5"
              disabled={busy}
              onClick={() => onDecide('approve')}
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Approve
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Expires{' '}
            <time dateTime={confirmation.expiresAt}>{formatTime(confirmation.expiresAt)}</time>.
          </p>
        </>
      ) : (
        <p role="status" className="text-sm text-foreground">
          {STATUS_WORDS[confirmation.status]}
          {confirmation.status === 'approved' && ' You can go back to your agent and tell it.'}
        </p>
      )}
    </section>
  )
}
