/**
 * ui/ShareDialog.tsx
 *
 * Share dialog — manage deck collaborators and share links.
 *
 * Features (0.7.0):
 * - List collaborators (name + email + role; revoke, change role).
 * - Invite by email. If the email is already a Narrative user → instant grant.
 *   Otherwise → pending invite; the user gets the deck after their first login.
 * - List + cancel pending email invites.
 * - Share links: list, create (role + optional expiry), copy URL, revoke.
 *
 * Access control: rendered only when current user's role is 'owner'.
 * The parent (Toolbar) controls visibility; this dialog does not self-guard.
 *
 * Focus management: manual focus trap on open, Esc closes.
 * No headlessui dep added — simple overlay + ref-based trap.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useApi } from '../api/client.js'
import { useAuth } from '../state/AuthContext.js'
import type { DeckInvite, DeckPermission, ShareLink } from '../api/client.js'
import type { DeckRole } from '../state/DeckRoleContext.js'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ShareDialogProps {
  deckId: string
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function RoleSelect({
  value,
  onChange,
  disabled = false,
  id,
}: {
  value: DeckRole
  onChange: (role: DeckRole) => void
  disabled?: boolean
  id?: string
}) {
  return (
    <select
      id={id}
      value={value}
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

function formatDate(iso: string | null): string {
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

/** Top label shown for a collaborator. */
function primaryLabel(perm: { name: string | null; email: string | null; userId: string }): string {
  return perm.name ?? perm.email ?? perm.userId
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// ---------------------------------------------------------------------------
// ShareDialog
// ---------------------------------------------------------------------------

export function ShareDialog({ deckId, onClose }: ShareDialogProps) {
  const api = useApi()
  const { user: currentUser } = useAuth()
  const currentUserSub = currentUser?.sub ?? null

  // Permissions state
  const [permissions, setPermissions] = useState<DeckPermission[]>([])
  const [permLoading, setPermLoading] = useState(true)
  const [permError, setPermError] = useState<string | null>(null)

  // Pending invites state
  const [invites, setInvites] = useState<DeckInvite[]>([])
  const [invitesLoading, setInvitesLoading] = useState(true)

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<DeckRole>('viewer')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteHint, setInviteHint] = useState<string | null>(null)

  // Share links state
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([])
  const [linksLoading, setLinksLoading] = useState(true)
  const [linksError, setLinksError] = useState<string | null>(null)

  // New share link form
  const [newLinkRole, setNewLinkRole] = useState<DeckRole>('viewer')
  const [newLinkExpiry, setNewLinkExpiry] = useState('')
  const [creatingLink, setCreatingLink] = useState(false)
  const [newLinkUrl, setNewLinkUrl] = useState<string | null>(null)
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)

  // Focus trap
  const dialogRef = useRef<HTMLDivElement>(null)
  const initialFocusRef = useRef<HTMLButtonElement>(null)

  // ---------------------------------------------------------------------------
  // Load data
  // ---------------------------------------------------------------------------

  const loadPermissions = useCallback(async () => {
    setPermLoading(true)
    try {
      const data = await api.listPermissions(deckId)
      setPermissions(data)
      setPermError(null)
    } catch {
      setPermError('Failed to load people with access.')
    } finally {
      setPermLoading(false)
    }
  }, [api, deckId])

  const loadInvites = useCallback(async () => {
    setInvitesLoading(true)
    try {
      const data = await api.listInvites(deckId)
      setInvites(data)
    } catch {
      // Non-fatal — pending invites are a secondary concern; the
      // permissions list is the main source of truth.
    } finally {
      setInvitesLoading(false)
    }
  }, [api, deckId])

  const loadShareLinks = useCallback(async () => {
    setLinksLoading(true)
    try {
      const data = await api.listShareLinks(deckId)
      setShareLinks(data)
      setLinksError(null)
    } catch {
      setLinksError('Failed to load share links.')
    } finally {
      setLinksLoading(false)
    }
  }, [api, deckId])

  useEffect(() => {
    void loadPermissions()
    void loadInvites()
    void loadShareLinks()
  }, [loadPermissions, loadInvites, loadShareLinks])

  // Focus initial element on open
  useEffect(() => {
    initialFocusRef.current?.focus()
  }, [])

  // ---------------------------------------------------------------------------
  // Focus trap
  // ---------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return

      const dialog = dialogRef.current
      if (dialog === null) return

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'))

      if (focusable.length === 0) return

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  // ---------------------------------------------------------------------------
  // Permission + invite actions
  // ---------------------------------------------------------------------------

  const handleRevokePermission = async (userId: string) => {
    try {
      await api.revokePermission(deckId, userId)
      setPermissions((prev) => prev.filter((p) => p.userId !== userId))
    } catch {
      setPermError('Failed to remove user.')
    }
  }

  const handleChangeRole = async (perm: DeckPermission, newRole: DeckRole) => {
    // Need an email to drive the upsert by-email path. Should always exist
    // for post-migration rows; fall back gracefully when it doesn't.
    if (!perm.email) {
      setPermError(
        "Can't change this user's role — they pre-date the directory. Revoke + re-invite by email.",
      )
      return
    }
    try {
      const result = await api.inviteByEmail(deckId, { email: perm.email, role: newRole })
      if (result.kind === 'granted') {
        setPermissions((prev) =>
          prev.map((p) => (p.userId === perm.userId ? { ...p, role: newRole } : p)),
        )
      }
    } catch {
      setPermError('Failed to change role.')
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
      const result = await api.inviteByEmail(deckId, { email: trimmed, role: inviteRole })
      setInviteEmail('')
      if (result.kind === 'granted') {
        setInviteHint(`Granted ${result.user.email} ${result.user.role} access.`)
        await loadPermissions()
      } else {
        setInviteHint(
          result.invite.replaced
            ? `Updated pending invite for ${result.invite.email}.`
            : `Invited ${result.invite.email}. They'll get access after their first Google sign-in.`,
        )
        await loadInvites()
      }
    } catch (err) {
      const msg =
        err instanceof Error && 'status' in err && (err as { status?: number }).status === 400
          ? 'That email looks invalid.'
          : 'Failed to invite — please retry.'
      setInviteError(msg)
    } finally {
      setInviting(false)
    }
  }

  const handleRevokeInvite = async (inviteId: string) => {
    try {
      await api.revokeInvite(deckId, inviteId)
      setInvites((prev) => prev.filter((i) => i.id !== inviteId))
    } catch {
      // Non-fatal
    }
  }

  // ---------------------------------------------------------------------------
  // Share link actions
  // ---------------------------------------------------------------------------

  const handleCreateShareLink = async () => {
    setCreatingLink(true)
    setLinksError(null)
    try {
      const body: Parameters<typeof api.createShareLink>[1] = {
        role: newLinkRole,
        ...(newLinkExpiry !== '' ? { expiresAt: new Date(newLinkExpiry).toISOString() } : {}),
      }
      const created = await api.createShareLink(deckId, body)
      setNewLinkUrl(created.url)
      await loadShareLinks()
    } catch {
      setLinksError('Failed to create share link.')
    } finally {
      setCreatingLink(false)
    }
  }

  const handleRevokeShareLink = async (linkId: string) => {
    try {
      await api.revokeShareLink(deckId, linkId)
      setShareLinks((prev) => prev.filter((l) => l.id !== linkId))
      if (newLinkUrl !== null) setNewLinkUrl(null)
    } catch {
      setLinksError('Failed to revoke share link.')
    }
  }

  const handleCopy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedLinkId(id)
      setTimeout(() => setCopiedLinkId(null), 2000)
    })
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const sortedPermissions = useMemo(
    () =>
      [...permissions].sort((a, b) => {
        // Owners first, then editors, then viewers. Within a group, by name/email.
        const rolePriority = { owner: 0, editor: 1, viewer: 2 } as const
        const r = rolePriority[a.role] - rolePriority[b.role]
        if (r !== 0) return r
        return primaryLabel(a).localeCompare(primaryLabel(b))
      }),
    [permissions],
  )

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onKeyDown={handleKeyDown}
      aria-modal="true"
      role="dialog"
      aria-label="Share this deck"
    >
      <div
        ref={dialogRef}
        className="relative w-full max-w-lg rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-100">Share this deck</h2>
          <button
            ref={initialFocusRef}
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            <svg
              width="16"
              height="16"
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
          </button>
        </div>

        {/* People with access */}
        <section aria-labelledby="perm-heading">
          <h3
            id="perm-heading"
            className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400"
          >
            People with access
          </h3>

          {permError !== null && <p className="mb-2 text-xs text-red-400">{permError}</p>}

          {permLoading ? (
            <p className="text-xs text-gray-500">Loading…</p>
          ) : sortedPermissions.length === 0 ? (
            <p className="text-xs text-gray-500">No explicit permissions yet.</p>
          ) : (
            <ul className="mb-3 space-y-2" role="list">
              {sortedPermissions.map((perm) => {
                // You cannot change or remove your own role — only another
                // owner can. Server enforces this with a 409; the dialog
                // disables the controls so the rule is visible up front.
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
                      onChange={(r) => void handleChangeRole(perm, r)}
                    />
                    <button
                      onClick={() => void handleRevokePermission(perm.userId)}
                      disabled={isSelf}
                      aria-label={
                        isSelf ? 'You cannot remove yourself' : `Remove ${primaryLabel(perm)}`
                      }
                      title={
                        isSelf ? 'Only another owner can remove you from this deck.' : undefined
                      }
                      className="ml-1 rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-500 disabled:cursor-not-allowed"
                    >
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
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {/* Pending invites */}
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
                      onClick={() => void handleRevokeInvite(inv.id)}
                      aria-label={`Cancel invite for ${inv.email}`}
                      className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                    >
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
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Invite by email row */}
          <div className="mb-1 flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="invite-email" className="mb-1 block text-xs text-gray-500">
                Invite by email
              </label>
              <input
                id="invite-email"
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
            <RoleSelect id="invite-role" value={inviteRole} onChange={setInviteRole} />
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

        <hr className="my-5 border-gray-800" />

        {/* Share links */}
        <section aria-labelledby="links-heading">
          <h3
            id="links-heading"
            className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400"
          >
            Share links
          </h3>

          {linksError !== null && <p className="mb-2 text-xs text-red-400">{linksError}</p>}

          {linksLoading ? (
            <p className="text-xs text-gray-500">Loading…</p>
          ) : shareLinks.length === 0 ? (
            <p className="mb-3 text-xs text-gray-500">No active share links.</p>
          ) : (
            <ul className="mb-3 space-y-2" role="list">
              {shareLinks.map((link) => (
                <li
                  key={link.id}
                  className="flex items-center gap-2 rounded border border-gray-800 bg-gray-850 px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-gray-700 px-1.5 py-0.5 text-xs font-medium capitalize text-gray-300">
                        {link.role}
                      </span>
                      <span className="text-xs text-gray-500">
                        Expires: {formatDate(link.expiresAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-gray-500 font-mono">{link.url}</p>
                  </div>
                  <button
                    onClick={() => handleCopy(link.url, link.id)}
                    aria-label="Copy share link"
                    className="rounded p-1.5 text-gray-400 hover:bg-gray-700 hover:text-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                  >
                    {copiedLinkId === link.id ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="text-green-400"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={() => void handleRevokeShareLink(link.id)}
                    aria-label="Revoke share link"
                    className="rounded p-1.5 text-gray-500 hover:bg-gray-700 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {newLinkUrl !== null && (
            <div className="mb-3 flex items-center gap-2 rounded border border-green-800 bg-green-900/20 px-3 py-2">
              <p className="flex-1 truncate text-xs font-mono text-green-300">{newLinkUrl}</p>
              <button
                onClick={() => handleCopy(newLinkUrl, 'new')}
                aria-label="Copy new share link"
                className="rounded p-1 text-green-400 hover:bg-green-800/40"
              >
                {copiedLinkId === 'new' ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2v1" />
                  </svg>
                )}
              </button>
            </div>
          )}

          <div className="flex items-end gap-2">
            <div>
              <label htmlFor="new-link-role" className="mb-1 block text-xs text-gray-500">
                Role
              </label>
              <RoleSelect id="new-link-role" value={newLinkRole} onChange={setNewLinkRole} />
            </div>
            <div className="flex-1">
              <label htmlFor="new-link-expiry" className="mb-1 block text-xs text-gray-500">
                Expires (optional)
              </label>
              <input
                id="new-link-expiry"
                type="date"
                value={newLinkExpiry}
                onChange={(e) => setNewLinkExpiry(e.target.value)}
                className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={() => void handleCreateShareLink()}
              disabled={creatingLink}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
            >
              {creatingLink ? 'Creating…' : 'Create link'}
            </button>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  )
}
