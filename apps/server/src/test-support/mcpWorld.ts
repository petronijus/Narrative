/**
 * test-support/mcpWorld.ts — the MCP server over real HTTP for tests: the
 * agent world (real Hocuspocus + agent runtime, test-support/agentWorld.ts)
 * with the default registry plus the fake commands (fakeCommands.ts), a
 * Fastify app with the production auth plugin over an in-memory PAT store,
 * and the MCP routes over an in-memory OAuth store, listening on a free
 * port so the SDK's own client can talk to it.
 *
 * Browser sessions: tests that need one mock `lookupSession`
 * (auth/session.js) themselves; see mcp/oauth/oauth.test.ts.
 *
 * Excluded from the build (tsconfig.build.json: src/test-support/**).
 */

import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
  type ClientCapabilities,
  type ElicitRequest,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import { createPatService, type PatScope, type PatService } from '../auth/personalAccessTokens.js'
import type { Database } from '../db/client.js'
import { buildMcpPublicConfig } from '../mcp/config.js'
import { registerMcpRoutes, type McpRouteDeps } from '../mcp/routes.js'
import { createMcpRuntime, type McpRuntime } from '../mcp/runtime.js'
import { createMemoryOAuthStore, type MemoryOAuthStore } from '../mcp/oauth/store.js'
import type { McpTokenOwner } from '../mcp/oauth/service.js'
import type { FetchedClientMetadata } from '../mcp/oauth/clientMetadata.js'
import { createAgentWorld, type AgentWorld } from './agentWorld.js'
import { registryWithFakes } from './fakeCommands.js'
import { allowAllPatOwners, createMemoryPatStore, type MemoryPatStore } from './memoryPatStore.js'

export interface McpWorld {
  /** Credential keys revoked OAuth grants handed to `onCredentialRevoked` (their upload sessions go). */
  revokedCredentials: string[]
  world: AgentWorld
  app: FastifyInstance
  mcp: McpRuntime
  pats: PatService
  patStore: MemoryPatStore
  oauthStore: MemoryOAuthStore
  /** http://127.0.0.1:<port> — the API's public base in these tests. */
  baseUrl: string
  /** Mint a PAT for a user. */
  token(userSub: string, scopes?: PatScope[]): Promise<string>
  /** Connect an SDK client with a bearer token. */
  client(
    token: string,
    opts?: {
      capabilities?: ClientCapabilities
      name?: string
      /** Answer elicitation requests (declare `elicitation` in capabilities too). */
      onElicit?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>
      /** `notifications/elicitation/complete` the server sent (URL mode). */
      onElicitationComplete?: (elicitationId: string) => void
    },
  ): Promise<Client>
  /** Owners the OAuth sign-in policy refuses (to simulate a removed user). */
  refusedOwners: Set<string>
  /** Move the clock (OAuth expiry tests). */
  advance(ms: number): void
  /**
   * Client ID Metadata Documents the fake fetcher serves, by URL: a JSON
   * value (served as application/json with `cacheControl`), or an Error to
   * throw. Unlisted URLs fail like an unreachable host.
   */
  metadataDocuments: Map<string, { body: unknown; cacheControl?: string | null } | Error>
  /** URLs the fake metadata fetcher was asked for, in order. */
  metadataFetches: string[]
  destroy(): Promise<void>
}

export async function createMcpWorld(
  opts: {
    sessionIdleMs?: number
    maxSessionsPerUser?: number
    /**
     * Dynamic client registration (default ON here: most OAuth tests register
     * a client; production defaults it off — MCP_OAUTH_DCR_ENABLED).
     */
    dcrEnabled?: boolean
    /** MCP_OAUTH_CIMD_HOSTS (default: the production default, claude.ai). */
    cimdHosts?: readonly string[]
    /** AGENT_URL_FETCH_ALLOWED_HOSTS (default: none). */
    urlFetchAllowedHosts?: readonly string[]
  } = {},
): Promise<McpWorld> {
  const world = await createAgentWorld({
    registry: registryWithFakes(),
    ...(opts.urlFetchAllowedHosts === undefined
      ? {}
      : { urlFetchAllowedHosts: opts.urlFetchAllowedHosts }),
  })
  const patStore = createMemoryPatStore()
  const pats = createPatService(patStore, { isOwnerAllowed: allowAllPatOwners })
  const oauthStore = createMemoryOAuthStore()
  const refusedOwners = new Set<string>()
  const metadataDocuments: McpWorld['metadataDocuments'] = new Map()
  const metadataFetches: string[] = []
  const fetchClientMetadata = async (url: string): Promise<FetchedClientMetadata> => {
    metadataFetches.push(url)
    const doc = metadataDocuments.get(url)
    if (doc === undefined || doc instanceof Error) throw doc ?? new Error(`no document at ${url}`)
    return {
      body: Buffer.from(JSON.stringify(doc.body)),
      contentType: 'application/json',
      cacheControl: doc.cacheControl ?? null,
    }
  }
  let offset = 0
  const now = (): Date => new Date(Date.now() + offset)
  /** Credential keys the runtime reported revoked (onCredentialRevoked). */
  const revokedCredentials: string[] = []

  const app = Fastify({ logger: false })
  await app.register(cookie, { secret: 'test-cookie-secret-test-cookie-secret' })
  registerAuthPlugin(app, { bypass: false, db: {} as Database, pats })
  // Routes read `mcp` per request, so it can be created once the port is known.
  const deps: McpRouteDeps = {
    mcp: undefined as unknown as McpRuntime,
    allowedOrigins: ['http://localhost:5173'],
  }
  await registerMcpRoutes(app, deps)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const mcp = createMcpRuntime({
    agent: world.runtime,
    config: buildMcpPublicConfig({
      apiBaseUrl: baseUrl,
      spaOrigin: baseUrl,
      dcrEnabled: opts.dcrEnabled ?? true,
      ...(opts.cimdHosts === undefined ? {} : { cimdHosts: opts.cimdHosts }),
    }),
    oauthStore,
    isOwnerAllowed: async (owner: McpTokenOwner) => !refusedOwners.has(owner.userSub),
    pats,
    onCredentialRevoked: async (key) => {
      revokedCredentials.push(key)
      return 0
    },
    version: '0.0.0-test',
    log: app.log,
    sweep: false,
    now,
    fetchClientMetadata,
    ...(opts.sessionIdleMs === undefined ? {} : { sessionIdleMs: opts.sessionIdleMs }),
    ...(opts.maxSessionsPerUser === undefined
      ? {}
      : { maxSessionsPerUser: opts.maxSessionsPerUser }),
  })
  deps.mcp = mcp
  const clients: Client[] = []

  return {
    world,
    app,
    mcp,
    pats,
    patStore,
    oauthStore,
    baseUrl,
    refusedOwners,
    revokedCredentials,
    metadataDocuments,
    metadataFetches,
    advance(ms) {
      offset += ms
    },
    async token(userSub, scopes = ['mcp']) {
      const { token } = await pats.create(userSub, {
        name: `test ${userSub}`,
        scopes,
        expiresInDays: 30,
      })
      return token
    },
    async client(token, clientOpts = {}) {
      const client = new Client(
        { name: clientOpts.name ?? 'test-client', version: '1.0.0' },
        { capabilities: clientOpts.capabilities ?? {} },
      )
      if (clientOpts.onElicit !== undefined) {
        const onElicit = clientOpts.onElicit
        client.setRequestHandler(ElicitRequestSchema, (request) => onElicit(request))
      }
      if (clientOpts.onElicitationComplete !== undefined) {
        const onComplete = clientOpts.onElicitationComplete
        client.setNotificationHandler(ElicitationCompleteNotificationSchema, (n) =>
          onComplete(n.params.elicitationId),
        )
      }
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
      // exactOptionalPropertyTypes vs the SDK's own Transport interface (see mcp/sessions.ts).
      await client.connect(transport as unknown as Transport)
      clients.push(client)
      return client
    },
    async destroy() {
      for (const c of clients) await c.close().catch(() => undefined)
      await app.close()
      await world.destroy()
    },
  }
}
