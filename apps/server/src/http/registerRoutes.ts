/**
 * http/registerRoutes.ts
 *
 * Every HTTP route of the API, registered in one place. `index.ts` calls
 * this for the real server; `routes/agentParity.test.ts` calls it on a bare
 * Fastify instance to enumerate the route table, so the agent-parity route
 * guard (docs/plans/agentic-layer.md §9.1) sees exactly the routes
 * production serves — a route registered anywhere else would escape it.
 *
 * Plugins that add no routes (CORS, cookies, Sentry, the auth plugin, the
 * bodyless-request compat hook) stay in `index.ts`; they must be registered
 * before this runs.
 */

import type { UploadSessionService } from '../media/uploadSessions.js'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { registerDeckRoutes } from '../routes/decks.js'
import { registerDevRenderRoutes } from '../routes/devRender.js'
import { registerFolderRoutes } from '../routes/folders.js'
import { registerComponentRoutes } from '../routes/components.js'
import { registerTokenRoutes } from '../routes/tokens.js'
import { registerSharingRoutes } from '../routes/sharing.js'
import { registerFolderSharingRoutes } from '../routes/folderSharing.js'
import { registerPptxImportRoutes } from '../routes/pptxImport.js'
import { registerPptxExportRoutes } from '../routes/pptxExport.js'
import { registerPngExportRoutes } from '../routes/pngExport.js'
import { registerAuthRoutes, type AuthRoutesOpts } from '../routes/auth.js'
import { registerAccessTokenRoutes } from '../routes/accessTokens.js'
import { registerTusPlugin } from '../media/tus.js'
import { registerMediaRoutes } from '../media/routes.js'
import { registerMetricsEndpoint } from '../metrics/index.js'
import { registerAgentRoutes } from '../routes/agent.js'
import { registerAgentConfirmationRoutes } from '../routes/agentConfirmations.js'
import type { AgentRuntime } from '../agent/runtime.js'
import { registerMcpRoutes, type McpRouteDeps } from '../mcp/routes.js'

export interface HttpRouteDeps {
  db: Database
  /**
   * Whether to serve GET /metrics. Production only registers it when
   * METRICS_TOKEN is set (see `metricsRegistrationDecision`); the caller
   * decides and logs why.
   */
  metrics: boolean
  /** Options of the server-driven OAuth routes (`db` comes from above). */
  auth: Omit<AuthRoutesOpts, 'db'>
  /**
   * The agent host (agent/runtime.ts) behind POST /api/commands and the
   * Agent activity routes. Route handlers close over it; registering the
   * routes never touches it.
   */
  agent: AgentRuntime
  /**
   * The MCP server (/mcp) and its OAuth authorization server (mcp/). Like
   * `agent`, only its handlers read it.
   */
  mcp: McpRouteDeps
  /** Upload session tokens the tus server accepts (`media.uploadSession`). */
  uploadSessions: UploadSessionService
  /**
   * Development routes (BYPASS_AUTH only — refused in production by
   * `assertAuthBootSafety`): POST /dev/render-token for the e2e suite (routes/devRender.ts).
   */
  devRoutes: boolean
}

export async function registerHttpRoutes(app: FastifyInstance, deps: HttpRouteDeps): Promise<void> {
  const { db } = deps

  // Liveness probe for Docker healthchecks and the reverse proxy.
  app.get('/health', async (_request, _reply) => {
    return { status: 'ok' }
  })

  // Prometheus metrics. /metrics leaks connection counts / doc sizes; the
  // endpoint gates itself by METRICS_TOKEN (loopback-only fallback in dev).
  if (deps.metrics) await registerMetricsEndpoint(app)

  // Development only: render tokens for the e2e suite (routes/devRender.ts).
  if (deps.devRoutes) await registerDevRenderRoutes(app, db)

  // Deck routes
  await registerDeckRoutes(app, db)

  // Folder routes (M16 P1)
  await registerFolderRoutes(app, db)

  // Component routes (M16 P5)
  await registerComponentRoutes(app, db)

  // Token usage scanning (M16 P4)
  await registerTokenRoutes(app, db)

  // Sharing routes (permissions + share links)
  await registerSharingRoutes(app, db)

  // Folder sharing — members and email invites (folder-sharing step 3)
  await registerFolderSharingRoutes(app, db)

  // PowerPoint import — synchronous parse + Y.Doc write (M28 phase 3 MVP)
  await registerPptxImportRoutes(app, db)

  // PowerPoint export — synchronous Y.Doc → .pptx (pptx/ooxml/writeDeck)
  await registerPptxExportRoutes(app, db)
  // One slide as PNG, rendered by the render worker (A3).
  await registerPngExportRoutes(app, db)

  // Server-driven OAuth flow + session cookie minting (replaces the old
  // browser-PKCE + Bearer-id_token path). Public endpoints by design.
  registerAuthRoutes(app, { db, ...deps.auth })

  // Personal access tokens (agentic A1) — session-cookie only, never a PAT.
  registerAccessTokenRoutes(app)

  // Media routes: tus upload + signed URL + delete
  registerTusPlugin(app, { db, uploadSessions: deps.uploadSessions })
  await registerMediaRoutes(app, { db })

  // Agent host (agentic A1, ADR 0011): the command API for scripts, and the
  // Agent activity popover's run list + revert.
  await registerAgentRoutes(app, { agent: deps.agent })

  // The confirmation page's API: a signed-in person approves or declines an
  // agent call that needs their confirmation (session cookie only).
  await registerAgentConfirmationRoutes(app, { confirmations: () => deps.agent.confirmations })

  // MCP server (agentic A1, ADR 0011): /mcp for Claude clients, plus the
  // OAuth routes claude.ai connectors sign in through.
  await registerMcpRoutes(app, deps.mcp)
}
