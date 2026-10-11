/**
 * desktop/useDesktopOpenedFiles.ts
 *
 * Lets an import screen take the PowerPoint files the desktop app was asked
 * to open: each one is read from the shell and handed to `accept`, the same
 * function a dropped file goes to. Inert in a browser.
 */

import { useEffect, useRef } from 'react'
import { desktopBridge } from './bridge.js'
import { consumeOpenedFile, readOpenedFile, registerOpenedFileConsumer } from './openedFiles.js'

export function useDesktopOpenedFiles(
  accept: (file: File) => void,
  onError?: (message: string) => void,
): void {
  const acceptRef = useRef(accept)
  acceptRef.current = accept
  const errorRef = useRef(onError)
  errorRef.current = onError

  useEffect(() => {
    if (desktopBridge() === undefined) return
    return registerOpenedFileConsumer((meta) => {
      void readOpenedFile(meta)
        .then((file) => acceptRef.current(file))
        .catch(() => errorRef.current?.(`“${meta.name}” could not be read. Open it again.`))
        .finally(() => consumeOpenedFile(meta.id))
    })
  }, [])
}
