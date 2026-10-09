/**
 * services/binarySource.test.ts — turning an agent's file input into a file:
 * strict base64 (plain, base64url, data: URLs), the two limit tiers (bytes a
 * route received vs. URL / base64 fetched on the caller's behalf) checked
 * before decoding, URL downloads landing in a private temporary directory
 * that is always removed, the per-user limit of two URL downloads in flight
 * (a slot freed even when removing the directory fails), and URL failures
 * mapped to the right errors. The download itself is
 * net/ssrfGuard.ts (tested there against a real server); here it is mocked
 * with an implementation that writes the destination file like the real one.
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../net/ssrfGuard.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../net/ssrfGuard.js')>()
  return { ...original, guardedDownloadToFile: vi.fn() }
})
// The real temporary directories, wrapped so one test can make removal fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, mkdtempDisposable: vi.fn(original.mkdtempDisposable) }
})

const { guardedDownloadToFile, UnsafeUrlError, FetchFailedError } =
  await import('../net/ssrfGuard.js')
const { resolveBinarySource, withBinarySource, DOWNLOAD_TMP_PREFIX } =
  await import('./binarySource.js')
const { downloadsInFlight } = await import('./downloadSlots.js')
const { ServiceError } = await import('./errors.js')
const { serviceErrorOf } = await import('../test-support/serviceErrors.js')
const downloadMock = vi.mocked(guardedDownloadToFile)
const { mkdtempDisposable } = await import('node:fs/promises')
const { mkdtempDisposable: realMkdtempDisposable } =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const mkdtempMock = vi.mocked(mkdtempDisposable)

const USER = 'user-1'

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
  } catch (e) {
    if (e instanceof ServiceError) return e.status
    throw e
  }
  throw new Error('expected a ServiceError')
}

/** A download that writes `body` to the destination, like the real guard. */
function serves(
  body: Buffer,
  meta: { contentType?: string | null; filename?: string | null } = {},
) {
  return async (url: string, destination: string) => {
    await writeFile(destination, body)
    return {
      sizeBytes: body.byteLength,
      contentType: meta.contentType ?? null,
      filename: meta.filename ?? null,
      finalUrl: url,
      cacheControl: null,
    }
  }
}

/** The temporary directory of the n-th download call. */
function tmpDirOfCall(n = -1): string {
  const call = downloadMock.mock.calls.at(n)
  if (call === undefined) throw new Error('no download call')
  return path.dirname(call[1])
}

afterEach(() => {
  downloadMock.mockReset()
})

describe('resolveBinarySource: base64 and received bytes', () => {
  it('decodes base64, base64url and data: URLs, taking the data URL type as a hint', async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x7f])
    const opts = { userId: USER, maxBytes: 10 }
    const std = await resolveBinarySource({ kind: 'base64', data: bytes.toString('base64') }, opts)
    expect([...std.bytes]).toEqual([...bytes])
    const url = await resolveBinarySource(
      { kind: 'base64', data: bytes.toString('base64url') },
      opts,
    )
    expect([...url.bytes]).toEqual([...bytes])
    const dataUrl = await resolveBinarySource(
      {
        kind: 'base64',
        data: `data:image/png;base64,${bytes.toString('base64')}`,
        filename: 'a.png',
      },
      opts,
    )
    expect(dataUrl).toMatchObject({ mimeType: 'image/png', filename: 'a.png' })
    // An explicit hint wins over the data URL's.
    const hinted = await resolveBinarySource(
      {
        kind: 'base64',
        data: `data:image/png;base64,${bytes.toString('base64')}`,
        mimeType: 'Image/JPEG; q=1',
      },
      opts,
    )
    expect(hinted.mimeType).toBe('image/jpeg')
  })

  it('rejects malformed base64 and non-base64 data URLs with 400', async () => {
    const opts = { userId: USER, maxBytes: 10 }
    expect(await status(resolveBinarySource({ kind: 'base64', data: 'abc$%^' }, opts))).toBe(400)
    expect(
      await status(resolveBinarySource({ kind: 'base64', data: 'data:text/plain,hello' }, opts)),
    ).toBe(400)
    expect(await status(resolveBinarySource({ kind: 'base64', data: '====' }, opts))).toBe(400)
  })

  it('checks the size before decoding', async () => {
    const big = Buffer.alloc(2000).toString('base64')
    expect(
      await status(
        resolveBinarySource({ kind: 'base64', data: big }, { userId: USER, maxBytes: 1000 }),
      ),
    ).toBe(413)
    expect(
      await status(
        resolveBinarySource(
          { kind: 'bytes', bytes: new Uint8Array(11) },
          { userId: USER, maxBytes: 10 },
        ),
      ),
    ).toBe(413)
    const custom = await serviceErrorOf(
      resolveBinarySource(
        { kind: 'bytes', bytes: new Uint8Array(11) },
        { userId: USER, maxBytes: 10, tooLargeMessage: (n) => `too big: ${n}` },
      ),
    )
    expect(custom.message).toBe('too big: 11')
  })

  it('holds base64 to the remote limit and received bytes to the upload limit', async () => {
    const opts = { userId: USER, maxBytes: 100, maxRemoteBytes: 10 }
    // 20 bytes: over the remote limit as base64 …
    const b64 = await serviceErrorOf(
      resolveBinarySource({ kind: 'base64', data: Buffer.alloc(20, 1).toString('base64') }, opts),
    )
    expect(b64.status).toBe(413)
    expect(b64.message).toMatch(/tus upload/)
    // … but fine as bytes a route already received.
    const received = await resolveBinarySource(
      { kind: 'bytes', bytes: new Uint8Array(20).fill(1) },
      opts,
    )
    expect(received.bytes.byteLength).toBe(20)
  })

  it('rejects empty input', async () => {
    expect(
      await status(
        resolveBinarySource(
          { kind: 'bytes', bytes: new Uint8Array() },
          { userId: USER, maxBytes: 9 },
        ),
      ),
    ).toBe(400)
  })

  it('never takes a download slot for inline sources', async () => {
    await resolveBinarySource(
      { kind: 'base64', data: Buffer.from('x').toString('base64') },
      { userId: USER, maxBytes: 9 },
    )
    expect(downloadMock).not.toHaveBeenCalled()
    expect(downloadsInFlight(USER)).toBe(0)
  })
})

describe('withBinarySource: URL downloads', () => {
  it('downloads into a private temporary directory with the remote limit and deadline', async () => {
    downloadMock.mockImplementationOnce(
      serves(Buffer.from('hi'), { contentType: 'image/gif', filename: 'x.gif' }),
    )
    const out = await resolveBinarySource(
      { kind: 'url', url: 'https://example.com/x.gif' },
      { userId: USER, maxBytes: 9_999, maxRemoteBytes: 99, timeoutMs: 1234 },
    )
    expect(out).toMatchObject({ mimeType: 'image/gif', filename: 'x.gif' })
    expect(out.bytes.toString()).toBe('hi')
    const [url, destination, opts] = downloadMock.mock.calls[0]!
    expect(url).toBe('https://example.com/x.gif')
    expect(opts).toEqual({ maxBytes: 99, timeoutMs: 1234 })
    expect(path.dirname(path.dirname(destination))).toBe(path.resolve(os.tmpdir()))
    expect(path.basename(path.dirname(destination)).startsWith(DOWNLOAD_TMP_PREFIX)).toBe(true)
  })

  it('lets the callback stream and sniff the file, then removes the temporary directory', async () => {
    const body = Buffer.from('0123456789abcdef')
    downloadMock.mockImplementationOnce(serves(body))
    let dirDuringCallback = ''
    const result = await withBinarySource(
      { kind: 'url', url: 'https://example.com/f' },
      { userId: USER, maxBytes: 100 },
      async (file) => {
        dirDuringCallback = tmpDirOfCall()
        expect(existsSync(dirDuringCallback)).toBe(true)
        expect(file.sizeBytes).toBe(16)
        expect((await file.head(4)).toString()).toBe('0123')
        expect((await file.head(1000)).toString()).toBe(body.toString())
        const chunks: Buffer[] = []
        for await (const chunk of file.stream()) chunks.push(chunk as Buffer)
        return Buffer.concat(chunks).toString()
      },
    )
    expect(result).toBe(body.toString())
    expect(existsSync(dirDuringCallback)).toBe(false)
    expect(downloadsInFlight(USER)).toBe(0)
  })

  it('removes the temporary directory and frees the slot when the callback fails', async () => {
    downloadMock.mockImplementationOnce(serves(Buffer.from('data')))
    await expect(
      withBinarySource(
        { kind: 'url', url: 'https://example.com/f' },
        { userId: USER, maxBytes: 100 },
        async () => {
          throw new Error('consumer broke')
        },
      ),
    ).rejects.toThrow('consumer broke')
    expect(existsSync(tmpDirOfCall())).toBe(false)
    expect(downloadsInFlight(USER)).toBe(0)
  })

  it('answers 413 when the cap trips mid-stream, and removes the partial file', async () => {
    downloadMock.mockImplementationOnce(async (_url, destination) => {
      await writeFile(destination, Buffer.alloc(50))
      throw new FetchFailedError('the file is larger than the limit of 50 bytes', {
        tooLarge: true,
      })
    })
    const err = await serviceErrorOf(
      resolveBinarySource(
        { kind: 'url', url: 'https://example.com/huge' },
        { userId: USER, maxBytes: 50 },
      ),
    )
    expect(err.status).toBe(413)
    expect(err.message).toMatch(/tus upload/)
    expect(existsSync(tmpDirOfCall())).toBe(false)
    expect(downloadsInFlight(USER)).toBe(0)
  })

  it('maps guard refusals to 400, empty bodies to 400 and failures to 502', async () => {
    const opts = { userId: USER, maxBytes: 9 }
    const src = { kind: 'url' as const, url: 'http://x.test/' }
    downloadMock.mockRejectedValueOnce(new UnsafeUrlError('address 10.0.0.1 is not public'))
    expect(await status(resolveBinarySource(src, opts))).toBe(400)
    downloadMock.mockImplementationOnce(serves(Buffer.alloc(0)))
    expect(await status(resolveBinarySource(src, opts))).toBe(400)
    downloadMock.mockRejectedValueOnce(new FetchFailedError('the server answered HTTP 500'))
    expect(await status(resolveBinarySource(src, opts))).toBe(502)
    expect(downloadsInFlight(USER)).toBe(0)
  })

  it('allows two URL downloads per user at once and refuses a third with 409', async () => {
    const gates: Array<() => void> = []
    downloadMock.mockImplementation(async (url, destination) => {
      await new Promise<void>((resolve) => gates.push(resolve))
      return serves(Buffer.from('ok'))(url, destination)
    })
    const opts = { userId: USER, maxBytes: 9 }
    const src = { kind: 'url' as const, url: 'https://example.com/a' }

    const first = resolveBinarySource(src, opts)
    const second = resolveBinarySource(src, opts)
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(downloadsInFlight(USER)).toBe(2)

    const third = await serviceErrorOf(resolveBinarySource(src, opts))
    expect(third.status).toBe(409)
    expect(third.code).toBe('conflict')
    expect(third.message).toMatch(/another download is in progress/)
    // The refused request never started a download or left a directory.
    expect(downloadMock).toHaveBeenCalledTimes(2)

    // Another user is not affected.
    const other = resolveBinarySource(src, { ...opts, userId: 'user-2' })
    await vi.waitFor(() => expect(gates).toHaveLength(3))

    gates.forEach((open) => open())
    await expect(first).resolves.toMatchObject({ bytes: Buffer.from('ok') })
    await expect(second).resolves.toMatchObject({ bytes: Buffer.from('ok') })
    await expect(other).resolves.toMatchObject({ bytes: Buffer.from('ok') })
    expect(downloadsInFlight(USER)).toBe(0)

    // Slots are free again: a new download starts.
    downloadMock.mockReset()
    downloadMock.mockImplementationOnce(serves(Buffer.from('again')))
    await expect(resolveBinarySource(src, opts)).resolves.toMatchObject({
      bytes: Buffer.from('again'),
    })
  })

  it('frees the slot even when removing the temporary directory fails', async () => {
    let tmpDir = ''
    mkdtempMock.mockImplementationOnce(async (prefix, options) => {
      const dir = await realMkdtempDisposable(prefix, options)
      tmpDir = dir.path
      return {
        path: dir.path,
        remove: dir.remove,
        async [Symbol.asyncDispose]() {
          await dir.remove()
          throw new Error('EBUSY: resource busy or locked')
        },
      }
    })
    downloadMock.mockImplementationOnce(serves(Buffer.from('data')))
    await expect(
      resolveBinarySource(
        { kind: 'url', url: 'https://example.com/f' },
        { userId: USER, maxBytes: 100 },
      ),
    ).rejects.toThrow('EBUSY')
    expect(existsSync(tmpDir)).toBe(false)
    expect(downloadsInFlight(USER)).toBe(0)
  })

  it('frees the slot of a failed download', async () => {
    const opts = { userId: USER, maxBytes: 9 }
    const src = { kind: 'url' as const, url: 'https://example.com/a' }
    downloadMock.mockRejectedValue(new FetchFailedError('the download failed'))
    for (let i = 0; i < 3; i++) {
      expect(await status(resolveBinarySource(src, opts))).toBe(502)
    }
    expect(downloadsInFlight(USER)).toBe(0)
  })
})
