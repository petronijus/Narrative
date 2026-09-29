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
  // --- A2: web-only logic to extract ------------------------------------------
  {
    capability: 'text.style.createFromObject',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/state/FolderDocProvider.tsx',
  },
  {
    capability: 'token.textStyle.update',
    phase: 'A2',
    source: 'web',
    where:
      'apps/web/src/state/FolderDocProvider.tsx, apps/web/src/components/DeckShell.tsx (propagation)',
    note: 'propagation to linked text moves server-side',
  },
  {
    capability: 'token.textStyle.create',
    phase: 'A2',
    source: 'web',
    where:
      'apps/web/src/state/FolderDocProvider.tsx (addToken), apps/web/src/pages/FolderSettings.tsx',
  },
  {
    capability: 'token.textStyle.delete',
    phase: 'A2',
    source: 'web',
    where:
      'apps/web/src/state/FolderDocProvider.tsx (deleteToken), apps/web/src/pages/FolderSettings.tsx',
  },
  {
    capability: 'token.color.update',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/state/FolderDocProvider.tsx',
  },
  {
    capability: 'token.color.create',
    phase: 'A2',
    source: 'web',
    where:
      'apps/web/src/state/FolderDocProvider.tsx (addToken), apps/web/src/pages/FolderSettings.tsx',
    note: 'with the 24-colour cap',
  },
  {
    capability: 'token.color.delete',
    phase: 'A2',
    source: 'web',
    where:
      'apps/web/src/state/FolderDocProvider.tsx (deleteToken), apps/web/src/pages/FolderSettings.tsx',
  },
  {
    capability: 'token.effectStyle.create',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/state/FolderDocProvider.tsx (addToken)',
    note: 'the folder document and FolderDocProvider support effect styles; no editor UI creates them yet',
  },
  {
    capability: 'token.effectStyle.update',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/state/FolderDocProvider.tsx (updateToken)',
    note: 'the folder document and FolderDocProvider support effect styles; no editor UI edits them yet',
  },
  {
    capability: 'token.effectStyle.delete',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/state/FolderDocProvider.tsx (deleteToken)',
    note: 'the folder document and FolderDocProvider support effect styles; no editor UI deletes them yet',
  },
  {
    capability: 'token.seedDefaults',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/state/FolderDocProvider.tsx',
  },
  {
    capability: 'component.promote',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/state/writeComponentMasterTree.ts',
    routes: [POST('/folders/:folderId/components')],
    writers: ['insertObjectsWithRichText'],
    note: 'the master tree is written with insertObjectsWithRichText (keeps rich text and cell bodies)',
  },

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
    source: 'new',
    note: 'create a master from objects or a spec; the pack compiler uses it only for the few recurring blocks (pagination, headline, subline, copy, a repeated column/grid) — layouts stay pack data',
  },
  {
    capability: 'component.restamp',
    phase: 'A4',
    source: 'new',
    note: 'reapply a changed master to the stamps made from it, keeping their slot content (needs component provenance)',
  },
]

/** Phases already finished: their entries must be gone. Move the marker as phases close. */
export const FINISHED_PHASES: readonly Phase[] = ['A0', 'A1']
