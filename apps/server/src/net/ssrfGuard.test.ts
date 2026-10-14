/**
 * net/ssrfGuard.test.ts — the SSRF guard: the address policy over the
 * special-purpose ranges (IPv4, IPv6, IPv4-mapped / embedded), and the
 * guarded fetch's per-hop checks (scheme, credentials, port, DNS answers,
 * redirects, DNS-rebinding pinning, size caps) against a local server.
 *
 * The local server listens on 127.0.0.1, which the real policy refuses; the
 * fetch tests therefore inject a policy that admits exactly that address and
 * a resolver that maps test host names — the pinning and redirect logic
 * under test is the production code path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  FetchFailedError,
  UnsafeUrlError,
  embeddedIPv4s,
  guardedDownloadToFile,
  guardedFetch,
  isPublicAddress,
  type GuardedFetchOptions,
  type ResolvedAddress,
} from './ssrfGuard.js'

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1', // CGNAT / Tailscale
    '100.127.255.254',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.147', // TEST-NET-1
    '192.88.99.1',
    '192.168.1.50',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
  ])('refuses IPv4 %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false)
  })

  it.each([
    '::',
    '::1',
    '[::1]',
    '::127.0.0.1', // IPv4-compatible (deprecated)
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // the same, hex form
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe', // mapped 169.254.169.254
    '64:ff9b::a9fe:a9fe', // NAT64 of the metadata address
    '64:ff9b:1::1',
    '100::1',
    '2001::1', // Teredo
    '2001:db8::1',
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'ff02::1',
  ])('refuses IPv6 %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false)
  })

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '192.169.0.1'])(
    'admits public IPv4 %s',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true)
    },
  )

  it.each(['2606:4700:4700::1111', '2a00:1450:4001:82a::200e', '::ffff:8.8.8.8'])(
    'admits public IPv6 %s',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true)
    },
  )

  it('refuses things that are not addresses', () => {
    expect(isPublicAddress('1:2:3:4:5:6:7:8::')).toBe(false)
    expect(isPublicAddress('localhost')).toBe(false)
    expect(isPublicAddress('')).toBe(false)
    expect(isPublicAddress('999.1.1.1')).toBe(false)
  })
})

describe('IPv4 embedded in IPv6 (L1)', () => {
  it.each([
    // IPv4-translated (::ffff:0:0:0/96): was admitted before L1.
    ['::ffff:0:127.0.0.1', '127.0.0.1'],
    ['::ffff:0:7f00:1', '127.0.0.1'],
    ['::ffff:0:10.1.2.3', '10.1.2.3'],
    ['::ffff:0:a9fe:a9fe', '169.254.169.254'],
    ['0:0:0:0:ffff:0:c0a8:1', '192.168.0.1'],
    // IPv4-mapped, dotted and hex.
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::FFFF:7F00:1', '127.0.0.1'],
    ['0:0:0:0:0:ffff:100.64.0.1', '100.64.0.1'],
    // IPv4-compatible.
    ['::10.0.0.1', '10.0.0.1'],
    // NAT64 well-known and local-use (/48 layout: octets 3–4 after the u octet).
    ['64:ff9b::127.0.0.1', '127.0.0.1'],
    ['64:ff9b:1:a9fe:a9:fe00::', '169.254.169.254'],
    // 6to4.
    ['2002:c0a8:101::1', '192.168.1.1'],
    // Teredo: server IPv4 in bits 32–63, client IPv4 inverted in the last 32 bits.
    ['2001:0:a00:1::', '10.0.0.1'],
    ['2001:0:808:808:0:0:80ff:fffe', '127.0.0.1'],
  ])('decodes %s as carrying %s, and refuses it', (ip, v4) => {
    expect(embeddedIPv4s(ip)).toContain(v4)
    expect(isPublicAddress(ip)).toBe(false)
    expect(isPublicAddress(`[${ip}]`)).toBe(false)
  })

  it.each([
    ['::ffff:8.8.8.8', '8.8.8.8'],
    ['::ffff:808:808', '8.8.8.8'],
    ['::ffff:0:8.8.8.8', '8.8.8.8'],
    ['::ffff:0:101:101', '1.1.1.1'],
  ])('admits %s: the prefix is permitted and the embedded %s is public', (ip, v4) => {
    expect(embeddedIPv4s(ip)).toEqual([v4])
    expect(isPublicAddress(ip)).toBe(true)
  })

  it.each([
    ['::8.8.8.8', '8.8.8.8'], // IPv4-compatible (deprecated)
    ['64:ff9b::808:808', '8.8.8.8'], // NAT64
    ['64:ff9b:1:808:8:800::', '8.8.8.8'], // local-use NAT64
    ['2002:808:808::1', '8.8.8.8'], // 6to4
    ['2001:0:808:808:0:0:f7f7:f7f7', '8.8.8.8'], // Teredo, public server and client
  ])('keeps refusing %s: the transition prefix is blocked even with a public %s', (ip, v4) => {
    expect(embeddedIPv4s(ip)).toContain(v4)
    expect(isPublicAddress(ip)).toBe(false)
  })

  it('finds no IPv4 in native IPv6 addresses', () => {
    expect(embeddedIPv4s('2606:4700:4700::1111')).toEqual([])
    expect(embeddedIPv4s('2a00:1450:4001:82a::200e')).toEqual([])
  })
})

describe('guardedFetch', () => {
  let server: http.Server
  let port = 0
  const hits: Array<{ url: string; host: string | undefined; accept?: string | undefined }> = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push({ url: req.url ?? '', host: req.headers.host, accept: req.headers.accept })
      const url = new URL(req.url ?? '/', 'http://x')
      switch (url.pathname) {
        case '/file.png':
          res.writeHead(200, {
            'Content-Type': 'image/png; charset=binary',
            'Content-Disposition': 'attachment; filename="logo.png"',
            'Cache-Control': 'public, max-age=60',
          })
          res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
          return
        case '/big':
          res.writeHead(200, { 'Content-Length': '1000' })
          res.end(Buffer.alloc(1000))
          return
        case '/stream': {
          // No Content-Length: the cap has to trip while streaming.
          res.writeHead(200)
          res.write(Buffer.alloc(600))
          res.end(Buffer.alloc(600))
          return
        }
        case '/redirect':
          res.writeHead(302, { Location: url.searchParams.get('to') ?? '/file.png' })
          res.end()
          return
        case '/loop':
          res.writeHead(301, { Location: '/loop' })
          res.end()
          return
        case '/slow': {
          // Headers at once, then one byte and silence: only the deadline ends it.
          res.writeHead(200)
          res.write(Buffer.alloc(1))
          const t = setTimeout(() => res.end(), 5_000)
          res.on('close', () => clearTimeout(t))
          return
        }
        case '/missing':
          res.writeHead(404)
          res.end()
          return
        default:
          res.writeHead(200)
          res.end('ok')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** A world where `good.test` is the local server and everything else is internal. */
  function opts(extra: Partial<GuardedFetchOptions> = {}): GuardedFetchOptions {
    const table: Record<string, ResolvedAddress[]> = {
      'good.test': [{ address: '127.0.0.1', family: 4 }],
      'internal.test': [{ address: '10.0.0.5', family: 4 }],
      'mixed.test': [
        { address: '127.0.0.1', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ],
    }
    return {
      maxBytes: 800,
      allowedPorts: [port],
      isAllowedAddress: (ip) => ip === '127.0.0.1',
      resolve: async (host) => table[host] ?? [],
      ...extra,
    }
  }

  it('downloads a file and reports its type and name', async () => {
    const res = await guardedFetch(`http://good.test:${port}/file.png`, opts())
    expect([...res.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(res.contentType).toBe('image/png')
    expect(res.filename).toBe('logo.png')
    expect(res.cacheControl).toBe('public, max-age=60')
    // Host header carries the NAME although the socket went to the vetted address.
    expect(hits.at(-1)?.host).toBe(`good.test:${port}`)
  })

  it('sends the Accept header the caller asks for', async () => {
    await guardedFetch(`http://good.test:${port}/file.png`, opts({ accept: 'application/json' }))
    expect(hits.at(-1)?.accept).toBe('application/json')
    await guardedFetch(`http://good.test:${port}/file.png`, opts())
    expect(hits.at(-1)?.accept).toBe('*/*')
  })

  it.each([
    ['file:///etc/passwd', /http and https/],
    ['ftp://good.test/x', /http and https/],
    ['gopher://good.test/x', /http and https/],
    ['not a url', /valid absolute URL/],
  ])('refuses %s', async (url, message) => {
    await expect(guardedFetch(url, opts())).rejects.toThrow(message)
  })

  it('refuses credentials in the URL', async () => {
    await expect(guardedFetch(`http://user:pw@good.test:${port}/`, opts())).rejects.toBeInstanceOf(
      UnsafeUrlError,
    )
  })

  it('refuses ports other than 80 and 443 by default', async () => {
    const { allowedPorts: _ports, ...defaultPorts } = opts()
    await expect(guardedFetch(`http://good.test:${port}/`, defaultPorts)).rejects.toThrow(/port/)
    await expect(guardedFetch('http://example.com:22/', { maxBytes: 10 })).rejects.toThrow(
      /port 22/,
    )
  })

  it('refuses private literals and names that resolve privately, with the real policy', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:127.0.0.1]/',
      'http://100.100.100.100/',
      'http://localhost/',
    ]) {
      await expect(guardedFetch(url, { maxBytes: 10 }), url).rejects.toBeInstanceOf(UnsafeUrlError)
    }
  })

  it('refuses a name when ANY of its addresses is private', async () => {
    await expect(guardedFetch(`http://mixed.test:${port}/`, opts())).rejects.toThrow(
      /192\.168\.1\.1/,
    )
    await expect(guardedFetch(`http://internal.test:${port}/`, opts())).rejects.toBeInstanceOf(
      UnsafeUrlError,
    )
  })

  it('re-checks every redirect hop and refuses one into the internal network', async () => {
    const before = hits.length
    await expect(
      guardedFetch(
        `http://good.test:${port}/redirect?to=${encodeURIComponent(`http://internal.test:${port}/secret`)}`,
        opts(),
      ),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
    // The first hop happened; the internal one never did.
    expect(hits.slice(before).map((h) => h.url)).toEqual([
      `/redirect?to=${encodeURIComponent(`http://internal.test:${port}/secret`)}`,
    ])
    await expect(
      guardedFetch(
        `http://good.test:${port}/redirect?to=${encodeURIComponent('file:///etc/passwd')}`,
        opts(),
      ),
    ).rejects.toThrow(/http and https/)
  })

  it('follows a safe redirect', async () => {
    const res = await guardedFetch(`http://good.test:${port}/redirect?to=/file.png`, opts())
    expect(res.filename).toBe('logo.png')
    expect(res.finalUrl).toBe(`http://good.test:${port}/file.png`)
  })

  it('stops after the redirect limit', async () => {
    await expect(
      guardedFetch(`http://good.test:${port}/loop`, opts({ maxRedirects: 2 })),
    ).rejects.toThrow(/more than 2 redirects/)
  })

  it('resolves each hop once and connects to the vetted address (DNS rebinding)', async () => {
    // First answer public, every later answer internal: a guard that resolved
    // again at connect time would be pointed at 10.0.0.9.
    let calls = 0
    const rebinding = async (host: string): Promise<ResolvedAddress[]> => {
      if (host !== 'rebind.test') return []
      calls++
      return calls === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '10.0.0.9', family: 4 }]
    }
    const res = await guardedFetch(
      `http://rebind.test:${port}/file.png`,
      opts({ resolve: rebinding }),
    )
    expect(res.bytes.length).toBe(4)
    expect(calls).toBe(1)
  })

  it('refuses a declared Content-Length over the limit before reading', async () => {
    const err = await guardedFetch(`http://good.test:${port}/big`, opts()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FetchFailedError)
    expect((err as FetchFailedError).tooLarge).toBe(true)
  })

  it('aborts a streamed body the moment it passes the limit', async () => {
    const err = await guardedFetch(`http://good.test:${port}/stream`, opts()).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(FetchFailedError)
    expect((err as FetchFailedError).tooLarge).toBe(true)
  })

  it('reports a failed download', async () => {
    await expect(guardedFetch(`http://good.test:${port}/missing`, opts())).rejects.toThrow(
      /HTTP 404/,
    )
    await expect(guardedFetch(`http://nowhere.test:${port}/`, opts())).rejects.toThrow(/resolve/)
  })

  describe('guardedDownloadToFile', () => {
    let dir = ''
    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'ssrf-guard-test-'))
    })
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('streams the body into the named file and reports its metadata', async () => {
      const target = path.join(dir, 'ok.png')
      const res = await guardedDownloadToFile(
        `http://good.test:${port}/redirect?to=/file.png`,
        target,
        opts(),
      )
      expect(res).toMatchObject({ sizeBytes: 4, contentType: 'image/png', filename: 'logo.png' })
      expect([...(await readFile(target))]).toEqual([0x89, 0x50, 0x4e, 0x47])
    })

    it('refuses a declared Content-Length over the limit before writing anything', async () => {
      const target = path.join(dir, 'big.bin')
      const err = await guardedDownloadToFile(`http://good.test:${port}/big`, target, opts()).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(FetchFailedError)
      expect((err as FetchFailedError).tooLarge).toBe(true)
      expect(existsSync(target)).toBe(false)
    })

    it('stops writing the moment a streamed body passes the limit', async () => {
      const target = path.join(dir, 'stream.bin')
      const err = await guardedDownloadToFile(
        `http://good.test:${port}/stream`,
        target,
        opts(),
      ).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(FetchFailedError)
      expect((err as FetchFailedError).tooLarge).toBe(true)
      // Never more than the cap reached the disk.
      const written = existsSync(target) ? (await stat(target)).size : 0
      expect(written).toBeLessThanOrEqual(800)
    })

    it('applies the same per-hop checks as guardedFetch', async () => {
      const target = path.join(dir, 'internal.bin')
      await expect(
        guardedDownloadToFile(`http://internal.test:${port}/`, target, opts()),
      ).rejects.toBeInstanceOf(UnsafeUrlError)
      expect(existsSync(target)).toBe(false)
    })

    it('times out a body that trickles past the deadline', async () => {
      const target = path.join(dir, 'slow.bin')
      await expect(
        guardedDownloadToFile(`http://good.test:${port}/slow`, target, opts({ timeoutMs: 150 })),
      ).rejects.toThrow(/timed out/)
    })
  })
})
