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

export const KNOWN_MISSING: readonly KnownMissing[] = [
  // --- A5: deck builder (and what was moved out of A3) -----------------------
  {
    capability: 'deck.exportPdf',
    phase: 'A5',
    source: 'new',
    note: 'moved out of A3 by Petr (2026-10-10): not wanted yet; the render worker (A3) makes it a raster PDF of its PNGs when it is',
  },
]

/** Phases already finished: their entries must be gone. Move the marker as phases close. */
export const FINISHED_PHASES: readonly Phase[] = ['A0', 'A1', 'A2', 'A3']
