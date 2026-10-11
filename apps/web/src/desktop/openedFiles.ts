/**
 * desktop/openedFiles.ts
 *
 * PowerPoint files the desktop app was asked to open (a file association, a
 * Dock drop, File ▸ Import PowerPoint…), on the page's side: a queue the
 * import screen drains once it is mounted (desktop/useDesktopOpenedFiles.ts).
 * The shell keeps the files themselves; the page reads them in chunks into a
 * `File`, which then goes through the same import as a dropped file.
 */

import { DESKTOP_OPEN_FILE_CHUNK, type DesktopOpenedFile } from '@narrative/shared'
import { PPTX_MIME } from '../lib/pptxFiles.js'
import { desktopBridge } from './bridge.js'

type Consumer = (file: DesktopOpenedFile) => void

const waiting = new Map<string, DesktopOpenedFile>()
let consumer: Consumer | null = null

/** The shell announced a file (again after a reload: ids make it idempotent). */
export function enqueueOpenedFile(file: DesktopOpenedFile): void {
  if (waiting.has(file.id)) return
  waiting.set(file.id, file)
  if (consumer !== null) drain()
}

/** Whether a screen that can import is mounted. */
export function hasOpenedFileConsumer(): boolean {
  return consumer !== null
}

/** Become the screen that imports opened files; returns the unregister. */
export function registerOpenedFileConsumer(next: Consumer): () => void {
  consumer = next
  drain()
  return () => {
    if (consumer === next) consumer = null
  }
}

function drain(): void {
  const take = consumer
  if (take === null) return
  for (const file of [...waiting.values()]) {
    waiting.delete(file.id)
    take(file)
  }
}

/** Read a waiting file from the shell into a `File` (as a dropped .pptx would arrive). */
export async function readOpenedFile(meta: DesktopOpenedFile): Promise<File> {
  const bridge = desktopBridge()
  if (bridge === undefined) throw new Error('not in the desktop app')
  const parts: Uint8Array[] = []
  for (let offset = 0; offset < meta.size; offset += DESKTOP_OPEN_FILE_CHUNK) {
    parts.push(await bridge.readOpenFile(meta.id, offset, DESKTOP_OPEN_FILE_CHUNK))
  }
  return new File(parts as BlobPart[], meta.name, { type: PPTX_MIME })
}

/** Tell the shell the page is done with a file. */
export function consumeOpenedFile(id: string): void {
  desktopBridge()?.consumeOpenFile(id)
}
