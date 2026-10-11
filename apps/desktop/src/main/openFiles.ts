/**
 * main/openFiles.ts
 *
 * PowerPoint files the operating system opens with the app — a file
 * association, a drop on the Dock icon, File ▸ Import PowerPoint… — waiting
 * for the editor to import them (docs/plans/desktop-d0-spec.md §3.6). The
 * queue lives in the main process, so it survives a reload of the page. The
 * page sees a file's id, name and size, and reads its bytes in chunks; it
 * never sees a path. Every file is checked here first; the server's import
 * stays the authority on what a .pptx may contain.
 */

import { randomUUID } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { DESKTOP_OPEN_FILE_CHUNK, type DesktopOpenedFile } from '@narrative/shared'

/** The server's limit (apps/server/src/routes/pptxImport.ts MAX_PPTX_BYTES). */
export const MAX_OPEN_FILE_BYTES = 2 * 1024 * 1024 * 1024
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

interface Entry extends DesktopOpenedFile {
  path: string
  mtimeMs: number
}

export type EnqueueResult = { ok: true; file: DesktopOpenedFile } | { ok: false; reason: string }

/** Check a path the OS handed over; the reason a person can act on when it is refused. */
async function inspect(file: string): Promise<{ size: number; mtimeMs: number } | string> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.pptx') {
    return 'It is not a PowerPoint (.pptx) file.'
  }
  let stats
  try {
    stats = await lstat(file)
  } catch {
    return 'The file cannot be read.'
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return 'It is not a regular file.'
  if (stats.size < 1) return 'The file is empty.'
  if (stats.size > MAX_OPEN_FILE_BYTES) return 'The file is larger than 2 GB.'
  const handle = await open(file, 'r').catch(() => null)
  if (handle === null) return 'The file cannot be read.'
  try {
    const head = Buffer.alloc(4)
    await handle.read(head, 0, 4, 0)
    if (!head.equals(ZIP_MAGIC)) return 'It is not a PowerPoint (.pptx) file.'
  } finally {
    await handle.close()
  }
  return { size: stats.size, mtimeMs: stats.mtimeMs }
}

export class OpenedFiles {
  private readonly entries = new Map<string, Entry>()

  /** Check `file` and queue it. */
  async enqueue(file: string): Promise<EnqueueResult> {
    const checked = await inspect(file)
    if (typeof checked === 'string') return { ok: false, reason: checked }
    const entry: Entry = {
      id: randomUUID(),
      name: path.basename(file),
      size: checked.size,
      path: file,
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
   * A chunk of a waiting file. Refused when the id is unknown, the range is
   * outside the file or too long, or the file changed since it was queued.
   */
  async read(id: string, offset: number, length: number): Promise<Uint8Array> {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error('unknown_file')
    if (offset < 0 || length < 1 || length > DESKTOP_OPEN_FILE_CHUNK || offset >= entry.size) {
      throw new Error('bad_range')
    }
    const stats = await lstat(entry.path)
    if (!stats.isFile() || stats.size !== entry.size || stats.mtimeMs !== entry.mtimeMs) {
      throw new Error('file_changed')
    }
    const handle = await open(entry.path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(length, entry.size - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
    } finally {
      await handle.close()
    }
  }

  /** The page imported (or declined) the file. */
  consume(id: string): void {
    this.entries.delete(id)
  }

  private meta(e: Entry): DesktopOpenedFile {
    return { id: e.id, name: e.name, size: e.size }
  }
}
