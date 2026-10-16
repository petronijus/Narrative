/**
 * mcp/oauth/service.ts — Narrative as an OAuth 2.1 authorization server for
 * MCP clients (MCP authorization spec 2025-11-25; OAuth 2.1 draft 13;
 * RFC 7591 DCR; RFC 7636 PKCE; RFC 8707 resource indicators; RFC 7009
 * revocation). The HTTP layer is routes.ts; this module holds the rules.
 *
 * Clients (MCP authorization spec, "Client Registration Approaches"):
 *   - Client ID Metadata Documents (clientMetadata.ts): the client_id is an
 *     https URL serving the client's metadata. Preferred by Claude whenever
 *     the metadata below advertises it (with the `none` auth method), so no
 *     registration piles up; resolved per authorization, never stored.
 *     Only documents on the hosts of MCP_OAUTH_CIMD_HOSTS (default
 *     `claude.ai`) are accepted; any other host is refused before a fetch.
 *   - Dynamic client registration (RFC 7591): POST /oauth/register, OFF
 *     unless MCP_OAUTH_DCR_ENABLED=true (then advertised in the metadata).
 *     Claude registers a new client on every fresh connection that way, so
 *     registered clients without a live grant are deleted after 7 days of
 *     inactivity (`runMaintenance`, hourly — runtime.ts).
 * Either way the redirect URIs are policed by redirects.ts, and the client's
 * declared `scope` and `grant_types` are enforced: /authorize intersects the
 * requested scopes with the client's, and drops `offline_access` unless the
 * client may use `refresh_token` (RFC 7591's default is `authorization_code`
 * only). The client's grant types are snapshotted on the authorization and
 * the grant, so the token endpoint never refetches a document.
 *
 * Scopes: `mcp` (the MCP resource; always required) and `offline_access`
 * (listed in the metadata, so Claude requests it): a refresh token is issued
 * only when the user approved `offline_access`; without it the connection
 * lasts one access token (1 h). Refresh failures are always `invalid_grant`
 * (Claude then starts a fresh sign-in), including a refresh by a registered
 * client that no longer exists.
 *
 * Flow (claude.ai connector, or any MCP client without a PAT):
 *   1. the client registers (DCR) or names its metadata document URL
 *   2. GET  /oauth/authorize          parameters validated; a pending
 *                                     authorization row is stored; the user
 *                                     signs in (Google, the normal login) if
 *                                     needed, then sees a consent page naming
 *                                     the client, its callback host and the
 *                                     `mcp` scope
 *   3. POST /oauth/authorize/decision approve / deny. CSRF-safe: the form
 *                                     carries a random token whose hash the
 *                                     row holds, the POST needs the same
 *                                     signed-in user the page was shown to,
 *                                     and the session cookie is SameSite=Lax
 *   4. POST /oauth/token              code + PKCE verifier (S256 only) →
 *                                     access token (1 h) + refresh token
 *                                     (30 d, rotated on every use) when
 *                                     `offline_access` was approved
 *   5. /mcp accepts `Authorization: Bearer nmo_…` for the grant's user, only
 *      for the resource it was issued for.
 *
 * Tokens are opaque random strings (`nmo_` access, `nmr_` refresh, `nmc_`
 * code), 256 bits each; only SHA-256 hashes are stored. A reused
 * authorization code revokes the grant it produced (OAuth 2.1 §4.1.3).
 *
 * Refresh-token replay (OAuth 2.1 §4.3.1). Every rotation records, on the
 * refresh token it consumed, a fingerprint of the rotating request:
 * SHA-256 of `<client IP>\n<User-Agent>` (`requestFingerprint`). Presenting
 * an already-rotated refresh token again is a replay. Every replay emits a
 * security event (`onSecurityEvent`, logged by the runtime) and flags the
 * grant (shown to the user under Connected apps). Then:
 *   - inside REFRESH_REUSE_GRACE_MS of the rotation, from the SAME
 *     fingerprint: the first rotator racing itself (two parallel refreshes
 *     of one client) — refused with invalid_grant, the grant is kept, so a
 *     race does not log the user out;
 *   - inside the grace window from ANOTHER fingerprint, or with no
 *     fingerprint recorded: the replaying request is not the first rotator,
 *     i.e. two parties hold the token — the grant is revoked;
 *   - after the grace window: theft — the grant is revoked.
 * A fingerprint is not an identity (a thief behind the same NAT with the same
 * client software matches it); it only decides whether a replay inside a
 * 30-second window is benign enough not to revoke. Anything else revokes.
 *
 * Retention: expired tokens and requests go hourly; authorizations decided
 * or exchanged, and grants revoked, more than RETENTION_MS (30 days) ago are
 * deleted too, metadata-document grants included.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { nanoid } from 'nanoid'
import { sanitizePeerLabel } from '@narrative/shared'
import { PKCE_CHALLENGE, PKCE_VERIFIER, s256Matches } from '../../auth/pkce.js'
import type { McpPublicConfig } from '../config.js'
import {
  ClientMetadataError,
  clientIdUrlProblem,
  createClientMetadataResolver,
  isClientIdMetadataUrl,
  type ClientMetadataResolver,
} from './clientMetadata.js'
import {
  isLoopbackRedirect,
  onlyLoopbackRedirects,
  redirectUriAllowed,
  redirectUriMatches,
  redirectUriRegistrationProblem,
} from './redirects.js'
import {
  UNKNOWN_CLIENT_NAME,
  type AuthorizationRecord,
  type ClientRecord,
  type ConnectionRecord,
  type McpOAuthStore,
  type TokenEndpointAuthMethod,
} from './store.js'

/** The MCP resource's scope: required on every authorization and token. */
export const MCP_SCOPE = 'mcp'
/** Asks for a refresh token (listed so Claude requests it; see the file header). */
export const OFFLINE_ACCESS_SCOPE = 'offline_access'
/** Scopes of the authorization server, in canonical order. */
export const SUPPORTED_SCOPES = [MCP_SCOPE, OFFLINE_ACCESS_SCOPE] as const

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000
export const AUTHORIZATION_REQUEST_TTL_MS = 15 * 60_000
export const REFRESH_REUSE_GRACE_MS = 30_000
const GRANT_TOUCH_INTERVAL_MS = 60_000
/** Registered clients without a live grant are deleted after this long without use. */
export const STALE_REGISTERED_CLIENT_MS = 7 * 24 * 60 * 60_000
/** Decided / exchanged authorizations and revoked grants are deleted after this long. */
export const RETENTION_MS = 30 * 24 * 60 * 60_000

/** The grant types a client may declare. */
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const
/** RFC 7591 §2: a client that declares no grant_types uses authorization_code only. */
const DEFAULT_GRANT_TYPES = ['authorization_code']

export const ACCESS_TOKEN_PREFIX = 'nmo_'
const REFRESH_TOKEN_PREFIX = 'nmr_'
const CODE_PREFIX = 'nmc_'
const CLIENT_SECRET_PREFIX = 'nms_'
const RAW_SECRET = /^nm[orcs]_[A-Za-z0-9_-]{43}$/

const MAX_REDIRECT_URIS = 10
const MAX_CLIENT_NAME = 100
const UNNAMED_CLIENT = 'Unnamed MCP client'
const MAX_STATE = 1024

/** An OAuth error as the spec names it; `status` for the token/registration endpoints. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description)
    this.name = 'OAuthError'
  }
}

export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function mint(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * Fingerprint of a token request, for telling a client racing itself from a
 * replay by someone else (see the file header). Null when nothing is known.
 */
export function requestFingerprint(info: TokenRequestInfo | undefined): string | null {
  if (info === undefined || (info.ip === null && info.userAgent === null)) return null
  return createHash('sha256')
    .update(`${info.ip ?? ''}\n${info.userAgent ?? ''}`, 'utf8')
    .digest('hex')
}

/** A null grant-type list is a row from before migration 0022: refresh was allowed then. */
function allowsRefresh(grantTypes: readonly string[] | null): boolean {
  return grantTypes === null || grantTypes.includes('refresh_token')
}

/** Is this bearer value an MCP OAuth access token claim (not a PAT or anything else)? */
export function looksLikeMcpAccessToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(ACCESS_TOKEN_PREFIX)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function optionalString(body: Record<string, unknown>, key: string, max: number): string | null {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || v.length > max) {
    throw new OAuthError(
      'invalid_client_metadata',
      `${key} must be a string of at most ${max} characters`,
    )
  }
  return v.trim() === '' ? null : v.trim()
}

/** Compare RFC 8707 resource URIs, tolerating case in scheme/host and a trailing slash. */
function sameResource(a: string, b: string): boolean {
  const norm = (s: string): string | null => {
    try {
      const u = new URL(s)
      if (u.hash !== '') return null
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase()
    } catch {
      return null
    }
  }
  const na = norm(a)
  return na !== null && na === norm(b)
}

export interface RegisteredClientResponse {
  client_id: string
  client_id_issued_at: number
  client_secret?: string
  client_secret_expires_at?: number
  client_name: string
  redirect_uris: string[]
  token_endpoint_auth_method: TokenEndpointAuthMethod
  grant_types: string[]
  response_types: string[]
  scope: string
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  /** Only for grants that include `offline_access`. */
  refresh_token?: string
  scope: string
}

/**
 * A client as the authorization flow sees it: a registered one (a row), or
 * one described by its metadata document (resolved, never stored).
 */
export interface ResolvedClient {
  id: string
  kind: 'registered' | 'metadata_document'
  clientName: string
  redirectUris: string[]
  tokenEndpointAuthMethod: TokenEndpointAuthMethod
  clientSecretHash: string | null
  /** The scopes the client declared; null = every supported scope (older registrations). */
  scopes: string[] | null
  /** The grant types it declared; null = both (older registrations). */
  grantTypes: string[] | null
}

function registeredClient(c: ClientRecord): ResolvedClient {
  return {
    id: c.id,
    kind: 'registered',
    clientName: c.clientName,
    redirectUris: c.redirectUris,
    tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
    clientSecretHash: c.clientSecretHash,
    scopes: c.scopes,
    grantTypes: c.grantTypes,
  }
}

/** Parse and check a space-separated scope list against the supported scopes; null when invalid. */
function parseScopes(raw: string): string[] | null {
  const requested = raw.split(' ').filter(Boolean)
  if (!requested.every((s) => (SUPPORTED_SCOPES as readonly string[]).includes(s))) return null
  return SUPPORTED_SCOPES.filter((s) => requested.includes(s))
}

/** A verified access token: who it acts for. */
export interface VerifiedMcpToken {
  grantId: string
  clientId: string
  clientName: string
  userSub: string
  email: string | null
  name: string | null
  scopes: string[]
}

/** The client's credentials as presented at the token or revocation endpoint. */
export interface ClientCredentials {
  clientId: string | null
  clientSecret: string | null
  /** `basic` (Authorization header) or `post` (form body). */
  via: 'basic' | 'post' | null
}

/** The request behind a token call, for the refresh replay fingerprint. */
export interface TokenRequestInfo {
  ip: string | null
  userAgent: string | null
}

/** Something a security reviewer should see (logged by the runtime). */
export interface McpOAuthSecurityEvent {
  event: 'mcp_oauth_refresh_replay'
  grantId: string
  clientId: string
  userSub: string
  /** The replay came from the fingerprint that rotated the token (null: none recorded). */
  sameFingerprint: boolean | null
  /** Inside REFRESH_REUSE_GRACE_MS of the rotation. */
  withinGrace: boolean
  /** The grant was revoked because of it. */
  revoked: boolean
}

/** A validated authorization request. */
export interface AuthorizationParams {
  client: ResolvedClient
  redirectUri: string
  /** The request named redirect_uri itself (rather than the client's only one). */
  redirectUriProvided: boolean
  codeChallenge: string
  scopes: string[]
  resource: string
  state: string | null
}

export type AuthorizeValidation =
  /** The client or redirect URI cannot be trusted: show an error page, never redirect. */
  | { kind: 'error-page'; message: string }
  /** A trusted redirect exists: send the error back to the client. */
  | {
      kind: 'redirect-error'
      redirectUri: string
      error: string
      description: string
      state: string | null
    }
  | { kind: 'ok'; params: AuthorizationParams }

export interface PendingAuthorizationView {
  id: string
  clientName: string
  clientKind: ResolvedClient['kind']
  /**
   * Host of a metadata-document client's client_id URL — who published the
   * client. Null for a registered client, whose name nobody vouches for.
   */
  publisherHost: string | null
  redirectUri: string
  scopes: string[]
  /** The callback's host, shown prominently on the consent page (MCP spec: MUST display it). */
  redirectHost: string
  /** The callback is a program on the user's own computer. */
  loopback: boolean
  /** Every redirect URI the client declared is a loopback one (the consent page warns harder). */
  loopbackOnly: boolean
  /** The user is asked for `offline_access` (a lasting connection with refresh tokens). */
  offline: boolean
  /** When the client started this request (shown on the consent page). */
  createdAt: Date
}

/** The user behind a token, as the sign-in policy needs it. */
export interface McpTokenOwner {
  userSub: string
  email: string | null
  emailVerified: boolean
}

export interface McpOAuthServiceOptions {
  store: McpOAuthStore
  config: McpPublicConfig
  /**
   * Is the grant's user still allowed to use Narrative? Asked on every
   * access-token verification and refresh, exactly like personal access
   * tokens (production: the sign-in allowlist, createPatOwnerPolicy).
   * Required, so no wiring can forget it.
   */
  isOwnerAllowed: (owner: McpTokenOwner) => Promise<boolean>
  /**
   * Resolves Client ID Metadata Documents. Default: the SSRF-guarded fetcher
   * with the in-memory cache (clientMetadata.ts); tests inject documents.
   */
  clientMetadata?: ClientMetadataResolver
  now?: () => Date
  onBackgroundError?: (err: unknown) => void
  /** Security events (a refresh replay); the runtime logs them. */
  onSecurityEvent?: (event: McpOAuthSecurityEvent) => void
}

export class McpOAuthService {
  private readonly store: McpOAuthStore
  private readonly config: McpPublicConfig
  private readonly now: () => Date
  private readonly onBackgroundError: (err: unknown) => void
  private readonly onSecurityEvent: (event: McpOAuthSecurityEvent) => void
  private readonly isOwnerAllowed: (owner: McpTokenOwner) => Promise<boolean>
  private readonly clientMetadata: ClientMetadataResolver
  private readonly revocationListeners = new Set<(grantId: string) => void>()
  private readonly grantTouches = new Map<string, number>()

  constructor(opts: McpOAuthServiceOptions) {
    this.store = opts.store
    this.config = opts.config
    this.now = opts.now ?? (() => new Date())
    this.onBackgroundError = opts.onBackgroundError ?? (() => undefined)
    this.onSecurityEvent = opts.onSecurityEvent ?? (() => undefined)
    this.isOwnerAllowed = opts.isOwnerAllowed
    this.clientMetadata =
      opts.clientMetadata ??
      createClientMetadataResolver({
        allowedRedirectUris: opts.config.allowedRedirectUris,
        supportedScopes: SUPPORTED_SCOPES,
        now: () => this.now().getTime(),
      })
  }

  get publicConfig(): McpPublicConfig {
    return this.config
  }

  /** Called with the grant id whenever a grant is revoked (MCP sessions of it are closed). */
  onGrantRevoked(listener: (grantId: string) => void): () => void {
    this.revocationListeners.add(listener)
    return () => this.revocationListeners.delete(listener)
  }

  private async revokeGrant(grantId: string): Promise<boolean> {
    const revoked = await this.store.revokeGrant(grantId, this.now())
    if (revoked) for (const l of this.revocationListeners) l(grantId)
    return revoked
  }

  // ── Metadata ────────────────────────────────────────────────────────────

  /** RFC 8414 authorization server metadata. */
  authorizationServerMetadata(): Record<string, unknown> {
    const base = this.config.issuer
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      // Advertised only when dynamic registration is on (MCP_OAUTH_DCR_ENABLED).
      ...(this.config.dcrEnabled ? { registration_endpoint: `${base}/oauth/register` } : {}),
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: [
        'none',
        'client_secret_post',
        'client_secret_basic',
      ],
      scopes_supported: [...SUPPORTED_SCOPES],
      authorization_response_iss_parameter_supported: true,
      // Claude uses a metadata document only when this AND the `none`
      // token endpoint auth method are advertised (clientMetadata.ts).
      client_id_metadata_document_supported: this.config.cimdHosts.length > 0,
      service_documentation: `${this.config.spaOrigin}/`,
    }
  }

  /** RFC 9728 protected resource metadata of the MCP endpoint. */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.config.resource,
      authorization_servers: [this.config.issuer],
      // The resource's own scope; offline_access belongs to the authorization server.
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Narrative',
      resource_documentation: `${this.config.spaOrigin}/`,
    }
  }

  // ── Dynamic client registration (RFC 7591) ──────────────────────────────

  /** The answer to POST /oauth/register while dynamic registration is off. */
  static registrationDisabled(): OAuthError {
    return new OAuthError(
      'invalid_request',
      'Dynamic client registration is not enabled on this server; use a Client ID Metadata Document.',
      404,
    )
  }

  async registerClient(body: unknown): Promise<RegisteredClientResponse> {
    if (!this.config.dcrEnabled) throw McpOAuthService.registrationDisabled()
    if (!isRecord(body))
      throw new OAuthError('invalid_client_metadata', 'the body must be a JSON object')
    const uris = body['redirect_uris']
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`,
      )
    }
    for (const uri of uris) {
      const problem = redirectUriRegistrationProblem(uri, this.config.allowedRedirectUris)
      if (problem !== null)
        throw new OAuthError(
          'invalid_redirect_uri',
          `redirect URI ${JSON.stringify(uri)} ${problem}`,
        )
    }
    const methodRaw = body['token_endpoint_auth_method'] ?? 'client_secret_basic'
    if (
      methodRaw !== 'none' &&
      methodRaw !== 'client_secret_post' &&
      methodRaw !== 'client_secret_basic'
    ) {
      throw new OAuthError(
        'invalid_client_metadata',
        'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic',
      )
    }
    const method: TokenEndpointAuthMethod = methodRaw
    // RFC 7591 §2: no grant_types means authorization_code only (no refresh token).
    const grantTypesRaw = body['grant_types'] ?? DEFAULT_GRANT_TYPES
    if (
      !Array.isArray(grantTypesRaw) ||
      !grantTypesRaw.every((g) => g === 'authorization_code' || g === 'refresh_token') ||
      !grantTypesRaw.includes('authorization_code')
    ) {
      throw new OAuthError(
        'invalid_client_metadata',
        'grant_types must be authorization_code (and optionally refresh_token)',
      )
    }
    const responseTypes = body['response_types'] ?? ['code']
    if (
      !Array.isArray(responseTypes) ||
      responseTypes.length !== 1 ||
      responseTypes[0] !== 'code'
    ) {
      throw new OAuthError('invalid_client_metadata', 'response_types must be ["code"]')
    }
    const scopeRaw = body['scope']
    const scopes =
      scopeRaw === undefined
        ? [...SUPPORTED_SCOPES]
        : typeof scopeRaw === 'string'
          ? parseScopes(scopeRaw)
          : null
    if (scopes === null || !scopes.includes(MCP_SCOPE)) {
      throw new OAuthError(
        'invalid_client_metadata',
        `scope must include "${MCP_SCOPE}" and may add "${OFFLINE_ACCESS_SCOPE}"`,
      )
    }
    const grantTypes = GRANT_TYPES.filter((g) => (grantTypesRaw as unknown[]).includes(g))
    // The name reaches a consent page and the connections list: sanitised
    // like a peer label (control, bidi / invisible and markup characters).
    const nameRaw = body['client_name']
    if (nameRaw !== undefined && nameRaw !== null && typeof nameRaw !== 'string')
      throw new OAuthError('invalid_client_metadata', 'client_name must be a string')
    const clientName = sanitizePeerLabel(nameRaw, MAX_CLIENT_NAME) ?? UNNAMED_CLIENT
    const at = this.now()
    const secret = method === 'none' ? null : mint(CLIENT_SECRET_PREFIX)
    const client: ClientRecord = {
      id: nanoid(24),
      clientName,
      redirectUris: [...(uris as string[])],
      tokenEndpointAuthMethod: method,
      clientSecretHash: secret === null ? null : hashSecret(secret),
      clientUri: optionalString(body, 'client_uri', 512),
      softwareId: optionalString(body, 'software_id', 200),
      softwareVersion: optionalString(body, 'software_version', 100),
      scopes,
      grantTypes,
      createdAt: at,
      lastUsedAt: null,
    }
    await this.store.insertClient(client)
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(at.getTime() / 1000),
      ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: method,
      grant_types: grantTypes,
      response_types: ['code'],
      scope: scopes.join(' '),
    }
  }

  /** The client an authorization request names, or why it cannot be trusted (an error page). */
  private async resolveClient(clientId: string): Promise<ResolvedClient | string> {
    if (isClientIdMetadataUrl(clientId)) {
      // Before any fetch: only documents on allowed hosts (MCP_OAUTH_CIMD_HOSTS).
      let host: string | null = null
      try {
        host = new URL(clientId).host
      } catch {
        // an unparsable URL fails in the resolver with its own message
      }
      if (host !== null && !this.config.cimdHosts.includes(host)) {
        return (
          `This application describes itself at ${host}, which this Narrative server does not accept. ` +
          'An administrator has to add the host to MCP_OAUTH_CIMD_HOSTS before it can connect.'
        )
      }
      try {
        const doc = await this.clientMetadata.resolve(clientId)
        return {
          id: doc.clientId,
          kind: 'metadata_document',
          clientName: doc.clientName,
          redirectUris: doc.redirectUris,
          tokenEndpointAuthMethod: 'none',
          clientSecretHash: null,
          scopes: doc.scopes,
          grantTypes: doc.grantTypes,
        }
      } catch (e) {
        if (e instanceof ClientMetadataError) return e.message
        throw e
      }
    }
    const client = clientId.length <= 64 ? await this.store.getClient(clientId) : null
    return client === null
      ? 'This application is not registered with Narrative. Connect it again from its settings.'
      : registeredClient(client)
  }

  // ── Authorization ───────────────────────────────────────────────────────

  async validateAuthorizationRequest(
    query: Readonly<Record<string, unknown>>,
  ): Promise<AuthorizeValidation> {
    const str = (k: string): string | null => {
      const v = query[k]
      return typeof v === 'string' && v !== '' ? v : null
    }
    const clientId = str('client_id')
    if (clientId === null)
      return { kind: 'error-page', message: 'The request names no client (client_id is missing).' }
    const client = await this.resolveClient(clientId)
    if (typeof client === 'string') return { kind: 'error-page', message: client }
    const requestedRedirectUri = str('redirect_uri')
    const redirectUri =
      requestedRedirectUri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null)
    // Declared by the client AND on the allowlist: a client registered before
    // the allowlist narrowed cannot use a callback it no longer admits.
    if (
      redirectUri === null ||
      !redirectUriMatches(redirectUri, client.redirectUris) ||
      !redirectUriAllowed(redirectUri, this.config.allowedRedirectUris)
    ) {
      return {
        kind: 'error-page',
        message:
          'The application asked to return to an address it did not register. Nothing was shared.',
      }
    }
    const state = str('state')
    const fail = (error: string, description: string): AuthorizeValidation => ({
      kind: 'redirect-error',
      redirectUri,
      error,
      description,
      state: state !== null && state.length <= MAX_STATE ? state : null,
    })
    if (state !== null && state.length > MAX_STATE)
      return fail('invalid_request', 'state is too long')
    if (str('response_type') !== 'code')
      return fail('unsupported_response_type', 'response_type must be code')
    const challenge = str('code_challenge')
    if (challenge === null)
      return fail(
        'invalid_request',
        'PKCE is required: send code_challenge with code_challenge_method=S256',
      )
    if (str('code_challenge_method') !== 'S256')
      return fail('invalid_request', 'only the S256 code_challenge_method is supported')
    if (!PKCE_CHALLENGE.test(challenge))
      return fail('invalid_request', 'code_challenge must be a base64url SHA-256 (43 characters)')
    const requested = parseScopes(str('scope') ?? MCP_SCOPE)
    if (requested === null || !requested.includes(MCP_SCOPE))
      return fail(
        'invalid_scope',
        `scope must include "${MCP_SCOPE}" and may add "${OFFLINE_ACCESS_SCOPE}"`,
      )
    // Only what the client registered (or its document declares), and a
    // lasting connection only for a client that may use refresh tokens.
    const scopes = requested.filter(
      (s) =>
        (client.scopes === null || client.scopes.includes(s)) &&
        (s !== OFFLINE_ACCESS_SCOPE || allowsRefresh(client.grantTypes)),
    )
    if (!scopes.includes(MCP_SCOPE))
      return fail('invalid_scope', `this client is not registered for the "${MCP_SCOPE}" scope`)
    const resource = str('resource') ?? this.config.resource
    if (!sameResource(resource, this.config.resource)) {
      return fail('invalid_target', `resource must be ${this.config.resource}`)
    }
    return {
      kind: 'ok',
      params: {
        client,
        redirectUri,
        redirectUriProvided: requestedRedirectUri !== null,
        codeChallenge: challenge,
        scopes,
        resource: this.config.resource,
        state,
      },
    }
  }

  /**
   * Store a validated request; returns its id. The consent form's CSRF token
   * is minted when the page is shown to a signed-in user
   * (openAuthorizationForUser); until then the stored hash matches nothing.
   */
  async createAuthorization(params: AuthorizationParams): Promise<{ id: string }> {
    const at = this.now()
    const record: AuthorizationRecord = {
      id: randomBytes(24).toString('base64url'),
      clientId: params.client.id,
      clientName: params.client.clientName,
      clientRedirectUris: [...params.client.redirectUris],
      redirectUri: params.redirectUri,
      redirectUriProvided: params.redirectUriProvided,
      clientGrantTypes: params.client.grantTypes === null ? null : [...params.client.grantTypes],
      codeChallenge: params.codeChallenge,
      scopes: params.scopes,
      resource: params.resource,
      state: params.state,
      csrfHash: hashSecret(randomBytes(32).toString('base64url')),
      userSub: null,
      createdAt: at,
      expiresAt: new Date(at.getTime() + AUTHORIZATION_REQUEST_TTL_MS),
      decidedAt: null,
      decision: null,
      codeHash: null,
      codeExpiresAt: null,
      exchangedAt: null,
      grantId: null,
    }
    await this.store.insertAuthorization(record)
    return { id: record.id }
  }

  /**
   * The pending request behind a consent page, bound to the signed-in user
   * who opens it (a request shown to one user can never be decided by
   * another), with a fresh CSRF token for the consent form (the latest page
   * shown is the one that can be submitted). Null when unknown, expired,
   * decided or bound to someone else.
   */
  async openAuthorizationForUser(
    id: string,
    userSub: string,
  ): Promise<{ view: PendingAuthorizationView; csrfToken: string } | null> {
    if (id.length === 0 || id.length > 64) return null
    const a = await this.store.getAuthorization(id)
    if (a === null) return null
    const csrfToken = randomBytes(32).toString('base64url')
    if (!(await this.store.bindAuthorizationUser(id, userSub, hashSecret(csrfToken), this.now())))
      return null
    // The snapshot taken at /authorize; requests stored before migration
    // 0021 fall back to the registered client's row.
    const metadataClient = isClientIdMetadataUrl(a.clientId)
    let clientName = a.clientName
    let declared = a.clientRedirectUris
    if (!metadataClient && (clientName === null || declared === null)) {
      const client = await this.store.getClient(a.clientId)
      if (client === null) return null
      clientName ??= client.clientName
      declared ??= client.redirectUris
    }
    return {
      csrfToken,
      view: {
        id: a.id,
        clientName: clientName ?? UNKNOWN_CLIENT_NAME,
        clientKind: metadataClient ? 'metadata_document' : 'registered',
        publisherHost: metadataClient ? new URL(a.clientId).host : null,
        redirectUri: a.redirectUri,
        scopes: a.scopes,
        redirectHost: new URL(a.redirectUri).host,
        loopback: isLoopbackRedirect(a.redirectUri),
        loopbackOnly: onlyLoopbackRedirects(declared ?? [a.redirectUri]),
        offline: a.scopes.includes(OFFLINE_ACCESS_SCOPE),
        createdAt: a.createdAt,
      },
    }
  }

  /**
   * The consent decision. Returns where to send the browser: the client's
   * callback with `code` (approve) or `error=access_denied` (deny), plus
   * `state` and `iss` (RFC 9207). Throws OAuthError when the request is not
   * decidable by this user with this CSRF token.
   */
  async decide(
    id: string,
    userSub: string,
    csrfToken: string,
    approve: boolean,
  ): Promise<{
    redirectTo: string
    connected: { clientName: string; redirectUri: string } | null
  }> {
    const a = id.length > 0 && id.length <= 64 ? await this.store.getAuthorization(id) : null
    if (a === null || a.userSub !== userSub || !hashesEqual(a.csrfHash, hashSecret(csrfToken))) {
      throw new OAuthError(
        'invalid_request',
        'This authorization request is not valid for you. Start again from the application.',
        403,
      )
    }
    const code = mint(CODE_PREFIX)
    const at = this.now()
    const decided = await this.store.decideAuthorization(
      id,
      userSub,
      approve
        ? {
            approved: true,
            codeHash: hashSecret(code),
            codeExpiresAt: new Date(at.getTime() + AUTHORIZATION_CODE_TTL_MS),
          }
        : { approved: false },
      at,
    )
    if (!decided) {
      throw new OAuthError(
        'invalid_request',
        'This authorization request has expired or was already answered. Start again from the application.',
        400,
      )
    }
    const url = new URL(a.redirectUri)
    if (approve) url.searchParams.set('code', code)
    else {
      url.searchParams.set('error', 'access_denied')
      url.searchParams.set('error_description', 'The user denied access')
    }
    if (a.state !== null) url.searchParams.set('state', a.state)
    url.searchParams.set('iss', this.config.issuer)
    return {
      redirectTo: url.toString(),
      connected: approve
        ? { clientName: a.clientName ?? a.clientId, redirectUri: a.redirectUri }
        : null,
    }
  }

  /** The error redirect for a request that failed validation after its redirect URI was trusted. */
  errorRedirect(v: Extract<AuthorizeValidation, { kind: 'redirect-error' }>): string {
    const url = new URL(v.redirectUri)
    url.searchParams.set('error', v.error)
    url.searchParams.set('error_description', v.description)
    if (v.state !== null) url.searchParams.set('state', v.state)
    url.searchParams.set('iss', this.config.issuer)
    return url.toString()
  }

  // ── Token endpoint ──────────────────────────────────────────────────────

  /**
   * Authenticate (or, for public clients, identify) the client at the token
   * or revocation endpoint. A metadata-document client is public: its
   * client_id must be a valid document URL, and the caller then checks it
   * equals the one the code or grant was issued to — no fetch here, so the
   * token endpoint never waits on a third-party host. An unknown registered
   * client is `invalid_client`, except on a refresh, where it means the
   * refresh token cannot be valid either (`invalid_grant`, so Claude signs
   * in afresh instead of giving up).
   */
  private async authenticateClient(
    creds: ClientCredentials,
    purpose: 'code' | 'refresh' | 'revoke',
  ): Promise<ResolvedClient> {
    const unknown = (): OAuthError =>
      purpose === 'refresh'
        ? new OAuthError('invalid_grant', 'unknown or expired refresh token')
        : new OAuthError('invalid_client', 'client authentication failed', 401)
    if (creds.clientId === null)
      throw new OAuthError('invalid_client', 'client authentication failed', 401)
    if (isClientIdMetadataUrl(creds.clientId)) {
      if (clientIdUrlProblem(creds.clientId) !== null) throw unknown()
      return {
        id: creds.clientId,
        kind: 'metadata_document',
        clientName: creds.clientId,
        redirectUris: [],
        tokenEndpointAuthMethod: 'none',
        clientSecretHash: null,
        // Not refetched here: the grant carries the document's grant types.
        scopes: null,
        grantTypes: null,
      }
    }
    const row = creds.clientId.length <= 64 ? await this.store.getClient(creds.clientId) : null
    if (row === null) throw unknown()
    const client = registeredClient(row)
    if (client.tokenEndpointAuthMethod === 'none') return client
    const expectedVia = client.tokenEndpointAuthMethod === 'client_secret_basic' ? 'basic' : 'post'
    if (
      creds.clientSecret === null ||
      creds.via !== expectedVia ||
      client.clientSecretHash === null ||
      !hashesEqual(client.clientSecretHash, hashSecret(creds.clientSecret))
    ) {
      throw new OAuthError('invalid_client', 'client authentication failed', 401)
    }
    return client
  }

  private async issueTokens(
    grantId: string,
    scopes: readonly string[],
    withRefresh: boolean,
  ): Promise<TokenResponse> {
    const at = this.now()
    const access = mint(ACCESS_TOKEN_PREFIX)
    await this.store.insertToken({
      tokenHash: hashSecret(access),
      grantId,
      kind: 'access',
      createdAt: at,
      expiresAt: new Date(at.getTime() + ACCESS_TOKEN_TTL_MS),
      usedAt: null,
      usedByFingerprint: null,
      revokedAt: null,
    })
    let refresh: string | undefined
    if (withRefresh) {
      refresh = mint(REFRESH_TOKEN_PREFIX)
      await this.store.insertToken({
        tokenHash: hashSecret(refresh),
        grantId,
        kind: 'refresh',
        createdAt: at,
        expiresAt: new Date(at.getTime() + REFRESH_TOKEN_TTL_MS),
        usedAt: null,
        usedByFingerprint: null,
        revokedAt: null,
      })
    }
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      ...(refresh === undefined ? {} : { refresh_token: refresh }),
      scope: scopes.join(' '),
    }
  }

  /** Record a registered client's use, off the token endpoint's critical path. */
  private touchClientLater(client: ResolvedClient, at: Date): void {
    if (client.kind !== 'registered') return
    this.store.touchClient(client.id, at).catch(this.onBackgroundError)
  }

  /**
   * Housekeeping, run hourly by the runtime (never on a request path):
   * delete expired tokens and authorization requests, and registered
   * clients that have had no live grant and no use for
   * STALE_REGISTERED_CLIENT_MS (DCR clients pile up — one per fresh
   * connection).
   */
  async runMaintenance(): Promise<{
    staleClients: number
    purgedAuthorizations: number
    purgedGrants: number
  }> {
    const at = this.now()
    await this.store.purgeExpired(new Date(at.getTime() - AUTHORIZATION_REQUEST_TTL_MS))
    const staleClients = await this.store.deleteStaleRegisteredClients(
      new Date(at.getTime() - STALE_REGISTERED_CLIENT_MS),
      at,
    )
    const purged = await this.store.purgeRetained(new Date(at.getTime() - RETENTION_MS))
    for (const [grantId, touchedAt] of this.grantTouches)
      if (at.getTime() - touchedAt >= GRANT_TOUCH_INTERVAL_MS) this.grantTouches.delete(grantId)
    return {
      staleClients,
      purgedAuthorizations: purged.authorizations,
      purgedGrants: purged.grants,
    }
  }

  async token(
    form: Readonly<Record<string, unknown>>,
    creds: ClientCredentials,
    request?: TokenRequestInfo,
  ): Promise<TokenResponse> {
    const grantType = form['grant_type']
    if (grantType === 'authorization_code') return this.exchangeCode(form, creds)
    if (grantType === 'refresh_token') return this.refresh(form, creds, requestFingerprint(request))
    throw new OAuthError(
      'unsupported_grant_type',
      'grant_type must be authorization_code or refresh_token',
    )
  }

  private async exchangeCode(
    form: Readonly<Record<string, unknown>>,
    creds: ClientCredentials,
  ): Promise<TokenResponse> {
    const client = await this.authenticateClient(creds, 'code')
    const code = form['code']
    const verifier = form['code_verifier']
    const redirectUri = form['redirect_uri']
    if (typeof code !== 'string' || !RAW_SECRET.test(code))
      throw new OAuthError('invalid_grant', 'unknown or expired authorization code')
    if (typeof verifier !== 'string' || !PKCE_VERIFIER.test(verifier)) {
      throw new OAuthError('invalid_request', 'code_verifier is required (43 to 128 characters)')
    }
    const codeHash = hashSecret(code)
    const at = this.now()
    const claimed = await this.store.claimCode(codeHash, at)
    if (claimed === null) {
      // Unknown — or used before: a replayed code revokes what it produced.
      const used = await this.store.findAuthorizationByCode(codeHash)
      if (used?.grantId) await this.revokeGrant(used.grantId)
      throw new OAuthError('invalid_grant', 'unknown, expired or already used authorization code')
    }
    if (
      claimed.decision !== 'approved' ||
      claimed.codeExpiresAt === null ||
      claimed.codeExpiresAt <= at ||
      claimed.userSub === null
    ) {
      throw new OAuthError('invalid_grant', 'unknown, expired or already used authorization code')
    }
    if (claimed.clientId !== client.id)
      throw new OAuthError('invalid_grant', 'the code was issued to another client')
    // RFC 6749 §4.1.3: required, and identical, when /authorize had one.
    if (claimed.redirectUriProvided && typeof redirectUri !== 'string') {
      throw new OAuthError(
        'invalid_grant',
        'redirect_uri is required: the authorization request named one, so the token request must repeat it',
      )
    }
    if (typeof redirectUri === 'string' && redirectUri !== claimed.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request')
    }
    if (!s256Matches(verifier, claimed.codeChallenge))
      throw new OAuthError('invalid_grant', 'PKCE verification failed')
    const resource = form['resource']
    if (
      resource !== undefined &&
      (typeof resource !== 'string' || !sameResource(resource, claimed.resource))
    ) {
      throw new OAuthError('invalid_target', `resource must be ${claimed.resource}`)
    }
    const grantId = nanoid(24)
    await this.store.insertGrant({
      id: grantId,
      clientId: client.id,
      clientName: claimed.clientName ?? (client.kind === 'registered' ? client.clientName : null),
      redirectUri: claimed.redirectUri,
      userSub: claimed.userSub,
      scopes: claimed.scopes,
      grantTypes: claimed.clientGrantTypes,
      resource: claimed.resource,
      createdAt: at,
      lastUsedAt: null,
      revokedAt: null,
      flaggedAt: null,
      flagReason: null,
    })
    await this.store.setAuthorizationGrant(claimed.id, grantId)
    this.touchClientLater(client, at)
    return this.issueTokens(
      grantId,
      claimed.scopes,
      claimed.scopes.includes(OFFLINE_ACCESS_SCOPE) && allowsRefresh(claimed.clientGrantTypes),
    )
  }

  private async refresh(
    form: Readonly<Record<string, unknown>>,
    creds: ClientCredentials,
    fingerprint: string | null,
  ): Promise<TokenResponse> {
    const client = await this.authenticateClient(creds, 'refresh')
    const raw = form['refresh_token']
    if (typeof raw !== 'string' || !raw.startsWith(REFRESH_TOKEN_PREFIX) || !RAW_SECRET.test(raw)) {
      throw new OAuthError('invalid_grant', 'unknown or expired refresh token')
    }
    const hash = hashSecret(raw)
    const found = await this.store.findToken(hash)
    const at = this.now()
    if (found === null || found.token.kind !== 'refresh')
      throw new OAuthError('invalid_grant', 'unknown or expired refresh token')
    if (found.grant.clientId !== client.id)
      throw new OAuthError('invalid_grant', 'the refresh token was issued to another client')
    // A client (or grant) without the refresh_token grant type may not refresh.
    if (!allowsRefresh(found.grant.grantTypes) || !allowsRefresh(client.grantTypes)) {
      throw new OAuthError(
        'unauthorized_client',
        'this client is not registered for the refresh_token grant type',
      )
    }
    if (
      found.grant.revokedAt !== null ||
      found.token.revokedAt !== null ||
      found.token.expiresAt <= at
    ) {
      throw new OAuthError('invalid_grant', 'unknown or expired refresh token')
    }
    if (!(await this.ownerAllowed(found)))
      throw new OAuthError('invalid_grant', 'the user is no longer allowed to use Narrative')
    const scope = form['scope']
    if (
      scope !== undefined &&
      (typeof scope !== 'string' ||
        !scope
          .split(' ')
          .filter(Boolean)
          .every((s) => found.grant.scopes.includes(s)))
    ) {
      throw new OAuthError('invalid_scope', 'a refresh cannot widen the granted scope')
    }
    const resource = form['resource']
    if (
      resource !== undefined &&
      (typeof resource !== 'string' || !sameResource(resource, found.grant.resource))
    ) {
      throw new OAuthError('invalid_target', `resource must be ${found.grant.resource}`)
    }
    if (!(await this.store.useRefreshToken(hash, at, fingerprint))) {
      await this.handleRefreshReplay(hash, found.grant, fingerprint, at)
      throw new OAuthError('invalid_grant', 'refresh token already used')
    }
    this.touchClientLater(client, at)
    // A refresh token exists only for a grant that was given one: keep rotating.
    return this.issueTokens(found.grant.id, found.grant.scopes, true)
  }

  /**
   * A refresh token presented after its rotation (the rule is in the file
   * header): always a security event and a flag on the grant; the grant is
   * kept only when the replay is the first rotator racing itself inside the
   * grace window.
   */
  private async handleRefreshReplay(
    hash: string,
    grant: { id: string; clientId: string; userSub: string },
    fingerprint: string | null,
    at: Date,
  ): Promise<void> {
    const used = (await this.store.findToken(hash))?.token
    const usedAt = used?.usedAt ?? null
    const rotator = used?.usedByFingerprint ?? null
    const withinGrace = usedAt !== null && at.getTime() - usedAt.getTime() <= REFRESH_REUSE_GRACE_MS
    const sameFingerprint =
      rotator === null || fingerprint === null ? null : rotator === fingerprint
    const revoke = !(withinGrace && sameFingerprint === true)
    await this.store.flagGrant(
      grant.id,
      revoke
        ? 'A refresh token was replayed by someone other than the client that used it first; the connection was revoked.'
        : 'A refresh token was used twice in quick succession by the same client.',
      at,
    )
    if (revoke) await this.revokeGrant(grant.id)
    this.onSecurityEvent({
      event: 'mcp_oauth_refresh_replay',
      grantId: grant.id,
      clientId: grant.clientId,
      userSub: grant.userSub,
      sameFingerprint,
      withinGrace,
      revoked: revoke,
    })
  }

  /** RFC 7009: always succeeds for the caller; revokes the token's whole grant when it belongs to the client. */
  async revoke(form: Readonly<Record<string, unknown>>, creds: ClientCredentials): Promise<void> {
    const client = await this.authenticateClient(creds, 'revoke')
    const raw = form['token']
    if (typeof raw !== 'string' || !RAW_SECRET.test(raw)) return
    const found = await this.store.findToken(hashSecret(raw))
    if (found === null || found.grant.clientId !== client.id) return
    await this.revokeGrant(found.grant.id)
  }

  // ── Resource server side (/mcp) ─────────────────────────────────────────

  /** Resolve an access token for the MCP resource; null when unknown, expired, revoked or for another resource. */
  async verifyAccessToken(raw: string): Promise<VerifiedMcpToken | null> {
    if (!raw.startsWith(ACCESS_TOKEN_PREFIX) || !RAW_SECRET.test(raw)) return null
    const found = await this.store.findToken(hashSecret(raw))
    if (found === null || found.token.kind !== 'access') return null
    const at = this.now()
    if (
      found.token.revokedAt !== null ||
      found.grant.revokedAt !== null ||
      found.token.expiresAt <= at
    )
      return null
    // Audience (RFC 8707): only tokens issued for this MCP resource.
    if (!sameResource(found.grant.resource, this.config.resource)) return null
    if (!found.grant.scopes.includes(MCP_SCOPE)) return null
    if (!(await this.ownerAllowed(found))) return null
    this.recordGrantUse(found.grant.id, at)
    return {
      grantId: found.grant.id,
      clientId: found.client.id,
      clientName: found.client.clientName,
      userSub: found.grant.userSub,
      email: found.userEmail,
      name: found.userName,
      scopes: found.grant.scopes,
    }
  }

  private ownerAllowed(found: {
    grant: { userSub: string }
    userEmail: string | null
    userEmailVerified: boolean
  }): Promise<boolean> {
    return this.isOwnerAllowed({
      userSub: found.grant.userSub,
      email: found.userEmail,
      emailVerified: found.userEmailVerified,
    })
  }

  private recordGrantUse(grantId: string, at: Date): void {
    const last = this.grantTouches.get(grantId) ?? 0
    if (at.getTime() - last < GRANT_TOUCH_INTERVAL_MS) return
    this.grantTouches.set(grantId, at.getTime())
    this.store
      .touchGrant(grantId, at, new Date(at.getTime() - GRANT_TOUCH_INTERVAL_MS))
      .catch(this.onBackgroundError)
  }

  /**
   * Is the grant still live for `userSub` — not revoked, theirs, and its
   * user still allowed to sign in? For the MCP session sweep, which closes
   * sessions whose credential died out of process (mcp/sessions.ts).
   */
  async isGrantLive(grantId: string, userSub: string): Promise<boolean> {
    const found = await this.store.getGrantOwner(grantId)
    if (found === null || found.grant.revokedAt !== null || found.grant.userSub !== userSub)
      return false
    return this.ownerAllowed(found)
  }

  // ── The user's connections (account settings) ───────────────────────────

  async listConnections(userSub: string): Promise<ConnectionRecord[]> {
    return this.store.listUserGrants(userSub)
  }

  async revokeConnection(userSub: string, grantId: string): Promise<boolean> {
    const revoked = await this.store.revokeUserGrant(userSub, grantId, this.now())
    if (revoked) for (const l of this.revocationListeners) l(grantId)
    return revoked
  }
}
