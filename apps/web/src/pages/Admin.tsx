/**
 * pages/Admin.tsx
 *
 * Administration (/admin), instance admins only (docs/adr/0014). An admin is
 * owner of every folder and deck except other people's Drafts, and decides who
 * may use Narrative at all:
 *   - "Allowed to sign in": the addresses an admin let in. A person on the list
 *     signs in with their Google account and sees only what is shared with them
 *     — or, once they are an admin, everything. No email is sent.
 *   - "People": everyone who has signed in, and who is an admin.
 *
 *   - "Emails": every kind of email Narrative sends, switched on or off for
 *     the whole instance, with a preview (AdminEmails.tsx).
 *
 * The server decides (every call answers 403 to anyone else); this page only
 * hides itself from people who are not admins. Reached from the user menu.
 */

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Plus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { ApiError, useApi, type AdminUser, type AllowedEmail } from '../api/client.js'
import { useAuth } from '../state/AuthContext.js'
import { AdminEmails } from './AdminEmails.js'
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

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** What an admin confirms before it happens. */
type Pending =
  | { kind: 'remove'; entry: AllowedEmail }
  | { kind: 'promote'; user: AdminUser }
  | { kind: 'demote'; user: AdminUser }

function Banner({ children }: { children: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground"
    >
      {children}
    </div>
  )
}

export function Admin() {
  const navigate = useNavigate()
  const api = useApi()
  const { user: me } = useAuth()
  const formId = useId()
  const [allowed, setAllowed] = useState<AllowedEmail[]>([])
  const [people, setPeople] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [adding, setAdding] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([api.listAllowedEmails(), api.listAdminUsers()])
      setAllowed(a)
      setPeople(p)
      setError(null)
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Only admins can open this page.'
          : message(err, 'Could not load the administration data.'),
      )
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const trimmed = email.trim().toLowerCase()
  const canAdd = EMAIL_PATTERN.test(trimmed) && !adding

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault()
    if (!canAdd) return
    setAdding(true)
    setError(null)
    try {
      await api.allowEmail(trimmed)
      setEmail('')
      await load()
    } catch (err) {
      setError(message(err, 'Could not allow that address. Try again.'))
    } finally {
      setAdding(false)
    }
  }

  const handleConfirm = async () => {
    if (pending === null) return
    setConfirming(true)
    setError(null)
    try {
      if (pending.kind === 'remove') await api.removeAllowedEmail(pending.entry.email)
      else await api.setUserAdmin(pending.user.userId, pending.kind === 'promote')
      setPending(null)
      await load()
    } catch (err) {
      setPending(null)
      setError(message(err, 'That did not work. Try again.'))
    } finally {
      setConfirming(false)
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
          <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <h1 className="text-sm font-semibold text-foreground">Administration</h1>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-3xl gap-8 px-8 py-8">
          {error !== null && <Banner>{error}</Banner>}

          <section className="grid gap-4">
            <div className="max-w-xl">
              <h2 className="text-base font-semibold text-foreground">Allowed to sign in</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                A person on this list can sign in with their Google account. They see only what is
                shared with them until you make them an admin. Nothing is sent to them: tell them
                yourself.
              </p>
            </div>

            <form
              id={formId}
              onSubmit={(e) => void handleAdd(e)}
              className="flex flex-wrap items-end gap-2"
            >
              <div className="grid min-w-[16rem] flex-1 gap-2">
                <Label htmlFor={`${formId}-email`}>Email address</Label>
                <Input
                  id={`${formId}-email`}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={320}
                  placeholder="name@company.com"
                  autoComplete="off"
                />
              </div>
              <Button type="submit" size="sm" className="btn-brand gap-1.5" disabled={!canAdd}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {adding ? 'Allowing…' : 'Allow'}
              </Button>
            </form>

            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : allowed.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No one yet. People listed in the server settings and people invited to a deck or
                folder can sign in without being here.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {allowed.map((entry) => (
                  <li key={entry.email} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {entry.email}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {entry.signedIn ? 'Has signed in' : 'Has not signed in yet'} · allowed{' '}
                        {formatDate(entry.addedAt)}
                        {entry.addedBy !== null && ` by ${entry.addedBy}`}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Stop allowing ${entry.email}`}
                      onClick={() => setPending({ kind: 'remove', entry })}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-4">
            <div className="max-w-xl">
              <h2 className="text-base font-semibold text-foreground">People</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                An admin is owner of every folder and deck except other people&rsquo;s private
                Drafts, and can do everything on this page.
              </p>
            </div>

            {!loading && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {people.map((person) => {
                  const itsMe = person.userId === me?.sub
                  return (
                    <li key={person.userId} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {person.name ?? person.email}
                          </span>
                          {person.isAdmin && (
                            <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                              Admin
                            </span>
                          )}
                          {itsMe && <span className="text-xs text-muted-foreground">(you)</span>}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {person.email} · last seen {formatDate(person.lastSeenAt)}
                        </div>
                      </div>
                      {!itsMe && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1.5"
                          onClick={() =>
                            setPending({
                              kind: person.isAdmin ? 'demote' : 'promote',
                              user: person,
                            })
                          }
                        >
                          {person.isAdmin ? (
                            <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {person.isAdmin ? 'Remove admin' : 'Make admin'}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <AdminEmails />
        </div>
      </main>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="max-w-md">
          {pending !== null && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {pending.kind === 'remove' && 'Stop allowing this address?'}
                  {pending.kind === 'promote' && 'Make this person an admin?'}
                  {pending.kind === 'demote' && 'Remove this admin?'}
                </DialogTitle>
                <DialogDescription>
                  {pending.kind === 'remove' &&
                    `${pending.entry.email} is taken off the list. If nothing else lets them in, they are signed out at once; access a deck or folder shared with them keeps them in.`}
                  {pending.kind === 'promote' &&
                    `${pending.user.email} becomes owner of every folder and deck except other people's Drafts, and can add and remove people.`}
                  {pending.kind === 'demote' &&
                    `${pending.user.email} loses access to everything that is not shared with them, and can no longer manage people.`}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setPending(null)} disabled={confirming}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void handleConfirm()}
                  disabled={confirming}
                  variant={pending.kind === 'promote' ? 'default' : 'destructive'}
                >
                  {confirming
                    ? 'Working…'
                    : pending.kind === 'remove'
                      ? 'Stop allowing'
                      : pending.kind === 'promote'
                        ? 'Make admin'
                        : 'Remove admin'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
