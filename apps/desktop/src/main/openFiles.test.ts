import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DESKTOP_OPEN_FILE_CHUNK } from '@narrative/shared'
import { OpenedFiles } from './openFiles.js'

let dir: string
const pptx = (name: string, body = 'rest of a zip'): string => {
  const file = path.join(dir, name)
  writeFileSync(file, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(body)]))
  return file
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'narrative-open-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('opened files', () => {
  it('queues a .pptx and hands out its name and size, never its path', async () => {
    const files = new OpenedFiles()
    const result = await files.enqueue(pptx('Quarterly review.PPTX'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toEqual({ id: result.file.id, name: 'Quarterly review.PPTX', size: 17 })
    expect(JSON.stringify(files.waiting())).not.toContain(dir)
  })

  it('reads chunks and refuses bad ranges', async () => {
    const files = new OpenedFiles()
    const result = await files.enqueue(pptx('a.pptx', 'abcdef'))
    if (!result.ok) throw new Error(result.reason)
    const { id } = result.file
    expect(Buffer.from(await files.read(id, 4, 3)).toString()).toBe('abc')
    expect(Buffer.from(await files.read(id, 8, 100)).toString()).toBe('ef')
    await expect(files.read(id, 10, 1)).rejects.toThrow('bad_range')
    await expect(files.read(id, 0, DESKTOP_OPEN_FILE_CHUNK + 1)).rejects.toThrow('bad_range')
    await expect(files.read('nope', 0, 1)).rejects.toThrow('unknown_file')
  })

  it('refuses a file that changed after it was queued', async () => {
    const files = new OpenedFiles()
    const file = pptx('a.pptx')
    const result = await files.enqueue(file)
    if (!result.ok) throw new Error(result.reason)
    utimesSync(file, new Date(), new Date(Date.now() + 60_000))
    await expect(files.read(result.file.id, 0, 4)).rejects.toThrow('file_changed')
  })

  it('reads the file it checked, even when the path is swapped for a link afterwards', async () => {
    const files = new OpenedFiles()
    const file = pptx('a.pptx', 'original')
    const result = await files.enqueue(file)
    if (!result.ok) throw new Error(result.reason)
    rmSync(file)
    writeFileSync(path.join(dir, 'secret'), 'PK\x03\x04secret!!')
    symlinkSync(path.join(dir, 'secret'), file)
    expect(Buffer.from(await files.read(result.file.id, 4, 8)).toString()).toBe('original')
  })

  it('forgets everything on clear', async () => {
    const files = new OpenedFiles()
    await files.enqueue(pptx('a.pptx'))
    await files.enqueue(pptx('b.pptx'))
    files.clear()
    expect(files.waiting()).toEqual([])
  })

  it('forgets a consumed file', async () => {
    const files = new OpenedFiles()
    const result = await files.enqueue(pptx('a.pptx'))
    if (!result.ok) throw new Error(result.reason)
    files.consume(result.file.id)
    expect(files.waiting()).toEqual([])
  })

  it('refuses what is not a regular, non-empty .pptx', async () => {
    const files = new OpenedFiles()
    const notZip = path.join(dir, 'fake.pptx')
    writeFileSync(notZip, 'MZ executable')
    const empty = path.join(dir, 'empty.pptx')
    writeFileSync(empty, '')
    const link = path.join(dir, 'link.pptx')
    symlinkSync(pptx('target.pptx'), link)
    const cases = [
      [notZip, 'It is not a PowerPoint (.pptx) file.'],
      [empty, 'The file is empty.'],
      [link, 'It is not a regular file.'],
      [pptx('slides.ppt'), 'It is not a PowerPoint (.pptx) file.'],
      ['relative.pptx', 'It is not a PowerPoint (.pptx) file.'],
      [path.join(dir, 'missing.pptx'), 'The file cannot be read.'],
    ] as const
    for (const [file, reason] of cases) {
      expect(await files.enqueue(file), file).toEqual({ ok: false, reason })
    }
    expect(files.waiting()).toEqual([])
  })
})
