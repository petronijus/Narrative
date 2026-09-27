/**
 * mcp/oauth/clientMetadata.ts — Client ID Metadata Documents (CIMD): OAuth
 * clients whose `client_id` is an https URL serving a JSON document that
 * describes them (MCP authorization spec 2025-11-25, "Client ID Metadata
 * Documents"; draft-ietf-oauth-client-id-metadata-document). Claude uses one
 * whenever the authorization server metadata advertises
 * `client_id_metadata_document_supported: true` together with the `none`
 * token endpoint auth method — Claude Code's is
 * https://claude.ai/oauth/claude-code-client-metadata — instead of
 * registering a new client on every connection (DCR).
 *
 * A CIMD client is resolved from its document when it asks for authorization
 * and is never stored as a registered client: the authorization and the
 * grant keep its client_id URL and a display snapshot (store.ts). The token
 * and revocation endpoints do not fetch the document again — a CIMD client
 * is a public client (auth method `none`), so it is identified by its
 * client_id alone, which must equal the one the code or grant was issued to.
 *
 * The client_id URL (`clientIdUrlProblem`): https, canonical form
 * (`new URL(id).href === id`, so one client cannot hide behind spellings),
 * a path other than `/`, no dot segments, query, fragment or credentials, at
 * most 512 characters.
 *
 * Fetching goes through the SSRF guard (net/ssrfGuard.ts): public addresses
 * only, port 443, the vetted address pinned against DNS rebinding, NO
 * redirects (the document must live at its own client_id), a 5 KiB body cap
 * and a 5 s deadline, `Accept: application/json`.
 *
 * The document (`parseClientMetadataDocument`) must be a JSON object with
 *   client_id       exactly the URL it was fetched from
 *   client_name     a label that survives `sanitizePeerLabel` (control,
 *                   bidi / invisible format and markup characters removed,
 *                   truncated to 100 characters)
 *   redirect_uris   1–10 URIs, each on the redirect allowlist (redirects.ts)
 * and, when present, `token_endpoint_auth_method: "none"` (the only method
 * Narrative accepts for metadata documents; shared secrets are forbidden by
 * the draft, private_key_jwt is not supported), `grant_types` within
 * authorization_code / refresh_token and including authorization_code,
 * `response_types: ["code"]`, a `scope` within the supported scopes, and no
 * `client_secret`. `scope` and `grant_types` are kept (`scopes`,
 * `grantTypes`) and enforced like a registration's: an absent `grant_types`
 * means `authorization_code` only (RFC 7591 §2), so no refresh token; an
 * absent `scope` means every supported scope.
 *
 * Which hosts may serve documents at all is the authorization server's
 * decision (MCP_OAUTH_CIMD_HOSTS, checked in service.ts before resolving).
 *
 * Caching (`cacheLifetimeMs`): successful documents are kept in memory for
 * what their `Cache-Control` allows — `no-store` / `no-cache` / `max-age=0`
 * are not cached, `max-age=N` is honoured up to 24 hours, no header means 5
 * minutes. Failures are remembered for 15 seconds, so a broken or hostile
 * host is not fetched on every request. At most 500 documents are cached
 * (least recently used evicted), and concurrent resolutions of one URL share
 * a single fetch.
 */

import { sanitizePeerLabel } from '@narrative/shared'
import { FetchFailedError, UnsafeUrlError, guardedFetch } from '../../net/ssrfGuard.js'
import { redirectUriRegistrationProblem } from './redirects.js'

export const CIMD_MAX_BYTES = 5 * 1024
export const CIMD_TIMEOUT_MS = 5_000
export const CIMD_MAX_URL_LENGTH = 512
export const CIMD_DEFAULT_TTL_MS = 5 * 60_000
export const CIMD_MAX_TTL_MS = 24 * 60 * 60_000
export const CIMD_FAILURE_TTL_MS = 15_000
export const CIMD_MAX_CACHE_ENTRIES = 500

const MAX_CLIENT_NAME = 100
const MAX_REDIRECT_URIS = 10

/** A resolved metadata document: what the authorization flow needs of the client. */
export interface ClientMetadataDocument {
  /** The client_id — the document's URL. */
  clientId: string
  clientName: string
  redirectUris: string[]
  /** `client_uri` when the document gives an https one (informational). */
  clientUri: string | null
  /** Host of the client_id URL: who published the client (shown on the consent page). */
  host: string
  /** The scopes the document declares (every supported scope when it declares none). */
  scopes: string[]
  /** The grant types it declares (`['authorization_code']` when it declares none, RFC 7591). */
  grantTypes: string[]
}

/** The client_id cannot be used; `message` is safe to show to the user. */
export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientMetadataError'
  }
}

/** Is this client_id a metadata-document URL (as opposed to a registered client's id)? */
export function isClientIdMetadataUrl(clientId: string): boolean {
  return clientId.startsWith('https://')
}

/** Null when `clientId` is a usable metadata-document URL; otherwise why not. */
export function clientIdUrlProblem(clientId: string): string | null {
  if (clientId.length > CIMD_MAX_URL_LENGTH)
    return `the client_id URL is longer than ${CIMD_MAX_URL_LENGTH} characters`
  let u: URL
  try {
    u = new URL(clientId)
  } catch {
    return 'the client_id is not a valid URL'
  }
  if (u.protocol !== 'https:') return 'the client_id URL must use https'
  if (u.username !== '' || u.password !== '') return 'the client_id URL must not carry credentials'
  if (u.hash !== '' || clientId.includes('#')) return 'the client_id URL must not carry a fragment'
  if (u.search !== '' || clientId.includes('?')) return 'the client_id URL must not carry a query'
  if (u.pathname === '/' || u.pathname === '') return 'the client_id URL must have a path'
  const rawPath = clientId.slice(clientId.indexOf('/', 'https://'.length))
  if (rawPath.split('/').some((segment) => segment === '.' || segment === '..'))
    return 'the client_id URL must not contain dot segments'
  if (u.href !== clientId) return 'the client_id URL must be in canonical form'
  return null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate a fetched document for `url` (see the file header). Throws
 * ClientMetadataError naming the first problem.
 */
export function parseClientMetadataDocument(
  url: string,
  doc: unknown,
  opts: { allowedRedirectUris: readonly string[]; supportedScopes: readonly string[] },
): ClientMetadataDocument {
  const fail = (why: string): never => {
    throw new ClientMetadataError(`The application's metadata document is not usable: ${why}.`)
  }
  if (!isRecord(doc)) return fail('it is not a JSON object')
  if (doc['client_id'] !== url) return fail('its client_id is not the URL it was fetched from')

  const rawName = doc['client_name']
  if (typeof rawName !== 'string') return fail('client_name is missing')
  const clientName = sanitizePeerLabel(rawName, MAX_CLIENT_NAME)
  if (clientName === null) return fail('client_name is empty')

  const uris = doc['redirect_uris']
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS)
    return fail(`redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`)
  for (const uri of uris) {
    const problem = redirectUriRegistrationProblem(uri, opts.allowedRedirectUris)
    if (problem !== null) return fail(`redirect URI ${JSON.stringify(uri)} ${problem}`)
  }

  const method = doc['token_endpoint_auth_method']
  if (method !== undefined && method !== 'none')
    return fail('token_endpoint_auth_method must be "none" (a public client)')
  if (doc['client_secret'] !== undefined || doc['client_secret_expires_at'] !== undefined)
    return fail('it must not contain a client secret')

  const grantTypes = doc['grant_types']
  if (
    grantTypes !== undefined &&
    (!Array.isArray(grantTypes) ||
      !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token') ||
      !grantTypes.includes('authorization_code'))
  ) {
    return fail('grant_types must be authorization_code (and optionally refresh_token)')
  }
  const responseTypes = doc['response_types']
  if (
    responseTypes !== undefined &&
    (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code')
  ) {
    return fail('response_types must be ["code"]')
  }
  const scope = doc['scope']
  if (
    scope !== undefined &&
    (typeof scope !== 'string' ||
      !scope
        .split(' ')
        .filter(Boolean)
        .every((s) => opts.supportedScopes.includes(s)))
  ) {
    return fail(`scope may only name ${opts.supportedScopes.join(', ')}`)
  }

  const rawClientUri = doc['client_uri']
  let clientUri: string | null = null
  if (typeof rawClientUri === 'string' && rawClientUri.length <= CIMD_MAX_URL_LENGTH) {
    try {
      if (new URL(rawClientUri).protocol === 'https:') clientUri = rawClientUri
    } catch {
      // informational only: an unusable client_uri is dropped, not fatal
    }
  }

  const declaredScopes =
    typeof scope === 'string' ? new Set(scope.split(' ').filter(Boolean)) : null
  return {
    clientId: url,
    clientName,
    redirectUris: [...(uris as string[])],
    clientUri,
    host: new URL(url).host,
    scopes:
      declaredScopes === null
        ? [...opts.supportedScopes]
        : opts.supportedScopes.filter((s) => declaredScopes.has(s)),
    grantTypes:
      grantTypes === undefined ? ['authorization_code'] : [...new Set(grantTypes as string[])],
  }
}

/** How long a document may be cached, from its `Cache-Control` header (see the file header). */
export function cacheLifetimeMs(cacheControl: string | null): number {
  if (cacheControl === null) return CIMD_DEFAULT_TTL_MS
  const directives = cacheControl
    .toLowerCase()
    .split(',')
    .map((d) => d.trim())
  if (directives.some((d) => d === 'no-store' || d === 'no-cache')) return 0
  const maxAge = directives.map((d) => /^max-age\s*=\s*"?(\d+)"?$/.exec(d)).find((m) => m !== null)
  if (maxAge === undefined || maxAge === null) return CIMD_DEFAULT_TTL_MS
  const seconds = Number(maxAge[1])
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.min(seconds * 1000, CIMD_MAX_TTL_MS)
}

/** What fetching a document produced (the seam tests replace). */
export interface FetchedClientMetadata {
  body: Buffer
  contentType: string | null
  cacheControl: string | null
}

export type ClientMetadataFetcher = (url: string) => Promise<FetchedClientMetadata>

/** The production fetcher: the SSRF guard with the limits in the file header. */
export const guardedClientMetadataFetcher: ClientMetadataFetcher = async (url) => {
  const res = await guardedFetch(url, {
    maxBytes: CIMD_MAX_BYTES,
    timeoutMs: CIMD_TIMEOUT_MS,
    maxRedirects: 0,
    allowedPorts: [443],
    accept: 'application/json',
    userAgent: 'Narrative/1 (+OAuth client metadata)',
  })
  return { body: res.bytes, contentType: res.contentType, cacheControl: res.cacheControl }
}

export interface ClientMetadataResolver {
  /** Resolve a client_id URL to its validated document. Throws ClientMetadataError. */
  resolve(clientId: string): Promise<ClientMetadataDocument>
}

export interface ClientMetadataResolverOptions {
  allowedRedirectUris: readonly string[]
  supportedScopes: readonly string[]
  fetch?: ClientMetadataFetcher
  now?: () => number
  maxEntries?: number
  /** Called with the underlying error when a fetch fails (logging). */
  onFetchError?: (clientId: string, err: unknown) => void
}

type CacheEntry =
  | { ok: true; doc: ClientMetadataDocument; expiresAt: number }
  | { ok: false; error: ClientMetadataError; expiresAt: number }

export function createClientMetadataResolver(
  opts: ClientMetadataResolverOptions,
): ClientMetadataResolver {
  const fetchDoc = opts.fetch ?? guardedClientMetadataFetcher
  const now = opts.now ?? Date.now
  const maxEntries = opts.maxEntries ?? CIMD_MAX_CACHE_ENTRIES
  // A Map iterates in insertion order: re-inserting on use makes it an LRU.
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<ClientMetadataDocument>>()

  const remember = (clientId: string, entry: CacheEntry): void => {
    cache.delete(clientId)
    if (entry.expiresAt <= now()) return
    cache.set(clientId, entry)
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  const load = async (clientId: string): Promise<ClientMetadataDocument> => {
    let fetched: FetchedClientMetadata
    try {
      fetched = await fetchDoc(clientId)
    } catch (err) {
      opts.onFetchError?.(clientId, err)
      const why =
        err instanceof UnsafeUrlError
          ? 'its address is not allowed'
          : err instanceof FetchFailedError && err.tooLarge
            ? `it is larger than ${CIMD_MAX_BYTES} bytes`
            : 'it could not be fetched'
      throw new ClientMetadataError(`The application's metadata document is not usable: ${why}.`)
    }
    const type = fetched.contentType
    if (type !== null && type !== 'application/json' && !type.endsWith('+json')) {
      throw new ClientMetadataError(
        "The application's metadata document is not usable: it is not served as JSON.",
      )
    }
    let json: unknown
    try {
      json = JSON.parse(fetched.body.toString('utf8'))
    } catch {
      throw new ClientMetadataError(
        "The application's metadata document is not usable: it is not valid JSON.",
      )
    }
    const doc = parseClientMetadataDocument(clientId, json, opts)
    remember(clientId, { ok: true, doc, expiresAt: now() + cacheLifetimeMs(fetched.cacheControl) })
    return doc
  }

  return {
    async resolve(clientId) {
      const problem = clientIdUrlProblem(clientId)
      if (problem !== null)
        throw new ClientMetadataError(`This application cannot connect: ${problem}.`)
      const cached = cache.get(clientId)
      if (cached !== undefined) {
        if (cached.expiresAt > now()) {
          remember(clientId, cached)
          if (cached.ok) return cached.doc
          throw cached.error
        }
        cache.delete(clientId)
      }
      let pending = inFlight.get(clientId)
      if (pending === undefined) {
        pending = load(clientId)
          .catch((err: unknown) => {
            if (err instanceof ClientMetadataError)
              remember(clientId, { ok: false, error: err, expiresAt: now() + CIMD_FAILURE_TTL_MS })
            throw err
          })
          .finally(() => inFlight.delete(clientId))
        inFlight.set(clientId, pending)
      }
      return pending
    },
  }
}
