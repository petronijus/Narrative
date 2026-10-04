/**
 * ui/FolderShareDialog.tsx
 *
 * Share a folder (folder sharing, step 3 — docs/plans/folder-sharing.md):
 * its members and pending email invites. A member sees EVERYTHING in the
 * folder — every deck, component, picture, font and token — with their role;
 * to give someone a single deck, share that deck instead. Opened by the
 * folder's owners only (the server refuses everyone else); the Drafts folder
 * is never offered, and the server refuses it too.
 *
 * Uses the same "People with access" section as the deck's ShareDialog.
 */

import { useMemo } from 'react'
import { useApi } from '../api/client.js'
import { PeopleWithAccess, type PeopleAccessAdapter } from './sharing/PeopleWithAccess.js'
import { SharingDialogFrame } from './sharing/SharingDialogFrame.js'

export function FolderShareDialog({
  folderId,
  folderName,
  onClose,
}: {
  folderId: string
  folderName: string
  onClose: () => void
}) {
  const api = useApi()
  const members = useMemo<PeopleAccessAdapter>(
    () => ({
      listPeople: () => api.listFolderMembers(folderId),
      invite: (email, role) => api.inviteToFolder(folderId, { email, role }),
      setRole: (person, role) => api.setFolderMemberRole(folderId, person.userId, role),
      remove: (userId) => api.removeFolderMember(folderId, userId),
      listInvites: () => api.listFolderInvites(folderId),
      cancelInvite: (inviteId) => api.cancelFolderInvite(folderId, inviteId),
    }),
    [api, folderId],
  )

  return (
    <SharingDialogFrame title={`Share “${folderName}”`} onClose={onClose}>
      <p className="mb-5 text-xs leading-relaxed text-gray-400">
        Everyone here sees every deck, component, picture, font and token in this folder with their
        role. To give someone a single deck, share that deck from the editor instead.
      </p>
      <PeopleWithAccess adapter={members} noun="folder" />
    </SharingDialogFrame>
  )
}
