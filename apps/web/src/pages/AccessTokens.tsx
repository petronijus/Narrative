/**
 * pages/AccessTokens.tsx
 *
 * Account settings → Access tokens (/settings/access-tokens), agentic layer A1.
 *
 * Personal access tokens let Claude (over MCP) and scripts (the batch HTTP
 * API) act as the signed-in user. This page lists the user's tokens, creates
 * one (name, scopes, expiry) and shows its secret exactly once, and revokes
 * tokens after a confirmation. Token management itself is session-only on
 * the server: a token can never manage tokens.
 *
 * It also lists the user's connected apps — MCP clients such as claude.ai
 * connectors that signed in through Narrative's OAuth flow — and disconnects
 * them after a confirmation (GET / DELETE /oauth/connections, session-only
 * as well). Disconnecting revokes the app's grant and tokens and ends its
 * open MCP sessions on the server.
 *
 * Reached from the user menu (ui/UserMenu.tsx).
 */

import { useEffect, useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Copy,
  KeyRound,
  Plug,
  Plus,
  Trash2,
  Unplug,
} from 'lucide-react'
import {
  ACCESS_TOKEN_EXPIRY_DAYS,
  mcpEndpointUrl,
  useApi,
  type AccessTokenExpiryDays,
  type AccessTokenScope,
  type AccessTokenSummary,
  type CreatedAccessToken,
  type OAuthConnection,
} from '../api/client.js'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPE_OPTIONS: ReadonlyArray<{ scope: AccessTokenScope; label: string; help: string }> = [
  {
    scope: 'mcp',
    label: 'MCP',
    help: 'Lets Claude Code / claude.ai act as you.',
  },
  {
    scope: 'api',
    label: 'API',
    help: 'Batch HTTP API, for scripts (POST /api/commands).',
  },
]

// Every token expires; a year is the longest choice (the server refuses
// anything else, so a leaked token cannot stay valid indefinitely).
const EXPIRY_OPTIONS: ReadonlyArray<{
  value: AccessTokenExpiryDays
  label: string
}> = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' },
]

function isExpiryDays(value: number): value is AccessTokenExpiryDays {
  return (ACCESS_TOKEN_EXPIRY_DAYS as readonly number[]).includes(value)
}

const NAME_MAX_LENGTH = 80

/** The command a user runs to connect Claude Code to this Narrative. */
function claudeCodeCommand(token: string): string {
  return `claude mcp add --transport http --scope user narrative ${mcpEndpointUrl()} --header "Authorization: Bearer ${token}"`
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Where an app's sign-ins return to, for people: a loopback callback is a
 * program on the user's own computer (Claude Code), whatever its port; any
 * other host is shown as is (e.g. claude.ai).
 */
function describeRedirectHosts(hosts: readonly string[]): string {
  const labels = new Set<string>()
  for (const host of hosts) {
    const hostname = host.replace(/:\d+$/, '')
    labels.add(LOOPBACK_HOSTNAMES.has(hostname) ? 'this computer' : host)
  }
  return labels.size === 0 ? '—' : [...labels].join(', ')
}

/** Server error message from a rejected API call, if it sent one. */
function errorMessage(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: unknown } } | null)?.body
  return typeof body?.message === 'string' ? body.message : fallback
}

// ---------------------------------------------------------------------------
// Copy button
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 gap-1.5"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true))
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function CommandBlock({ command, copyLabel }: { command: string; copyLabel: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-xs text-foreground">
        {command}
      </pre>
      <CopyButton text={command} label={copyLabel} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

interface CreateDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  onCreated(created: CreatedAccessToken): void
}

function CreateTokenDialog({ open, onOpenChange, onCreated }: CreateDialogProps) {
  const api = useApi()
  const formId = useId()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<AccessTokenScope[]>(['mcp'])
  const [expiresInDays, setExpiresInDays] = useState<AccessTokenExpiryDays>(90)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The raw token lives only here, only while the dialog shows it.
  const [created, setCreated] = useState<CreatedAccessToken | null>(null)

  const reset = () => {
    setName('')
    setScopes(['mcp'])
    setExpiresInDays(90)
    setSubmitting(false)
    setError(null)
    setCreated(null)
  }

  const handleOpenChange = (next: boolean) => {
    // Closing forgets the secret: it can never be shown again.
    if (!next) reset()
    onOpenChange(next)
  }

  const toggleScope = (scope: AccessTokenScope, on: boolean) => {
    setScopes((prev) => (on ? [...prev, scope] : prev.filter((s) => s !== scope)))
  }

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && scopes.length > 0 && !submitting

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await api.createAccessToken({ name: trimmedName, scopes, expiresInDays })
      setCreated(result)
      onCreated(result)
    } catch (err) {
      setError(errorMessage(err, 'Could not create the token. Try again.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        {created === null ? (
          <>
            <DialogHeader>
              <DialogTitle>New access token</DialogTitle>
              <DialogDescription>
                The token acts as you, with your access to every deck and folder you can open.
              </DialogDescription>
            </DialogHeader>

            <form id={formId} onSubmit={(e) => void handleSubmit(e)} className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor={`${formId}-name`}>Name</Label>
                <Input
                  id={`${formId}-name`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={NAME_MAX_LENGTH}
                  placeholder="e.g. MacBook — Claude Code"
                  autoFocus
                  autoComplete="off"
                />
              </div>

              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Scopes</legend>
                {SCOPE_OPTIONS.map((opt) => (
                  <label
                    key={opt.scope}
                    className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 hover:bg-accent/40"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-primary"
                      checked={scopes.includes(opt.scope)}
                      onChange={(e) => toggleScope(opt.scope, e.target.checked)}
                    />
                    <span className="grid gap-0.5">
                      <span className="text-sm font-medium text-foreground">{opt.label}</span>
                      <span className="text-xs text-muted-foreground">{opt.help}</span>
                    </span>
                  </label>
                ))}
                {scopes.length === 0 && (
                  <p className="text-xs text-destructive">Pick at least one scope.</p>
                )}
              </fieldset>

              <div className="grid gap-2">
                <Label htmlFor={`${formId}-expiry`}>Expires</Label>
                <select
                  id={`${formId}-expiry`}
                  value={String(expiresInDays)}
                  onChange={(e) => {
                    const days = Number(e.target.value)
                    if (isExpiryDays(days)) setExpiresInDays(days)
                  }}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {error !== null && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground"
                >
                  {error}
                </div>
              )}
            </form>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" form={formId} disabled={!canSubmit}>
                {submitting ? 'Creating…' : 'Create token'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Copy your new token</DialogTitle>
              <DialogDescription>
                &ldquo;{created.accessToken.name}&rdquo; is ready.
              </DialogDescription>
            </DialogHeader>

            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
                aria-hidden="true"
              />
              <span>
                This is the only time the token is shown. Store it somewhere safe, such as your
                password manager. Anyone who has it can act as you.
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={created.token}
                aria-label="New access token"
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <CopyButton text={created.token} label="Copy token" />
            </div>

            {created.accessToken.scopes.includes('mcp') && (
              <div className="grid gap-2">
                <p className="text-sm text-muted-foreground">
                  To connect Claude Code, run this once in a terminal:
                </p>
                <CommandBlock
                  command={claudeCodeCommand(created.token)}
                  copyLabel="Copy Claude Code command"
                />
              </div>
            )}

            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Revoke dialog
// ---------------------------------------------------------------------------

interface RevokeDialogProps {
  token: AccessTokenSummary | null
  onCancel(): void
  onRevoked(id: string): void
}

function RevokeTokenDialog({ token, onCancel, onRevoked }: RevokeDialogProps) {
  const api = useApi()
  const [revoking, setRevoking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setError(null)
    setRevoking(false)
    onCancel()
  }

  const handleRevoke = async () => {
    if (token === null) return
    setRevoking(true)
    setError(null)
    try {
      await api.revokeAccessToken(token.id)
      setRevoking(false)
      onRevoked(token.id)
    } catch {
      setRevoking(false)
      setError('Could not revoke the token. Try again.')
    }
  }

  return (
    <Dialog open={token !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke &ldquo;{token?.name}&rdquo;?</DialogTitle>
          <DialogDescription>
            Anything using this token stops working immediately. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground"
          >
            {error}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={revoking}
            onClick={() => void handleRevoke()}
          >
            {revoking ? 'Revoking…' : 'Revoke token'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Disconnect dialog (connected apps)
// ---------------------------------------------------------------------------

interface DisconnectDialogProps {
  connection: OAuthConnection | null
  onCancel(): void
  onDisconnected(id: string): void
}

function DisconnectAppDialog({ connection, onCancel, onDisconnected }: DisconnectDialogProps) {
  const api = useApi()
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setError(null)
    setDisconnecting(false)
    onCancel()
  }

  const handleDisconnect = async () => {
    if (connection === null) return
    setDisconnecting(true)
    setError(null)
    try {
      await api.disconnectOAuthConnection(connection.id)
      setDisconnecting(false)
      onDisconnected(connection.id)
    } catch {
      setDisconnecting(false)
      setError('Could not disconnect the app. Try again.')
    }
  }

  return (
    <Dialog open={connection !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect &ldquo;{connection?.clientName}&rdquo;?</DialogTitle>
          <DialogDescription>
            It loses access to Narrative immediately and its open sessions end. To use it again,
            connect it anew from the app. Changes it already made stay; revert them from the
            deck&rsquo;s Agent activity.
          </DialogDescription>
        </DialogHeader>
        {error !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground"
          >
            {error}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={disconnecting}
            onClick={() => void handleDisconnect()}
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Connected app row
// ---------------------------------------------------------------------------

function ConnectedAppRow({
  connection,
  onDisconnect,
}: {
  connection: OAuthConnection
  onDisconnect(connection: OAuthConnection): void
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {connection.clientName}
          </span>
          {connection.scopes.map((scope) => (
            <span
              key={scope}
              className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {scope}
            </span>
          ))}
        </div>
        {connection.flaggedAt !== null && (
          <p
            role="note"
            className="mt-1 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
          >
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              Suspicious activity on {formatDate(connection.flaggedAt)}:{' '}
              {connection.flagReason ?? 'a sign-in token of this app was reused.'} Disconnect it if
              you do not recognise this.
            </span>
          </p>
        )}
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span>Returns to {describeRedirectHosts(connection.redirectHosts)}</span>
          <span>Connected {formatDate(connection.createdAt)}</span>
          <span>
            {connection.lastUsedAt === null
              ? 'Never used'
              : `Last used ${formatDate(connection.lastUsedAt)}`}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground hover:text-destructive"
        onClick={() => onDisconnect(connection)}
        aria-label={`Disconnect ${connection.clientName}`}
      >
        <Unplug className="h-3.5 w-3.5" aria-hidden="true" />
        Disconnect
      </Button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Token row
// ---------------------------------------------------------------------------

function TokenRow({
  token,
  onRevoke,
}: {
  token: AccessTokenSummary
  onRevoke(token: AccessTokenSummary): void
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{token.name}</span>
          {token.scopes.map((scope) => (
            <span
              key={scope}
              className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {scope}
            </span>
          ))}
          {token.expired && (
            <span className="rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">
              Expired
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono">{token.prefix}…</span>
          <span>Created {formatDate(token.createdAt)}</span>
          <span>
            {token.lastUsedAt === null ? 'Never used' : `Last used ${formatDate(token.lastUsedAt)}`}
          </span>
          <span>{`${token.expired ? 'Expired' : 'Expires'} ${formatDate(token.expiresAt)}`}</span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground hover:text-destructive"
        onClick={() => onRevoke(token)}
        aria-label={`Revoke ${token.name}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        Revoke
      </Button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AccessTokens() {
  const navigate = useNavigate()
  const api = useApi()
  const [tokens, setTokens] = useState<AccessTokenSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<AccessTokenSummary | null>(null)
  const [connections, setConnections] = useState<OAuthConnection[]>([])
  const [connectionsLoading, setConnectionsLoading] = useState(true)
  const [connectionsError, setConnectionsError] = useState<string | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<OAuthConnection | null>(null)
  // Bumped after a disconnect: the list is re-read from the server, which is
  // the only source of truth for what is still connected.
  const [connectionsVersion, setConnectionsVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.listAccessTokens().then(
      (list) => {
        if (cancelled) return
        setTokens(list)
        setError(null)
        setLoading(false)
      },
      () => {
        if (cancelled) return
        setError('Could not load your access tokens.')
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    let cancelled = false
    api.listOAuthConnections().then(
      (list) => {
        if (cancelled) return
        setConnections(list)
        setConnectionsError(null)
        setConnectionsLoading(false)
      },
      () => {
        if (cancelled) return
        setConnectionsError('Could not load your connected apps.')
        setConnectionsLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, connectionsVersion])

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
          <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <h1 className="text-sm font-semibold text-foreground">Access tokens</h1>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-3xl gap-8 px-8 py-8">
          <section className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-xl">
              <h2 className="text-base font-semibold text-foreground">Personal access tokens</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Tokens let Claude and your scripts work in Narrative as you, on every deck and
                folder you can open. Treat a token like a password, give each device or tool its
                own, and revoke the ones you no longer use.
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)} size="sm" className="btn-brand gap-1.5">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New token
            </Button>
          </section>

          {error !== null && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground"
            >
              {error}
            </div>
          )}

          <section aria-label="Your tokens">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : tokens.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
                You have no access tokens yet.
              </div>
            ) : (
              <ul className="panel divide-y divide-border rounded-lg border border-border">
                {tokens.map((t) => (
                  <TokenRow key={t.id} token={t} onRevoke={setRevokeTarget} />
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-3">
            <h2 className="text-base font-semibold text-foreground">Connect Claude Code</h2>
            <p className="text-sm text-muted-foreground">
              Create a token with the MCP scope, then run this once in a terminal, replacing{' '}
              <code className="font-mono text-xs text-foreground">&lt;token&gt;</code> with it.
              Claude Code can then read and edit your decks as you.
            </p>
            <CommandBlock
              command={claudeCodeCommand('<token>')}
              copyLabel="Copy Claude Code command"
            />
          </section>

          <section className="grid gap-4" aria-labelledby="connected-apps-heading">
            <div className="max-w-xl">
              <h2
                id="connected-apps-heading"
                className="flex items-center gap-2 text-base font-semibold text-foreground"
              >
                <Plug className="h-4 w-4 text-muted-foreground/60" aria-hidden="true" />
                Connected apps
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Apps you allowed to use Narrative as you by signing in, such as a claude.ai
                connector. Each has the same access as a token; disconnect the ones you no longer
                use.
              </p>
            </div>

            {connectionsError !== null && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground"
              >
                {connectionsError}
              </div>
            )}

            <section aria-label="Your connected apps">
              {connectionsLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : connectionsError !== null ? null : connections.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
                  No apps are connected. Add Narrative as a custom connector in claude.ai with the
                  URL <code className="font-mono text-xs text-foreground">{mcpEndpointUrl()}</code>.
                </div>
              ) : (
                <ul className="panel divide-y divide-border rounded-lg border border-border">
                  {connections.map((c) => (
                    <ConnectedAppRow key={c.id} connection={c} onDisconnect={setDisconnectTarget} />
                  ))}
                </ul>
              )}
            </section>
          </section>
        </div>
      </main>

      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created) => setTokens((prev) => [created.accessToken, ...prev])}
      />
      <RevokeTokenDialog
        token={revokeTarget}
        onCancel={() => setRevokeTarget(null)}
        onRevoked={(id) => {
          setTokens((prev) => prev.filter((t) => t.id !== id))
          setRevokeTarget(null)
        }}
      />
      <DisconnectAppDialog
        connection={disconnectTarget}
        onCancel={() => setDisconnectTarget(null)}
        onDisconnected={(id) => {
          setConnections((prev) => prev.filter((c) => c.id !== id))
          setDisconnectTarget(null)
          setConnectionsVersion((v) => v + 1)
        }}
      />
    </div>
  )
}
