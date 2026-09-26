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

const GET = (path: string): RouteRef => ({ method: 'GET', path })
const POST = (path: string): RouteRef => ({ method: 'POST', path })
const PUT = (path: string): RouteRef => ({ method: 'PUT', path })
const PATCH = (path: string): RouteRef => ({ method: 'PATCH', path })
const DELETE = (path: string): RouteRef => ({ method: 'DELETE', path })

export const KNOWN_MISSING: readonly KnownMissing[] = [
  // --- A1: server host, identity, MCP ----------------------------------------
  {
    capability: 'component.stamp',
    phase: 'A1',
    source: 'slide-model',
    where: 'packages/slide-model/src/stampComponent.ts',
    writers: ['stampComponent'],
    note: 'needs the component document loaded by a host; the server host provides it in A1',
  },
  {
    capability: 'component.master.edit',
    phase: 'A1',
    source: 'web',
    where: 'apps/web/src/pages/ComponentMasterEditor.tsx',
    note:
      'editing a component master = the object/text/table commands run against a component document instead of a ' +
      'deck; needs the server host to open `component:<id>`',
  },
  {
    capability: 'component.get',
    phase: 'A1',
    source: 'new',
    note: "a master's objects with their slot map, so the agent can pick a component and fill it (plan §7.2 item 8)",
  },
  { capability: 'deck.list', phase: 'A1', source: 'route', routes: [GET('/decks')] },
  { capability: 'deck.get', phase: 'A1', source: 'route', routes: [GET('/decks/:id')] },
  { capability: 'deck.create', phase: 'A1', source: 'route', routes: [POST('/decks')] },
  { capability: 'deck.rename', phase: 'A1', source: 'route', routes: [PATCH('/decks/:id')] },
  { capability: 'deck.delete', phase: 'A1', source: 'route', routes: [DELETE('/decks/:id')] },
  {
    capability: 'deck.moveToFolder',
    phase: 'A1',
    source: 'route',
    routes: [POST('/folders/:id/move-decks')],
  },
  {
    capability: 'deck.importPptx',
    phase: 'A1',
    source: 'route',
    routes: [POST('/folders/:folderId/import-pptx')],
  },
  {
    capability: 'deck.insertFrom',
    phase: 'A1',
    source: 'route',
    routes: [POST('/decks/:id/append-pptx')],
  },
  {
    capability: 'deck.exportPptx',
    phase: 'A1',
    source: 'route',
    routes: [GET('/decks/:id/export.pptx')],
  },
  {
    capability: 'deck.activeEditors',
    phase: 'A1',
    source: 'route',
    routes: [GET('/folders/:id/active-editors')],
  },
  {
    capability: 'deck.fonts.list',
    phase: 'A1',
    source: 'route',
    routes: [GET('/api/decks/:deckId/fonts')],
    note: "the fonts a deck's editors may load (its folder's fonts), for any role on the deck",
  },
  { capability: 'folder.list', phase: 'A1', source: 'route', routes: [GET('/folders')] },
  { capability: 'folder.create', phase: 'A1', source: 'route', routes: [POST('/folders')] },
  { capability: 'folder.rename', phase: 'A1', source: 'route', routes: [PATCH('/folders/:id')] },
  { capability: 'folder.delete', phase: 'A1', source: 'route', routes: [DELETE('/folders/:id')] },
  {
    capability: 'folder.fonts.list',
    phase: 'A1',
    source: 'route',
    routes: [GET('/api/folders/:folderId/fonts')],
  },
  {
    capability: 'folder.fonts.upload',
    phase: 'A1',
    source: 'route',
    routes: [POST('/api/folders/:folderId/fonts')],
  },
  {
    capability: 'folder.fonts.delete',
    phase: 'A1',
    source: 'route',
    routes: [DELETE('/api/folders/:folderId/fonts/:assetId')],
  },
  {
    capability: 'component.list',
    phase: 'A1',
    source: 'route',
    routes: [GET('/folders/:folderId/components')],
  },
  {
    capability: 'component.rename',
    phase: 'A1',
    source: 'route',
    routes: [PATCH('/components/:id')],
  },
  {
    capability: 'component.delete',
    phase: 'A1',
    source: 'route',
    routes: [DELETE('/components/:id')],
  },
  {
    capability: 'token.usages',
    phase: 'A1',
    source: 'route',
    routes: [GET('/folders/:folderId/tokens/:category/:tokenId/usages')],
  },
  {
    capability: 'share.permissions.list',
    phase: 'A1',
    source: 'route',
    routes: [GET('/decks/:id/permissions')],
  },
  {
    capability: 'share.permissions.invite',
    phase: 'A1',
    source: 'route',
    routes: [POST('/decks/:id/permissions')],
  },
  {
    capability: 'share.permissions.revoke',
    phase: 'A1',
    source: 'route',
    routes: [DELETE('/decks/:id/permissions/:userId')],
  },
  {
    capability: 'share.invites.list',
    phase: 'A1',
    source: 'route',
    routes: [GET('/decks/:id/invites')],
  },
  {
    capability: 'share.invites.cancel',
    phase: 'A1',
    source: 'route',
    routes: [DELETE('/decks/:id/invites/:inviteId')],
  },
  {
    capability: 'share.links.list',
    phase: 'A1',
    source: 'route',
    routes: [GET('/decks/:id/share-links')],
  },
  {
    capability: 'share.links.create',
    phase: 'A1',
    source: 'route',
    routes: [POST('/decks/:id/share-links')],
  },
  {
    capability: 'share.links.revoke',
    phase: 'A1',
    source: 'route',
    routes: [DELETE('/decks/:id/share-links/:linkId')],
  },
  {
    capability: 'media.upload',
    phase: 'A1',
    source: 'route',
    routes: [
      { method: 'ALL', path: '/api/uploads' },
      { method: 'ALL', path: '/api/uploads/*' },
    ],
    note: 'the tus endpoint; the command takes bytes or a URL (with an SSRF guard) instead of speaking tus',
  },
  {
    capability: 'media.status',
    phase: 'A1',
    source: 'route',
    routes: [GET('/api/media/:assetId/video-info')],
  },
  {
    capability: 'media.url',
    phase: 'A1',
    source: 'route',
    routes: [GET('/api/media/:assetId/url')],
  },
  {
    capability: 'media.fontUrl',
    phase: 'A1',
    source: 'route',
    routes: [GET('/api/media/:assetId/font-url')],
    note: 'signed URL of an uploaded font file',
  },
  {
    capability: 'media.delete',
    phase: 'A1',
    source: 'route',
    routes: [DELETE('/api/media/:assetId')],
  },
  { capability: 'editor.context', phase: 'A1', source: 'new' },
  { capability: 'editor.show', phase: 'A1', source: 'new' },
  { capability: 'editor.present.link', phase: 'A1', source: 'new' },
  { capability: 'agent.revert', phase: 'A1', source: 'new' },

  // --- A2: web-only logic to extract ------------------------------------------
  {
    capability: 'object.path.create',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/components/EditorLayout.tsx (PenSession)',
  },
  {
    capability: 'object.path.fromShape',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/components/EditorLayout.tsx (convertToPathAndPlace)',
  },
  {
    capability: 'object.path.setAnchors',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/PathPointsOverlay.tsx',
    note:
      "the raw path fields are settable with object.update today; the command adds the point editor's rule of " +
      're-fitting x/y/width/height to the edited anchors while keeping the rotation pivot in place',
  },
  {
    capability: 'object.line.setEndpoints',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/LineEndpointHandles.tsx',
  },
  {
    capability: 'object.resize',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/TransformHandles.tsx (computeResize)',
  },
  {
    capability: 'object.rotate',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/TransformHandles.tsx, Inspector.tsx',
    note: "raw `rotation` (radians) is settable with object.update today; the command adds degrees in and the editor's snapping",
  },
  {
    capability: 'object.flip',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/Inspector.tsx',
    note:
      "raw `flipH` / `flipV` are settable with object.update today; the command adds the editor's rule of negating " +
      '`rotation` so a rotated object mirrors in place',
  },
  {
    capability: 'object.alignToSlide',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/Inspector.tsx',
  },
  {
    capability: 'object.crop.set',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/CropOverlay.tsx',
    note:
      'raw `imageRect` (absolute slide px) is settable with object.update today; the command adds crop in ' +
      'frame-relative terms (pan, zoom around a point, reset to fit) as the crop overlay does',
  },
  {
    capability: 'object.copyTo',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/state/clipboard.ts',
    writers: ['addObjects'],
    note: 'paste inserts the copied objects in one step with addObjects',
  },
  {
    capability: 'slide.copyTo',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/state/slideClipboard.ts, apps/web/src/ui/slideHelpers.ts',
  },
  {
    capability: 'slide.notes.set',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/SlideNotesPanel.tsx',
  },
  {
    capability: 'object.slideNumber.set',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/SlideNumberPromptDialog.tsx',
    note:
      "raw `isSlideNumber` is settable with object.update today; the command adds the editor's follow-up choice " +
      '(apply the page-number text style or promote the box to a component)',
  },
  {
    capability: 'object.fill.gradient',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/Inspector.tsx (starting stops)',
    note:
      "a gradient `fillStyle` is settable raw with object.update today; the command adds the Inspector's starting " +
      'stops seeded from the current fill colour',
  },
  {
    capability: 'object.effects.shadow',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/Inspector.tsx (defaults)',
    note: "`shadow` is settable raw with object.update today; the command adds the Inspector's default shadow when switched on",
  },
  {
    capability: 'text.setBoxTypography',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/FontFamilySelect.tsx, apps/web/src/ui/fontWeights.ts',
    note:
      "box font changes with the editor's rules: switching fontFamily snaps fontWeight to a cut the family has " +
      '(object.update writes fontFamily raw and keeps the weight)',
  },
  {
    capability: 'text.style.apply',
    phase: 'A2',
    source: 'web',
    where: 'apps/web/src/ui/Inspector.tsx (applyTextStyle)',
  },
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
  { capability: 'deck.duplicate', phase: 'A2', source: 'new' },
  { capability: 'text.replace', phase: 'A2', source: 'new' },
  { capability: 'animation.retarget', phase: 'A2', source: 'new' },

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
export const FINISHED_PHASES: readonly Phase[] = ['A0']
