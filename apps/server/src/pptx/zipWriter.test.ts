/**
 * pptx/zipWriter.test.ts — the streamed package reads back as what JSZip
 * wrote (the format PowerPoint opens), with ZIP64 where the classic fields
 * end, and refuses a source that does not match its plan.
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { crc32 } from 'node:zlib'
import JSZip from 'jszip'
import { deflatedEntry, planZip, storedEntry, type ZipEntry } from './zipWriter.js'

const date = new Date(Date.UTC(2026, 9, 19, 10, 30, 42))

async function collect(plan: ReturnType<typeof planZip>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const c of plan.chunks()) chunks.push(c)
  return Buffer.concat(chunks)
}

/** A streamed STORE entry over `bytes`, cut into small chunks. */
function streamed(name: string, bytes: Buffer, lie?: Buffer): ZipEntry {
  return {
    name,
    method: 0,
    crc: crc32(bytes),
    size: bytes.byteLength,
    compressedSize: bytes.byteLength,
    data: async () =>
      (async function* () {
        const out = lie ?? bytes
        for (let i = 0; i < out.byteLength; i += 7) yield out.subarray(i, i + 7)
      })(),
  }
}

async function sample(): Promise<ZipEntry[]> {
  const media = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 31) % 256))
  return [
    await deflatedEntry('ppt/slides/slide1.xml', '<p:sld>' + 'x'.repeat(5000) + '</p:sld>'),
    storedEntry('ppt/media/image1.png', Buffer.from('not really a png')),
    streamed('ppt/media/media2.mp4', media),
    await deflatedEntry('[Content_Types].xml', '<Types/>'),
    await deflatedEntry('docProps/ünïcode.xml', '<x/>'),
  ]
}

describe('planZip', () => {
  it('writes exactly its planned size, read back by JSZip entry by entry as JSZip wrote them', async () => {
    const entries = await sample()
    const plan = planZip(entries, { date })
    const bytes = await collect(plan)
    expect(bytes.byteLength).toBe(plan.size)

    const ours = await JSZip.loadAsync(bytes)
    const reference = new JSZip()
    for (const e of entries) {
      const content =
        e.data instanceof Uint8Array && e.method === 0
          ? e.data
          : Buffer.from(await ours.file(e.name)!.async('uint8array'))
      reference.file(e.name, content, { date, createFolders: false })
    }
    const theirs = await JSZip.loadAsync(
      await reference.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    )
    // Same names in the same order, same contents and dates.
    expect(Object.keys(ours.files)).toEqual(Object.keys(theirs.files))
    for (const name of Object.keys(theirs.files)) {
      const a = ours.files[name]!
      const b = theirs.files[name]!
      expect(Buffer.from(await a.async('uint8array'))).toEqual(
        Buffer.from(await b.async('uint8array')),
      )
      expect(a.date.getTime()).toBe(b.date.getTime())
    }
    // No data descriptors: bit 3 is clear in every local header.
    let at = 0
    for (const e of plan.entries) {
      expect(bytes.readUInt32LE(at)).toBe(0x04034b50)
      expect(bytes.readUInt16LE(at + 6) & 0x0008).toBe(0)
      expect(bytes.readUInt32LE(at + 14)).toBe(e.crc >>> 0)
      at += 30 + Buffer.byteLength(e.name) + e.compressedSize
    }
  })

  it('passes a strict reader (Python zipfile CRC checks), and with ZIP64 where the classic fields end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zipwriter-'))
    try {
      for (const limits of [undefined, { u32: 100, u16: 2 }]) {
        const entries = await sample()
        const plan = planZip(entries, { date, ...(limits !== undefined ? { limits } : {}) })
        const bytes = await collect(plan)
        const file = join(dir, `${limits === undefined ? 'classic' : 'zip64'}.zip`)
        writeFileSync(file, bytes)
        const script =
          'import sys, zipfile, json\n' +
          'z = zipfile.ZipFile(sys.argv[1])\n' +
          'bad = z.testzip()\n' +
          'print(json.dumps({"bad": bad, "names": z.namelist(),' +
          ' "z64": [i.extract_version for i in z.infolist()]}))\n'
        const out = JSON.parse(
          execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' }),
        ) as { bad: string | null; names: string[]; z64: number[] }
        expect(out.bad).toBeNull()
        expect(out.names).toEqual(entries.map((e) => e.name))
        if (limits !== undefined) {
          // The record and locator before the end record.
          expect(bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBeGreaterThan(0)
          expect(out.z64).toContain(45)
          const zip = await JSZip.loadAsync(readFileSync(file))
          expect(Object.keys(zip.files)).toEqual(entries.map((e) => e.name))
        } else {
          expect(bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(-1)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails the write when a streamed source is not what the plan said', async () => {
    const good = Buffer.from('a'.repeat(100))
    for (const lie of [Buffer.from('b'.repeat(100)), Buffer.from('a'.repeat(99))]) {
      const plan = planZip([streamed('m.bin', good, lie)], { date })
      await expect(collect(plan)).rejects.toThrow(/changed while the package was written/)
    }
  })

  it('streams into a destination with backpressure, and refuses duplicate names', async () => {
    const plan = planZip(await sample(), { date })
    const chunks: Buffer[] = []
    await plan.writeTo(
      new Writable({
        highWaterMark: 16,
        write(chunk: Buffer, _e, done) {
          chunks.push(chunk)
          setImmediate(done)
        },
      }),
    )
    expect(Buffer.concat(chunks).byteLength).toBe(plan.size)
    const e = storedEntry('a', Buffer.from('x'))
    expect(() => planZip([e, e], { date })).toThrow(/duplicate/)
  })

  it('clamps a date DOS cannot hold', async () => {
    const plan = planZip([storedEntry('a', Buffer.from('x'))], { date: new Date(0) })
    const zip = await JSZip.loadAsync(await collect(plan))
    expect(zip.files['a']!.date.getUTCFullYear()).toBe(1980)
  })
})

describe('planZip read-ahead', () => {
  /** Three streamed 1000-byte entries that record when each source is opened. */
  function recorded(): { entries: ZipEntry[]; openedAt: Map<string, number>; at: { n: number } } {
    const at = { n: 0 }
    const openedAt = new Map<string, number>()
    const entries = ['a', 'b', 'c'].map((name) => {
      const bytes = Buffer.alloc(1000, name.charCodeAt(0))
      const entry = streamed(name, bytes)
      const open = entry.data as () => Promise<AsyncIterable<Uint8Array>>
      return {
        ...entry,
        data: async () => {
          openedAt.set(name, at.n)
          return open()
        },
      }
    })
    return { entries, openedAt, at }
  }

  async function drain(
    plan: ReturnType<typeof planZip>,
    at: { n: number },
    opts: Parameters<ReturnType<typeof planZip>['chunks']>[0],
  ): Promise<Buffer> {
    const out: Uint8Array[] = []
    for await (const c of plan.chunks(opts)) {
      out.push(c)
      at.n += c.byteLength
    }
    return Buffer.concat(out)
  }

  it('opens the next source only once the write is near its data', async () => {
    const { entries, openedAt, at } = recorded()
    const plan = planZip(entries, { date })
    const bytes = await drain(plan, at, { readAhead: 4, readAheadBytes: 100 })
    // Each local header is 31 bytes (30 + a one-letter name): b's data starts
    // at 31 + 1000 + 31, c's at 2 × 1031 + 31.
    expect(openedAt.get('a')).toBe(31)
    expect(openedAt.get('b')).toBeGreaterThanOrEqual(1062 - 100)
    expect(openedAt.get('b')).toBeLessThan(1031)
    expect(openedAt.get('c')).toBeGreaterThanOrEqual(2093 - 100)
    expect(openedAt.get('c')).toBeLessThan(2062)
    // The same archive as opened all at once.
    const eager = recorded()
    expect(await drain(planZip(eager.entries, { date }), eager.at, { readAhead: 4 })).toEqual(bytes)
  })

  it('opens at most readAhead sources ahead, and none with 0', async () => {
    const one = recorded()
    await drain(planZip(one.entries, { date }), one.at, {
      readAhead: 1,
      readAheadBytes: 1_000_000,
    })
    // b with a (one ahead), c only once b is being written.
    expect(one.openedAt.get('b')).toBe(31)
    expect(one.openedAt.get('c')).toBeGreaterThanOrEqual(1031)

    const none = recorded()
    await drain(planZip(none.entries, { date }), none.at, { readAhead: 0 })
    expect(none.openedAt.get('b')).toBe(1031 + 31)
    expect(none.openedAt.get('c')).toBe(2 * 1031 + 31)
  })
})
