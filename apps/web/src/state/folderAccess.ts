/**
 * state/folderAccess.ts — what the signed-in user may do in a folder, from
 * the `FolderSummary` the folder list returns (folder sharing,
 * docs/plans/folder-sharing.md): viewer looks and presents, editor also
 * changes the folder's decks, components, tokens and fonts, owner also
 * renames, shares and deletes it. The server enforces all of it; the pages
 * use these to show only the controls that will work.
 */

import { useEffect, useState } from 'react'
import { useApi, type FolderSummary } from '../api/client.js'

/** The user's own Drafts folder (marked by the server, whatever its name). */
export function isOwnDrafts(folder: FolderSummary): boolean {
  return folder.isDrafts
}

/** Whether the user may change what is in the folder (editor or owner). */
export function canEditFolder(folder: FolderSummary): boolean {
  return folder.role !== 'viewer'
}

/** "Shared by Jana" — the person who shared the folder, by name or email; null for your own. */
export function sharedByLabel(folder: FolderSummary): string | null {
  if (folder.sharedBy === null) return null
  return `Shared by ${folder.sharedBy.name ?? folder.sharedBy.email ?? 'someone'}`
}

/**
 * The folder as the folder list describes it to this user — `undefined`
 * while loading, `null` when the user is not a member (or it does not exist).
 */
export function useFolderSummary(folderId: string | undefined): FolderSummary | null | undefined {
  const api = useApi()
  // The answer carries the folder it is for, so a change of `folderId` never
  // shows the previous folder's role while the new one loads.
  const [answer, setAnswer] = useState<{ folderId: string; folder: FolderSummary | null } | null>(
    null,
  )
  useEffect(() => {
    if (folderId === undefined) return
    let cancelled = false
    api
      .listFolders()
      .then((folders) => {
        if (!cancelled)
          setAnswer({ folderId, folder: folders.find((f) => f.id === folderId) ?? null })
      })
      .catch(() => {
        if (!cancelled) setAnswer({ folderId, folder: null })
      })
    return () => {
      cancelled = true
    }
  }, [api, folderId])
  if (folderId === undefined) return null
  return answer?.folderId === folderId ? answer.folder : undefined
}
