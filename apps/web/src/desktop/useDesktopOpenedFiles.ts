/**
 * desktop/useDesktopOpenedFiles.ts
 *
 * Lets an import screen take the PowerPoint files the desktop app was asked
 * to open, one at a time: while `busy` (its import dialog is open) nothing is
 * taken; otherwise the oldest waiting file is read from the shell and handed
 * to `accept`, the same function a dropped file goes to, and the shell is
 * told it is done with it. Inert in a browser.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { desktopBridge } from './bridge.js'
import {
  consumeOpenedFile,
  openedFilesVersion,
  readOpenedFile,
  registerOpenedFileConsumer,
  subscribeOpenedFiles,
  takeOpenedFile,
} from './openedFiles.js'

export function useDesktopOpenedFiles(
  accept: (file: File) => void,
  busy: boolean,
  onError?: (message: string) => void,
): void {
  const acceptRef = useRef(accept)
  acceptRef.current = accept
  const errorRef = useRef(onError)
  errorRef.current = onError
  const reading = useRef(false)
  // Bumped when a read ends, so a file `accept` refuses (no dialog opens, so
  // `busy` never changes) does not stall the ones behind it.
  const [round, setRound] = useState(0)
  const version = useSyncExternalStore(subscribeOpenedFiles, openedFilesVersion, () => 0)

  useEffect(() => {
    if (desktopBridge() === undefined) return
    return registerOpenedFileConsumer()
  }, [])

  useEffect(() => {
    if (desktopBridge() === undefined || busy || reading.current) return
    const next = takeOpenedFile()
    if (next === null) return
    reading.current = true
    void readOpenedFile(next)
      .then((file) => acceptRef.current(file))
      .catch(() => errorRef.current?.(`“${next.name}” could not be read. Open it again.`))
      .finally(() => {
        consumeOpenedFile(next.id)
        reading.current = false
        setRound((r) => r + 1)
      })
  }, [busy, version, round])
}
