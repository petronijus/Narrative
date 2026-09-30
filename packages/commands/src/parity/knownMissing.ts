/**
 * commands/src/parity/knownMissing.ts
 *
 * Capabilities a user has today (or that the plan adds) which are NOT yet a
 * command. This list only ever shrinks: each phase of
 * docs/plans/agentic-layer.md removes its entries as it adds the commands,
 * and the parity test fails if an entry of an already-finished phase is
 * still here.
 *
 * `writers` names the slide-model exports the capability will use. A
 * slide-model writer that no command uses must be listed here, or the parity
 * test fails — that is what stops a new mutation from silently skipping the
 * agent surface.
 *
 * `routes` names the API routes the capability will wrap. The server's route
 * guard (apps/server/src/routes/agentParity.test.ts) fails for any Fastify
 * route that no command, known-missing entry or allowlist entry claims, and
 * for any route claimed here that the server no longer registers.
 */

import type { RouteRef } from '../types.js'

export type Phase = 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5'

export interface KnownMissing {
  /** The command id it will become. */
  capability: string
  phase: Phase
  /** Where the logic lives today. */
  source: 'slide-model' | 'web' | 'route' | 'new'
  /** Source file(s) holding the logic today; required for `slide-model` and `web`, absent for `route` / `new`. */
  where?: string
  /** API routes the capability wraps (method + path exactly as Fastify registers them); required for `route`. */
  routes?: readonly RouteRef[]
  writers?: readonly string[]
  note?: string
}

const POST = (path: string): RouteRef => ({ method: 'POST', path })
const PUT = (path: string): RouteRef => ({ method: 'PUT', path })

export const KNOWN_MISSING: readonly KnownMissing[] = [
  // --- A3: render worker ------------------------------------------------------
  { capability: 'deck.exportPdf', phase: 'A3', source: 'new' },
  { capability: 'deck.exportPng', phase: 'A3', source: 'new' },
  {
    capability: 'deck.refreshThumbnail',
    phase: 'A3',
    source: 'web',
    where: 'apps/web/src/ui/SlidesPanel.tsx',
    routes: [PUT('/decks/:id/thumbnail')],
    note: 'the browser renders the thumbnail and uploads it; the render worker takes over in A3',
  },
  {
    capability: 'component.refreshThumbnail',
    phase: 'A3',
    source: 'web',
    where: 'apps/web/src/pages/ComponentMasterEditor.tsx',
    routes: [PUT('/components/:id/thumbnail')],
    note: 'the master editor renders the thumbnail and uploads it; the render worker takes over in A3',
  },
  { capability: 'query.render', phase: 'A3', source: 'new' },

  // --- A4: style packs compiled into Narrative components (plan §7) ----------
  {
    capability: 'component.create',
    phase: 'A4',
    source: 'route',
    routes: [POST('/folders/:folderId/components')],
    note: 'create a master from a spec (component.promote makes one from objects); the route makes an empty master, which the tests and the eval seed with; the pack compiler uses it only for the few recurring blocks (pagination, headline, subline, copy, a repeated column/grid) — layouts stay pack data',
  },
  {
    capability: 'component.restamp',
    phase: 'A4',
    source: 'new',
    note: 'reapply a changed master to the stamps made from it, keeping their slot content (needs component provenance)',
  },
]

/** Phases already finished: their entries must be gone. Move the marker as phases close. */
export const FINISHED_PHASES: readonly Phase[] = ['A0', 'A1', 'A2']
