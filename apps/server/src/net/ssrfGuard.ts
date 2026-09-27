/**
 * net/ssrfGuard.ts
 *
 * Downloading a URL an agent (or any API caller) handed us, without letting
 * the server be used to reach its own network (SSRF).
 *
 * The rules, applied to EVERY hop (the first request and each redirect):
 *
 *   1. Scheme is `http:` or `https:`; no credentials in the URL; the port is
 *      80 or 443 (the defaults of those schemes), so the server cannot be
 *      aimed at arbitrary services even on public hosts.
 *   2. The host is resolved ONCE, and every address it resolves to must be
 *      public — a single private answer rejects the URL, so a DNS answer
 *      mixing a public and a private address cannot slip through. Literal
 *      IPs are checked the same way.
 *   3. The connection goes to the address vetted in step 2 (a custom
 *      `lookup` hands the socket that exact address), never to a second
 *      resolution. That defeats DNS rebinding: a name that resolves to a
 *      public address for the check and to 127.0.0.1 a moment later is never
 *      resolved a second time. TLS still verifies the certificate against the
 *      host NAME (SNI / `servername`).
 *   4. Redirects are followed manually, at most `maxRedirects` (default 3),
 *      each re-checked from step 1. Inside an agent command every hop is
 *      also recorded, and may be restricted to allowlisted hosts
 *      (net/fetchAudit.ts).
 *   5. The body is capped: a `Content-Length` over the limit is refused
 *      before reading, and a streamed body is aborted the moment it passes
 *      the limit. `Accept-Encoding: identity` — nothing is decompressed, so
 *      there is no decompression bomb to defuse. A deadline bounds the whole
 *      download.
 *
 * Two ways to receive the body: `guardedFetch` returns it in memory (for
 * small files a caller needs as a Buffer anyway), `guardedDownloadToFile`
 * streams it into a file the caller names, so a large download never sits in
 * the heap.
 *
 * "Public" means: not in any special-purpose range of the IANA IPv4 / IPv6
 * special-purpose registries — loopback, private, CGNAT (100.64/10, which
 * is also where Tailscale addresses live), link-local (incl. the cloud
 * metadata address 169.254.169.254), documentation, benchmarking,
 * multicast, reserved, ULA, and the IPv6 transition prefixes that embed an
 * IPv4 address (NAT64, 6to4, Teredo, IPv4-compatible). On top of that, every
 * IPv4 address an IPv6 address embeds (mapped, translated, compatible, NAT64,
 * 6to4, Teredo server and client) is decoded and must itself be public.
 */

import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { LookupFunction } from 'node:net'
import { createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { beforeFetchHop } from './fetchAudit.js'

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

const BLOCKED = new net.BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (CGNAT, Tailscale)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.31.196.0', 24], // AS112-v4
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // direct delegation AS112
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + limited broadcast
] as const) {
  BLOCKED.addSubnet(addr, prefix, 'ipv4')
}
for (const [addr, prefix] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible (deprecated)
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // SRv6 SIDs
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(addr, prefix, 'ipv6')
}

/**
 * The eight 16-bit groups of a valid IPv6 literal (no brackets, no zone id),
 * with `::` expanded and a trailing dotted quad folded into the last two
 * groups. Null when `ip` is not in that form.
 */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    if ([a, b, c, d].some((o) => o > 255)) return null
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0]!.split(':')
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1]!.split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  // `::` stands for at least one group.
  if (halves.length === 2 && fill < 1) return null
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (parts.length !== 8) return null
  const groups: number[] = []
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    groups.push(parseInt(part, 16))
  }
  return groups
}

function ipv4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/**
 * Every IPv4 address an IPv6 address carries, by the forms that embed one:
 *
 *   - IPv4-mapped      `::ffff:a.b.c.d`       (::ffff:0:0/96)
 *   - IPv4-translated  `::ffff:0:a.b.c.d`     (::ffff:0:0:0/96, RFC 2765 SIIT)
 *   - IPv4-compatible  `::a.b.c.d`            (::/96, deprecated)
 *   - NAT64            `64:ff9b::a.b.c.d`     (64:ff9b::/96, RFC 6052)
 *   - local NAT64      `64:ff9b:1:AABB:uu CC:DD00::` (64:ff9b:1::/48, RFC 6052 /48 layout)
 *   - 6to4             `2002:AABB:CCDD::`     (2002::/16, RFC 3056)
 *   - Teredo           `2001:0:SSSS:SSSS:flags:port:~CCCC:~CCCC` (2001::/32,
 *     RFC 4380 — bits 32–63 are the server's IPv4, the last 32 bits the
 *     client's IPv4 XOR 0xffffffff)
 *
 * The hex spelling (`::ffff:7f00:1`) and the dotted one are the same groups,
 * so both decode alike.
 */
export function embeddedIPv4s(ip: string): string[] {
  const g = ipv6Groups(ip)
  if (g === null) return []
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0)
  const out: string[] = []
  if (zeros(0, 5) && g[5] === 0xffff) out.push(ipv4FromGroups(g[6]!, g[7]!))
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) out.push(ipv4FromGroups(g[6]!, g[7]!))
  if (zeros(0, 6)) out.push(ipv4FromGroups(g[6]!, g[7]!))
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) out.push(ipv4FromGroups(g[6]!, g[7]!))
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) {
    // /48 layout: octets 1–2 in bits 48–63, bits 64–71 are `u`, octets 3–4 in bits 72–87.
    out.push(ipv4FromGroups(g[3]!, ((g[4]! & 0xff) << 8) | (g[5]! >> 8)))
  }
  if (g[0] === 0x2002) out.push(ipv4FromGroups(g[1]!, g[2]!))
  if (g[0] === 0x2001 && g[1] === 0) {
    out.push(ipv4FromGroups(g[2]!, g[3]!))
    out.push(ipv4FromGroups(g[6]! ^ 0xffff, g[7]! ^ 0xffff))
  }
  return out
}

/**
 * True when `ip` is a literal address outside every special-purpose range.
 * An IPv6 address must clear the IPv6 ranges AND every IPv4 address it
 * embeds (embeddedIPv4s) must clear the IPv4 ranges — so `::ffff:0:127.0.0.1`
 * is judged as 127.0.0.1, whatever prefix it hides behind. Transition
 * prefixes that are blocked outright (NAT64, 6to4, Teredo, IPv4-compatible)
 * stay blocked even when they carry a public IPv4.
 */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip
  // A zone id (fe80::1%eth0) is only meaningful for link-local, which is blocked.
  if (bare.includes('%')) return false
  const family = net.isIP(bare)
  if (family === 0) return false
  if (family === 6) {
    if (ipv6Groups(bare) === null) return false
    if (BLOCKED.check(bare, 'ipv6')) return false
    return embeddedIPv4s(bare).every((v4) => !BLOCKED.check(v4, 'ipv4'))
  }
  return !BLOCKED.check(bare, 'ipv4')
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The URL (or a redirect it led to) is not allowed. Nothing was downloaded from it. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

/** The download was allowed but failed (status, size, timeout, network). */
export class FetchFailedError extends Error {
  readonly tooLarge: boolean
  constructor(message: string, opts: { tooLarge?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'FetchFailedError'
    this.tooLarge = opts.tooLarge ?? false
  }
}

// ---------------------------------------------------------------------------
// Guarded fetch
// ---------------------------------------------------------------------------

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface GuardedFetchOptions {
  /** Refuse bodies larger than this many bytes. */
  maxBytes: number
  /** Redirects followed at most (each re-checked). Default 3. */
  maxRedirects?: number
  /** Deadline for the whole download, redirects included. Default 30 s. */
  timeoutMs?: number
  /** Ports a URL may name. Default: 80 and 443. */
  allowedPorts?: readonly number[]
  /** Test seam: DNS resolution (all answers). Default: `dns.lookup(host, { all: true })`. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  /** Test seam: the address policy. Default: `isPublicAddress`. */
  isAllowedAddress?: (ip: string) => boolean
  /** `Accept` request header. Default: any type (`*` / `*`). */
  accept?: string
  /** `User-Agent` request header. Default `Narrative/1 (+agent media fetch)`. */
  userAgent?: string
}

/** What the final response said about the body, whichever way it was received. */
export interface FetchedMeta {
  /** `Content-Type` of the final response without parameters, lower-cased; null when absent. */
  contentType: string | null
  /** A filename from `Content-Disposition` or the last path segment of the final URL. */
  filename: string | null
  finalUrl: string
  /** The final response's `Cache-Control` header as sent; null when absent. */
  cacheControl: string | null
}

export interface FetchedBinary extends FetchedMeta {
  bytes: Buffer
}

export interface DownloadedFile extends FetchedMeta {
  /** Bytes written to the destination file. */
  sizeBytes: number
}

const DEFAULT_PORTS = [80, 443] as const

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true })
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
}

interface Vetted {
  url: URL
  /** Hostname without IPv6 brackets. */
  host: string
  address: ResolvedAddress
}

async function vet(url: URL, opts: GuardedFetchOptions): Promise<Vetted> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`only http and https URLs are allowed (got ${url.protocol})`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeUrlError('URLs with credentials are not allowed')
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  const allowedPorts = opts.allowedPorts ?? DEFAULT_PORTS
  if (!allowedPorts.includes(port)) {
    throw new UnsafeUrlError(`port ${port} is not allowed (allowed: ${allowedPorts.join(', ')})`)
  }
  const isAllowed = opts.isAllowedAddress ?? isPublicAddress
  const host =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname
  if (host === '') throw new UnsafeUrlError('the URL has no host')

  const literal = net.isIP(host)
  if (literal !== 0) {
    if (!isAllowed(host)) throw new UnsafeUrlError(`address ${host} is not public`)
    return { url, host, address: { address: host, family: literal === 6 ? 6 : 4 } }
  }

  let answers: ResolvedAddress[]
  try {
    answers = await (opts.resolve ?? defaultResolve)(host)
  } catch (err) {
    throw new FetchFailedError(`could not resolve ${host}`, { cause: err })
  }
  if (answers.length === 0) throw new FetchFailedError(`could not resolve ${host}`)
  const blocked = answers.find((a) => !isAllowed(a.address))
  if (blocked !== undefined) {
    throw new UnsafeUrlError(`${host} resolves to ${blocked.address}, which is not public`)
  }
  return { url, host, address: answers[0]! }
}

function filenameFrom(disposition: string | undefined, url: URL): string | null {
  if (disposition !== undefined) {
    const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition)
    if (star !== null) {
      try {
        return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ''))
      } catch {
        // fall through to the plain parameter
      }
    }
    const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(disposition)
    if (plain !== null) return plain[2]!.trim()
  }
  const last = url.pathname
    .split('/')
    .filter((s) => s !== '')
    .pop()
  if (last === undefined) return null
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

type HopResult =
  | { kind: 'redirect'; location: string }
  | {
      kind: 'body'
      /** The response body, not yet read. The consumer must read or destroy it. */
      body: http.IncomingMessage
      contentType: string | null
      disposition: string | undefined
      cacheControl: string | null
    }

function requestOnce(
  v: Vetted,
  opts: GuardedFetchOptions,
  signal: AbortSignal,
): Promise<HopResult> {
  const pinned: LookupFunction = (_hostname, options, callback) => {
    // Hand the socket the vetted address — never resolve again (DNS rebinding).
    const all = typeof options === 'object' && options !== null && options.all === true
    if (all) {
      ;(callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(
        null,
        [{ address: v.address.address, family: v.address.family }],
      )
    } else {
      callback(null, v.address.address, v.address.family)
    }
  }
  const isHttps = v.url.protocol === 'https:'
  const reqOptions: https.RequestOptions = {
    method: 'GET',
    protocol: v.url.protocol,
    hostname: v.host,
    port: v.url.port === '' ? undefined : Number(v.url.port),
    path: `${v.url.pathname}${v.url.search}`,
    headers: {
      'User-Agent': opts.userAgent ?? 'Narrative/1 (+agent media fetch)',
      Accept: opts.accept ?? '*/*',
      'Accept-Encoding': 'identity',
    },
    lookup: pinned,
    // No pooled sockets: a pooled connection is keyed by host name and could
    // carry a request to an address this hop did not vet.
    agent: false,
    signal,
    ...(isHttps && net.isIP(v.host) === 0 ? { servername: v.host } : {}),
  }

  return new Promise<HopResult>((resolve, reject) => {
    const req = (isHttps ? https : http).request(reqOptions, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location !== undefined) {
        res.resume()
        resolve({ kind: 'redirect', location: res.headers.location })
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new FetchFailedError(`the server answered HTTP ${status}`))
        return
      }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        res.destroy()
        reject(
          new FetchFailedError(`the file is ${declared} bytes; the limit is ${opts.maxBytes}`, {
            tooLarge: true,
          }),
        )
        return
      }
      const type = res.headers['content-type']
      resolve({
        kind: 'body',
        body: res,
        contentType:
          typeof type === 'string' ? (type.split(';')[0]?.trim().toLowerCase() ?? null) : null,
        disposition: res.headers['content-disposition'],
        cacheControl:
          typeof res.headers['cache-control'] === 'string' ? res.headers['cache-control'] : null,
      })
    })
    req.on('error', (err) => {
      reject(
        err instanceof FetchFailedError
          ? err
          : new FetchFailedError(
              signal.aborted ? 'the download timed out' : 'the download failed',
              { cause: err },
            ),
      )
    })
    req.end()
  })
}

/**
 * A pass-through that fails the stream with a `tooLarge` FetchFailedError
 * the moment more than `maxBytes` have gone through it.
 */
function byteLimit(maxBytes: number): Transform & { readonly total: number } {
  let total = 0
  const t = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      total += chunk.length
      if (total > maxBytes) {
        callback(
          new FetchFailedError(`the file is larger than the limit of ${maxBytes} bytes`, {
            tooLarge: true,
          }),
        )
        return
      }
      callback(null, chunk)
    },
  })
  return Object.defineProperty(t, 'total', { get: () => total }) as Transform & {
    readonly total: number
  }
}

/** Map a failure while reading a body to the guard's error types. */
function bodyError(err: unknown, signal: AbortSignal): Error {
  if (err instanceof FetchFailedError) return err
  return new FetchFailedError(signal.aborted ? 'the download timed out' : 'the download failed', {
    cause: err,
  })
}

/**
 * Walk the URL and its redirects under the rules in the module header, then
 * hand the final body to `consume`. The deadline covers `consume` too.
 */
async function fetchWith<T>(
  rawUrl: string,
  opts: GuardedFetchOptions,
  consume: (body: http.IncomingMessage, signal: AbortSignal) => Promise<T>,
): Promise<{ result: T; meta: FetchedMeta }> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UnsafeUrlError('not a valid absolute URL')
  }
  const maxRedirects = opts.maxRedirects ?? 3
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  try {
    for (let hop = 0; ; hop++) {
      const vetted = await vet(url, opts)
      // Audit + the no-confirmation redirect policy of agent fetches (net/fetchAudit.ts).
      const refused = beforeFetchHop(url)
      if (refused !== null) throw new UnsafeUrlError(refused)
      const hopResult = await requestOnce(vetted, opts, controller.signal)
      if (hopResult.kind === 'body') {
        let result: T
        try {
          result = await consume(hopResult.body, controller.signal)
        } catch (err) {
          hopResult.body.destroy()
          throw bodyError(err, controller.signal)
        }
        return {
          result,
          meta: {
            contentType: hopResult.contentType,
            filename: filenameFrom(hopResult.disposition, url),
            finalUrl: url.toString(),
            cacheControl: hopResult.cacheControl,
          },
        }
      }
      if (hop >= maxRedirects) {
        throw new FetchFailedError(`more than ${maxRedirects} redirects`)
      }
      try {
        url = new URL(hopResult.location, url)
      } catch {
        throw new UnsafeUrlError('the server redirected to an invalid URL')
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download `rawUrl` into memory under the rules in the module header. Meant
 * for small files (the caller's `maxBytes` bounds the heap it costs). Throws
 * `UnsafeUrlError` when a hop is not allowed and `FetchFailedError` when the
 * download fails.
 */
export async function guardedFetch(
  rawUrl: string,
  opts: GuardedFetchOptions,
): Promise<FetchedBinary> {
  const { result, meta } = await fetchWith(rawUrl, opts, async (body) => {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of body as AsyncIterable<Buffer>) {
      total += chunk.length
      if (total > opts.maxBytes) {
        throw new FetchFailedError(`the file is larger than the limit of ${opts.maxBytes} bytes`, {
          tooLarge: true,
        })
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  })
  return { bytes: result, ...meta }
}

/**
 * Download `rawUrl` into the file at `destination` (created or truncated)
 * under the rules in the module header, streaming — the body never sits in
 * memory, and the write stops the moment it passes `maxBytes`. On failure
 * the destination may hold a partial file; the caller owns deleting it
 * (typically by removing the temporary directory it created). Throws
 * `UnsafeUrlError` when a hop is not allowed and `FetchFailedError` when the
 * download fails.
 */
export async function guardedDownloadToFile(
  rawUrl: string,
  destination: string,
  opts: GuardedFetchOptions,
): Promise<DownloadedFile> {
  const { result, meta } = await fetchWith(rawUrl, opts, async (body) => {
    const limit = byteLimit(opts.maxBytes)
    await pipeline(body, limit, createWriteStream(destination, { flags: 'w', mode: 0o600 }))
    return limit.total
  })
  return { sizeBytes: result, ...meta }
}
