/**
 * desktop/openedFiles.ts
 *
 * PowerPoint files the desktop app was asked to open (a file association, a
 * Dock drop, File ▸ Import PowerPoint…), on the page's side: a first-in,
 * first-out queue the import screen takes one file at a time from
 * (desktop/useDesktopOpenedFiles.ts) — the next only once the import dialog
 * of the previous one has closed, so several files are imported in turn and
 * none replaces another. The shell keeps the files themselves and announces
 * every unconsumed one again when the page subscribes, so an id the page has
 * already taken is ignored until the shell forgets it.
 */

import { DESKTOP_OPEN_FILE_CHUNK, type DesktopOpenedFile } from '@narrative/shared'
import { PPTX_MIME } from '../lib/pptxFiles.js'
import { desktopBridge } from './bridge.js'

const waiting: DesktopOpenedFile[] = []
/** Ids taken from the queue and not yet consumed: an announcement again is a repeat. */
const taken = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
let consumers = 0

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

/** The shell announced a file (again after a re-subscription: ignored then). */
export function enqueueOpenedFile(file: DesktopOpenedFile): void {
  if (taken.has(file.id) || waiting.some((f) => f.id === file.id)) return
  waiting.push(file)
  changed()
}

/** For useSyncExternalStore: the queue changed. */
export function subscribeOpenedFiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function openedFilesVersion(): number {
  return version
}

/** The oldest waiting file, now taken; null when none waits. */
export function takeOpenedFile(): DesktopOpenedFile | null {
  const next = waiting.shift() ?? null
  if (next !== null) taken.add(next.id)
  return next
}

/** Whether a screen that can import is mounted. */
export function hasOpenedFileConsumer(): boolean {
  return consumers > 0
}

/** A screen that imports opened files is mounted; returns the unregister. */
export function registerOpenedFileConsumer(): () => void {
  consumers++
  return () => {
    consumers--
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

/** Tell the shell the page is done with a file; it forgets it, and so does the page. */
export function consumeOpenedFile(id: string): void {
  desktopBridge()?.consumeOpenFile(id)
  taken.delete(id)
}

/** Tests only: start from an empty queue. */
export function resetOpenedFilesForTests(): void {
  waiting.length = 0
  taken.clear()
  consumers = 0
  changed()
}
