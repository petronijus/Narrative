/**
 * main/openFiles.ts
 *
 * PowerPoint files the operating system opens with the app — a file
 * association, a drop on the Dock icon, File ▸ Import PowerPoint… — waiting
 * for the editor to import them (docs/plans/desktop-d0-spec.md §3.6). The
 * queue lives in the main process, so it survives a reload of the page. The
 * page sees a file's id, name and size, and reads its bytes in chunks; it
 * never sees a path.
 *
 * Each file is opened once, at once, without following a symbolic link, and
 * checked on that open descriptor, which is then kept until the page is done
 * with the file: swapping the path for a link to another file afterwards
 * changes nothing (security review of D0, L1). The server's import stays the
 * authority on what a .pptx may contain.
 */

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { DESKTOP_OPEN_FILE_CHUNK, type DesktopOpenedFile } from '@narrative/shared'

/** The server's limit (apps/server/src/routes/pptxImport.ts MAX_PPTX_BYTES). */
export const MAX_OPEN_FILE_BYTES = 2 * 1024 * 1024 * 1024
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
/** Windows has no O_NOFOLLOW; the lstat before the open is the check there. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

interface Entry extends DesktopOpenedFile {
  handle: FileHandle
  mtimeMs: number
}

export type EnqueueResult = { ok: true; file: DesktopOpenedFile } | { ok: false; reason: string }

const NOT_PPTX = 'It is not a PowerPoint (.pptx) file.'
const UNREADABLE = 'The file cannot be read.'

/** Open and check a path the OS handed over; the reason a person can act on when it is refused. */
async function openChecked(
  file: string,
): Promise<{ handle: FileHandle; size: number; mtimeMs: number } | string> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.pptx') return NOT_PPTX
  const link = await lstat(file).catch(() => null)
  if (link === null) return UNREADABLE
  if (link.isSymbolicLink() || !link.isFile()) return 'It is not a regular file.'
  let handle: FileHandle
  try {
    handle = await open(file, constants.O_RDONLY | NO_FOLLOW)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ELOOP'
      ? 'It is not a regular file.'
      : UNREADABLE
  }
  const refuse = async (reason: string): Promise<string> => {
    await handle.close()
    return reason
  }
  const stats = await handle.stat()
  if (!stats.isFile()) return refuse('It is not a regular file.')
  if (stats.size < 1) return refuse('The file is empty.')
  if (stats.size > MAX_OPEN_FILE_BYTES) return refuse('The file is larger than 2 GB.')
  const head = Buffer.alloc(4)
  await handle.read(head, 0, 4, 0)
  if (!head.equals(ZIP_MAGIC)) return refuse(NOT_PPTX)
  return { handle, size: stats.size, mtimeMs: stats.mtimeMs }
}

export class OpenedFiles {
  private readonly entries = new Map<string, Entry>()

  /** Check `file` and queue it. */
  async enqueue(file: string): Promise<EnqueueResult> {
    const checked = await openChecked(file)
    if (typeof checked === 'string') return { ok: false, reason: checked }
    const entry: Entry = {
      id: randomUUID(),
      name: path.basename(file),
      size: checked.size,
      handle: checked.handle,
      mtimeMs: checked.mtimeMs,
    }
    this.entries.set(entry.id, entry)
    return { ok: true, file: this.meta(entry) }
  }

  /** What the page may know of every waiting file. */
  waiting(): DesktopOpenedFile[] {
    return [...this.entries.values()].map((e) => this.meta(e))
  }

  /**
   * A chunk of a waiting file, from the descriptor opened when it was queued.
   * Refused when the id is unknown, the range is outside the file or too
   * long, or the file was changed since.
   */
  async read(id: string, offset: number, length: number): Promise<Uint8Array> {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error('unknown_file')
    if (offset < 0 || length < 1 || length > DESKTOP_OPEN_FILE_CHUNK || offset >= entry.size) {
      throw new Error('bad_range')
    }
    const stats = await entry.handle.stat()
    if (stats.size !== entry.size || stats.mtimeMs !== entry.mtimeMs)
      throw new Error('file_changed')
    const buffer = Buffer.alloc(Math.min(length, entry.size - offset))
    const { bytesRead } = await entry.handle.read(buffer, 0, buffer.length, offset)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
  }

  /** The page imported (or declined) the file. */
  consume(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    this.entries.delete(id)
    void entry.handle.close().catch(() => undefined)
  }

  /** Forget every waiting file (the shell moved to another server). */
  clear(): void {
    for (const id of [...this.entries.keys()]) this.consume(id)
  }

  private meta(e: Entry): DesktopOpenedFile {
    return { id: e.id, name: e.name, size: e.size }
  }
}
