/**
 * ui/sharing/PeopleWithAccess.tsx
 *
 * The "People with access" part of a sharing dialog, for a deck (ShareDialog)
 * and for a folder (FolderShareDialog, folder sharing step 3): the people
 * with a role (change it, remove them), the pending email invites (cancel
 * one) and the invite-by-email row. What it acts on comes in as a
 * `PeopleAccessAdapter`, so the deck and the folder dialogs share one UI.
 *
 * You cannot change or remove your own role — only another owner can. The
 * server refuses it (409); the controls are disabled so the rule is visible.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { DeckInvite, DeckPermission, InviteByEmailResult } from '../../api/client.js'
import { useAuth } from '../../state/AuthContext.js'
import type { DeckRole } from '../../state/DeckRoleContext.js'

/** What the section reads and changes — a deck's collaborators or a folder's members. */
export interface PeopleAccessAdapter {
  listPeople(): Promise<DeckPermission[]>
  invite(email: string, role: DeckRole): Promise<InviteByEmailResult>
  setRole(person: DeckPermission, role: DeckRole): Promise<void>
  remove(userId: string): Promise<void>
  listInvites(): Promise<DeckInvite[]>
  cancelInvite(inviteId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers shared with the dialogs
// ---------------------------------------------------------------------------

export function RoleSelect({
  value,
  onChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
}: {
  value: DeckRole
  onChange: (role: DeckRole) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
}) {
  return (
    <select
      id={id}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value as DeckRole)}
      disabled={disabled}
      className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
    >
      <option value="owner">Owner</option>
      <option value="editor">Editor</option>
      <option value="viewer">Viewer</option>
    </select>
  )
}

export function formatDate(iso: string | null): string {
  if (iso === null) return 'Never'
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Display initials for the avatar chip. Prefers name → email local-part →
 *  the first two chars of the sub (which we display only as a last resort). */
function initialsFor(perm: { name: string | null; email: string | null; userId: string }): string {
  if (perm.name && perm.name.length > 0) {
    const parts = perm.name.trim().split(/\s+/).slice(0, 2)
    return parts
      .map((p) => p[0]!)
      .join('')
      .toUpperCase()
  }
  if (perm.email) {
    const local = perm.email.split('@')[0] ?? perm.email
    return local.slice(0, 2).toUpperCase()
  }
  return perm.userId.slice(0, 2).toUpperCase()
}

/** Top label shown for a person. */
function primaryLabel(perm: { name: string | null; email: string | null; userId: string }): string {
  return perm.name ?? perm.email ?? perm.userId
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** The server's own words when it refused (ApiError), else `fallback`. */
function reason(err: unknown, fallback: string): string {
  return err instanceof ApiError && !/^HTTP \d+$/.test(err.message) ? err.message : fallback
}

function CrossIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// PeopleWithAccess
// ---------------------------------------------------------------------------

export function PeopleWithAccess({
  adapter,
  noun,
}: {
  adapter: PeopleAccessAdapter
  /** What is shared, in the hints: "deck" or "folder". */
  noun: 'deck' | 'folder'
}) {
  const { user: currentUser } = useAuth()
  const currentUserSub = currentUser?.sub ?? null
  const headingId = useId()
  const emailId = useId()
  const roleId = useId()

  const [people, setPeople] = useState<DeckPermission[]>([])
  const [peopleLoading, setPeopleLoading] = useState(true)
  const [peopleError, setPeopleError] = useState<string | null>(null)

  const [invites, setInvites] = useState<DeckInvite[]>([])
  const [invitesLoading, setInvitesLoading] = useState(true)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<DeckRole>('viewer')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteHint, setInviteHint] = useState<string | null>(null)

  const loadPeople = useCallback(async () => {
    setPeopleLoading(true)
    try {
      setPeople(await adapter.listPeople())
      setPeopleError(null)
    } catch {
      setPeopleError('Failed to load people with access.')
    } finally {
      setPeopleLoading(false)
    }
  }, [adapter])

  const loadInvites = useCallback(async () => {
    setInvitesLoading(true)
    try {
      setInvites(await adapter.listInvites())
    } catch {
      // Non-fatal — pending invites are a secondary concern; the people
      // list is the main source of truth.
    } finally {
      setInvitesLoading(false)
    }
  }, [adapter])

  useEffect(() => {
    void loadPeople()
    void loadInvites()
  }, [loadPeople, loadInvites])

  const handleRemove = async (userId: string) => {
    try {
      await adapter.remove(userId)
      setPeople((prev) => prev.filter((p) => p.userId !== userId))
    } catch (err) {
      setPeopleError(reason(err, 'Failed to remove user.'))
    }
  }

  const handleChangeRole = async (person: DeckPermission, newRole: DeckRole) => {
    try {
      await adapter.setRole(person, newRole)
      setPeople((prev) =>
        prev.map((p) => (p.userId === person.userId ? { ...p, role: newRole } : p)),
      )
    } catch (err) {
      setPeopleError(reason(err, 'Failed to change role.'))
    }
  }

  const handleInvite = async () => {
    const trimmed = inviteEmail.trim().toLowerCase()
    if (trimmed === '') return
    if (!EMAIL_RE.test(trimmed)) {
      setInviteError('Please enter a valid email address.')
      return
    }
    setInviting(true)
    setInviteError(null)
    setInviteHint(null)
    try {
      const result = await adapter.invite(trimmed, inviteRole)
      setInviteEmail('')
      if (result.kind === 'granted') {
        setInviteHint(`Granted ${result.user.email} ${result.user.role} access.`)
        await loadPeople()
      } else {
        setInviteHint(
          result.invite.replaced
            ? `Updated pending invite for ${result.invite.email}.`
            : `Invited ${result.invite.email}. They'll get the ${noun} after their first Google sign-in.`,
        )
        await loadInvites()
      }
    } catch (err) {
      const status =
        err instanceof ApiError
          ? err.status
          : err instanceof Error && 'status' in err
            ? (err as { status?: number }).status
            : undefined
      setInviteError(
        status === 400
          ? 'That email looks invalid.'
          : reason(err, 'Failed to invite — please retry.'),
      )
    } finally {
      setInviting(false)
    }
  }

  const handleCancelInvite = async (inviteId: string) => {
    try {
      await adapter.cancelInvite(inviteId)
      setInvites((prev) => prev.filter((i) => i.id !== inviteId))
    } catch {
      // Non-fatal
    }
  }

  const sortedPeople = useMemo(
    () =>
      [...people].sort((a, b) => {
        // Owners first, then editors, then viewers. Within a group, by name/email.
        const rolePriority = { owner: 0, editor: 1, viewer: 2 } as const
        const r = rolePriority[a.role] - rolePriority[b.role]
        if (r !== 0) return r
        return primaryLabel(a).localeCompare(primaryLabel(b))
      }),
    [people],
  )

  return (
    <section aria-labelledby={headingId}>
      <h3
        id={headingId}
        className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400"
      >
        People with access
      </h3>

      {peopleError !== null && <p className="mb-2 text-xs text-red-400">{peopleError}</p>}

      {peopleLoading ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : sortedPeople.length === 0 ? (
        <p className="text-xs text-gray-500">No explicit permissions yet.</p>
      ) : (
        <ul className="mb-3 space-y-2" role="list">
          {sortedPeople.map((perm) => {
            const isSelf = currentUserSub !== null && perm.userId === currentUserSub
            return (
              <li key={perm.userId} className="flex items-center gap-2">
                <div
                  aria-hidden="true"
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-700 text-xs font-medium text-gray-200"
                >
                  {initialsFor(perm)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-gray-200">
                    {primaryLabel(perm)}
                    {isSelf && (
                      <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                        you
                      </span>
                    )}
                  </p>
                  {perm.email && perm.name && (
                    <p className="truncate text-[11px] text-gray-500">{perm.email}</p>
                  )}
                </div>
                <RoleSelect
                  value={perm.role}
                  disabled={isSelf}
                  aria-label={`Role of ${primaryLabel(perm)}`}
                  onChange={(r) => void handleChangeRole(perm, r)}
                />
                <button
                  onClick={() => void handleRemove(perm.userId)}
                  disabled={isSelf}
                  aria-label={
                    isSelf ? 'You cannot remove yourself' : `Remove ${primaryLabel(perm)}`
                  }
                  title={
                    isSelf ? `Only another owner can remove you from this ${noun}.` : undefined
                  }
                  className="ml-1 rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-500 disabled:cursor-not-allowed"
                >
                  <CrossIcon />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {!invitesLoading && invites.length > 0 && (
        <>
          <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Pending invites
          </h3>
          <ul className="mb-3 space-y-2" role="list">
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-2">
                <div
                  aria-hidden="true"
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-gray-600 text-xs font-medium text-gray-400"
                >
                  {inv.email.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-gray-300">{inv.email}</p>
                  <p className="truncate text-[11px] text-gray-500">
                    Invited {formatDate(inv.invitedAt)} · expires {formatDate(inv.expiresAt)}
                  </p>
                </div>
                <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] font-medium capitalize text-gray-400">
                  {inv.role}
                </span>
                <button
                  onClick={() => void handleCancelInvite(inv.id)}
                  aria-label={`Cancel invite for ${inv.email}`}
                  className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                >
                  <CrossIcon />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mb-1 flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor={emailId} className="mb-1 block text-xs text-gray-500">
            Invite by email
          </label>
          <input
            id={emailId}
            type="email"
            autoComplete="email"
            value={inviteEmail}
            onChange={(e) => {
              setInviteEmail(e.target.value)
              setInviteError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleInvite()
            }}
            placeholder="name@example.com"
            className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <RoleSelect
          id={roleId}
          aria-label="Role for the invite"
          value={inviteRole}
          onChange={setInviteRole}
        />
        <button
          onClick={() => void handleInvite()}
          disabled={inviting || inviteEmail.trim() === ''}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
        >
          {inviting ? 'Inviting…' : 'Invite'}
        </button>
      </div>
      {inviteError !== null && <p className="mt-1 text-xs text-red-400">{inviteError}</p>}
      {inviteHint !== null && <p className="mt-1 text-xs text-green-400">{inviteHint}</p>}
    </section>
  )
}
