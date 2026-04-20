/**
 * ui/ShareDialog.tsx
 *
 * M10: Share dialog — manage deck permissions and share links.
 *
 * Features:
 * - List people with access (role, userId, revoke, change role)
 * - Invite by userId (Authentik sub claim; email lookup deferred to M21)
 * - Share links: list, create (role + optional expiry), copy URL, revoke
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
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useApi } from '../api/client.js'
import type { DeckPermission, ShareLink } from '../api/client.js'
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

// ---------------------------------------------------------------------------
// ShareDialog
// ---------------------------------------------------------------------------

export function ShareDialog({ deckId, onClose }: ShareDialogProps) {
  const api = useApi()

  // Permissions state
  const [permissions, setPermissions] = useState<DeckPermission[]>([])
  const [permLoading, setPermLoading] = useState(true)
  const [permError, setPermError] = useState<string | null>(null)

  // Invite form
  const [inviteUserId, setInviteUserId] = useState('')
  const [inviteRole, setInviteRole] = useState<DeckRole>('viewer')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

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
      setPermError('Failed to load permissions.')
    } finally {
      setPermLoading(false)
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
    void loadShareLinks()
  }, [loadPermissions, loadShareLinks])

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
  // Permission actions
  // ---------------------------------------------------------------------------

  const handleRevokePermission = async (userId: string) => {
    try {
      await api.revokePermission(deckId, userId)
      setPermissions((prev) => prev.filter((p) => p.userId !== userId))
    } catch {
      setPermError('Failed to remove user.')
    }
  }

  const handleChangeRole = async (userId: string, newRole: DeckRole) => {
    try {
      // Revoke existing then grant with new role (server API design)
      await api.revokePermission(deckId, userId)
      await api.grantPermission(deckId, { userId, role: newRole })
      setPermissions((prev) => prev.map((p) => (p.userId === userId ? { ...p, role: newRole } : p)))
    } catch {
      setPermError('Failed to change role.')
    }
  }

  const handleInvite = async () => {
    const trimmed = inviteUserId.trim()
    if (trimmed === '') return
    setInviting(true)
    setInviteError(null)
    try {
      await api.grantPermission(deckId, { userId: trimmed, role: inviteRole })
      setInviteUserId('')
      await loadPermissions()
    } catch {
      setInviteError('Failed to invite user. Make sure the user ID is correct.')
    } finally {
      setInviting(false)
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
  // Render
  // ---------------------------------------------------------------------------

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onKeyDown={handleKeyDown}
      aria-modal="true"
      role="dialog"
      aria-label="Share this deck"
    >
      {/* Dialog panel */}
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
          ) : permissions.length === 0 ? (
            <p className="text-xs text-gray-500">No explicit permissions yet.</p>
          ) : (
            <ul className="mb-3 space-y-2" role="list">
              {permissions.map((perm) => (
                <li key={perm.userId} className="flex items-center gap-2">
                  {/* Avatar chip */}
                  <div
                    aria-hidden="true"
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gray-700 text-xs font-medium text-gray-300"
                  >
                    {perm.userId.slice(0, 2).toUpperCase()}
                  </div>
                  <span
                    className="flex-1 truncate text-xs text-gray-300 font-mono"
                    title={perm.userId}
                  >
                    {perm.userId}
                  </span>
                  <RoleSelect
                    value={perm.role}
                    onChange={(r) => void handleChangeRole(perm.userId, r)}
                  />
                  <button
                    onClick={() => void handleRevokePermission(perm.userId)}
                    aria-label={`Remove ${perm.userId}`}
                    className="ml-1 rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
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
          )}

          {/* Invite row */}
          <div className="mb-1 flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="invite-user-id" className="mb-1 block text-xs text-gray-500">
                User ID (Authentik sub)
              </label>
              <input
                id="invite-user-id"
                type="text"
                value={inviteUserId}
                onChange={(e) => setInviteUserId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleInvite()
                }}
                placeholder="Paste user sub…"
                className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <RoleSelect id="invite-role" value={inviteRole} onChange={setInviteRole} />
            <button
              onClick={() => void handleInvite()}
              disabled={inviting || inviteUserId.trim() === ''}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
            >
              {inviting ? 'Inviting…' : 'Invite'}
            </button>
          </div>
          {inviteError !== null && <p className="text-xs text-red-400">{inviteError}</p>}
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

          {/* New share link created — show URL */}
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

          {/* Create link form */}
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
    </div>
  )
}
