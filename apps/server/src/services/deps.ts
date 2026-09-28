/**
 * services/deps.ts — what every server service is built from.
 */

import type { FastifyBaseLogger } from 'fastify'
import type { Hocuspocus } from '@hocuspocus/server'
import type { AgentRunService } from '@narrative/commands'
import type { Database } from '../db/client.js'
import type { UploadSessionService } from '../media/uploadSessions.js'

export interface ServiceDeps {
  db: Database
  log: FastifyBaseLogger
  /**
   * BYPASS_AUTH dev mode: the synthesized `dev-user` also sees the legacy
   * `demo-user`'s decks and folders, exactly as the routes always did.
   * Never true in production (assertAuthBootSafety refuses to boot).
   */
  bypass?: boolean
  /**
   * The live sync server, for reading and writing documents people have
   * open. Defaults to the process-wide instance (hocuspocus/presence.ts);
   * null when no sync server runs in this process (route-only unit tests),
   * in which case documents are read from and written to Postgres directly.
   */
  hocuspocus?: () => Hocuspocus | null
  /**
   * The process's agent run manager (services/runs.ts): one stateful object
   * holding open runs and their undo histories, shared by every service set
   * the agent host builds. Absent in processes without an agent host
   * (route-only unit tests); run commands then fail with `wrong_host`.
   */
  runs?: AgentRunService
  /**
   * Public origin of the web app (`https://narrative.example`), for links an
   * agent hands to the user (`editor.present.link`). SPA_ORIGIN in index.ts.
   */
  appOrigin?: string
  /**
   * Public base URL of the API (PUBLIC_API_URL, mcp/config.ts): where an
   * agent sends a file with an upload session (`media.uploadSession`).
   */
  apiBaseUrl?: string
  /** Upload session tokens (default: the Postgres-backed service). */
  uploadSessions?: UploadSessionService
}
