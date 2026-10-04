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
 * The people part and the modal frame are shared with the folder's sharing
 * dialog (ui/sharing/: PeopleWithAccess, SharingDialogFrame).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, useApi } from '../api/client.js'
import type { ShareLink } from '../api/client.js'
import type { DeckRole } from '../state/DeckRoleContext.js'
import { PeopleWithAccess, RoleSelect, formatDate } from './sharing/PeopleWithAccess.js'
import type { PeopleAccessAdapter } from './sharing/PeopleWithAccess.js'
import { SharingDialogFrame } from './sharing/SharingDialogFrame.js'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ShareDialogProps {
  deckId: string
  onClose: () => void
}

// ---------------------------------------------------------------------------
// ShareDialog
// ---------------------------------------------------------------------------

export function ShareDialog({ deckId, onClose }: ShareDialogProps) {
  const api = useApi()

  // The deck's collaborators, for the shared "People with access" section.
  // A role change goes through the invite-by-email upsert (POST
  // /decks/:id/permissions), so it needs the collaborator's email.
  const people = useMemo<PeopleAccessAdapter>(
    () => ({
      listPeople: () => api.listPermissions(deckId),
      invite: (email, role) => api.inviteByEmail(deckId, { email, role }),
      setRole: async (person, role) => {
        if (!person.email) {
          throw new ApiError(
            409,
            "Can't change this user's role — they pre-date the directory. Revoke + re-invite by email.",
          )
        }
        await api.inviteByEmail(deckId, { email: person.email, role })
      },
      remove: (userId) => api.revokePermission(deckId, userId),
      listInvites: () => api.listInvites(deckId),
      cancelInvite: (inviteId) => api.revokeInvite(deckId, inviteId),
    }),
    [api, deckId],
  )

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
    void loadShareLinks()
  }, [loadShareLinks])

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
    <SharingDialogFrame title="Share this deck" onClose={onClose}>
      <PeopleWithAccess adapter={people} noun="deck" />

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
    </SharingDialogFrame>
  )
}
