/**
 * routes/decks.ts
 *
 * REST API for presentation (deck) management.
 *
 * Endpoints:
 *   GET    /decks      → list all decks accessible to the authenticated user
 *   POST   /decks      → create a new deck; ownerUserId = JWT sub claim
 *   DELETE /decks/:id  → delete deck (owner only)
 *   GET    /decks/:id  → get single deck (supports ?share_token=... for unauthenticated access)
 *   POST   /decks/:id/insert-objects → objects read from another deck, onto a slide of
 *          this one (the editor's cross-deck paste; `object.insertFromDeck`)
 *
 * Auth:
 *   All endpoints require authPreHandler (JWT Bearer or BYPASS_AUTH=true dev mode).
 *   DELETE /decks/:id additionally requires requireDeckRole('owner').
 *   GET /decks/:id is the ONLY endpoint that accepts an unauthenticated share token.
 *     This is intentional: share links are read-only viewer access for specific decks.
 *
 * BYPASS_AUTH compatibility (dev mode):
 *   When BYPASS_AUTH=true, the synthesized user is 'dev-user'.
 *   Decks owned by legacy 'demo-user' (M4-era) would be invisible because they have
 *   no deck_permissions row for 'dev-user'.
 *   Workaround (Option A): GET /decks queries by BOTH ownerUserId IN ('demo-user', 'dev-user')
 *   when in bypass mode. Remove this when M10 ships to production and demo-user is migrated.
 *   TODO(post-M10): remove demo-user fallback once infra migration script runs in production.
 *
 * Shared implementation: the handlers call services/decks.ts — the same code the
 * `deck.*` agent commands run (ADR 0010), so the two cannot drift apart.
 */

import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { lookupSession, SESSION_COOKIE_NAME } from '../auth/session.js'
import { devSubFromCookieHeader } from '../auth/devIdentity.js'
import { parseDataUrl } from '../media/dataUrl.js'
import { createDecksService, deckRecord } from '../services/decks.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'
import { sendInsertObjects } from './insertObjects.js'
import { forgetCard } from '../render/cardState.js'
import {
  storeDeckThumbnail,
  ThumbnailFormatError,
  ThumbnailStorageError,
} from '../services/deckThumbnailStore.js'

interface CreateDeckBody {
  title?: string
  folderId?: string
}

/**
 * Hard cap on the data-URL payload — protects against giant uploads.
 *
 * Sized for high-resolution slides with embedded photos. Pixi extracts
 * the thumbnail as PNG (lossless) so a 1920×1080 slide with a single
 * full-bleed photo lands in the 2-4 MB range; collage / poster decks
 * occasionally cross 4 MB. We picked 6 MB as a generous ceiling that
 * covers every real deck we've seen without inviting abuse (a 6 MB
 * PNG thumbnail is still under the per-deck media budget by orders
 * of magnitude).
 */
const MAX_THUMBNAIL_BYTES = 6 * 1024 * 1024

export async function registerDeckRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // ---------------------------------------------------------------------------
  // GET /decks — list decks accessible to the authenticated user
  //
  // Optional query param: ?folderId=<id>
  //   When provided, returns only decks in that folder. The caller must be a
  //   member of the folder; filtering by a folder they are not in returns 403.
  // ---------------------------------------------------------------------------
  app.get('/decks', { preHandler: authPreHandler }, async (request, reply) => {
    const query = request.query as Record<string, string>
    try {
      const list = await createDecksService(routeDeps(app, db, request.log)).list({
        userId: request.user!.sub,
        folderId: query['folderId'],
      })
      return reply.send(list)
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  // ---------------------------------------------------------------------------
  // GET /decks/:id — get single deck (supports share_token)
  //
  // This is the ONE endpoint that supports unauthenticated access via share token.
  // authPreHandler is NOT listed here; we handle auth manually to allow share links.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/decks/:id', async (request, reply) => {
    const { id } = request.params
    const query = request.query as Record<string, string>
    const shareToken = query['share_token'] ?? null

    // Auth is optional on this route — falls through to the share-token
    // check below if no session cookie. authPreHandler isn't listed in
    // preHandler because we want the share-token path to work for
    // unauthenticated viewers.
    let userId: string | null = null
    const opts = (app as FastifyInstance & { _authOpts?: { bypass?: boolean } })._authOpts
    if (opts?.bypass) {
      // `dev-user`, or the synthetic identity `narrative_dev_as` names (dev only).
      userId = devSubFromCookieHeader(request.headers.cookie)
    } else {
      const rawSessionId = request.cookies?.[SESSION_COOKIE_NAME]
      if (rawSessionId) {
        const session = await lookupSession(db, rawSessionId)
        if (session) userId = session.userSub
      }
    }

    try {
      const deck = await createDecksService(routeDeps(app, db, request.log)).get({
        userId,
        deckId: id,
        shareToken,
      })
      return reply.send(deck)
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  // ---------------------------------------------------------------------------
  // POST /decks — create new deck
  //
  // Optional body fields:
  //   folderId — if provided, deck is created in that folder (must be owned by caller).
  //              If absent, defaults to the caller's "Drafts" folder (auto-provisioned if needed).
  // ---------------------------------------------------------------------------
  app.post<{ Body: CreateDeckBody }>(
    '/decks',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { title, folderId } = request.body ?? {}
      try {
        const deck = await createDecksService(routeDeps(app, db, request.log)).create({
          userId: request.user!.sub,
          title,
          folderId,
        })
        return reply.status(201).send(deck)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // ---------------------------------------------------------------------------
  // POST /decks/:id/duplicate — copy the deck whole into a new deck of the caller
  //
  // Optional body: { title?, folderId? }. Needs editor access to the source
  // (copying out of a deck is exporting it); the copy lands in folderId (editor
  // there), else the source's folder when the caller may edit it, else Drafts.
  // 201 with the new deck.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: { title?: unknown; folderId?: unknown } | undefined }>(
    '/decks/:id/duplicate',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      const { title, folderId } = request.body ?? {}
      if (title !== undefined && typeof title !== 'string') {
        return reply.status(400).send({ error: 'title must be a string' })
      }
      if (folderId !== undefined && (typeof folderId !== 'string' || folderId === '')) {
        return reply.status(400).send({ error: 'folderId must be a folder id' })
      }
      try {
        const copy = await createDecksService(routeDeps(app, db, request.log)).duplicate({
          userId: request.user!.sub,
          deckId: request.params.id,
          title,
          folderId,
        })
        return reply.status(201).send(copy)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // ---------------------------------------------------------------------------
  // POST /decks/:id/insert-objects — the editor's cross-document object
  // paste: objects read from another deck or a component master (the
  // clipboard holds them as query.slide JSON) onto slide `slideId`, their
  // media copied and tokens rebound (routes/insertObjects.ts). Editor of
  // this deck; editor of a source deck, owner of a source component.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/decks/:id/insert-objects',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      return sendInsertObjects(app, db, request, reply, { deckId: request.params.id })
    },
  )

  // ---------------------------------------------------------------------------
  // PATCH /decks/:id — rename deck (owner or editor)
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: { title?: string } }>(
    '/decks/:id',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      try {
        const updated = await createDecksService(routeDeps(app, db, request.log)).rename({
          deckId: request.params.id,
          title: request.body?.title ?? '',
        })
        return reply.send(updated)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // ---------------------------------------------------------------------------
  // PUT /decks/:id/thumbnail — upload deck preview snapshot (editor or owner)
  //
  // Accepts a JSON body { dataUrl: "data:image/(jpeg|png);base64,..." }.
  // The dataUrl format matches what the editor already keeps in the
  // localStorage cache (`narrative:deckThumbs`), so the client can pipe
  // the same blob to the server without re-rendering. Decoded bytes are
  // capped at MAX_THUMBNAIL_BYTES to bound storage + bandwidth.
  // ---------------------------------------------------------------------------
  app.put<{ Params: { id: string }; Body: { dataUrl?: unknown } }>(
    '/decks/:id/thumbnail',
    {
      preHandler: [authPreHandler, requireDeckRole('editor')],
      // Per-route override of Fastify's 4 MB global bodyLimit. The dataUrl
      // payload is base64-encoded (1.34× the decoded size) plus a thin
      // JSON wrapper, so the JSON body lands at ≈ MAX_THUMBNAIL_BYTES * 1.4
      // + a few bytes of overhead. Round up to MAX_THUMBNAIL_BYTES * 1.5
      // so Fastify lets the request through to our route's own decoded-
      // bytes check (which returns a structured `{error: "thumbnail too
      // large"}` rather than the bare `Content too large` Fastify writes
      // when its global limit hits first).
      bodyLimit: Math.floor(MAX_THUMBNAIL_BYTES * 1.5) + 1024,
    },
    async (request, reply) => {
      const { id } = request.params
      const dataUrlRaw = request.body?.dataUrl
      if (typeof dataUrlRaw !== 'string' || dataUrlRaw === '') {
        return reply.status(400).send({ error: 'dataUrl is required' })
      }
      const parsed = parseDataUrl(dataUrlRaw)
      if (parsed === null) {
        return reply
          .status(400)
          .send({ error: 'dataUrl must be a base64 data: URL of image/jpeg or image/png' })
      }
      if (parsed.bytes.byteLength > MAX_THUMBNAIL_BYTES) {
        return reply.status(413).send({ error: 'thumbnail too large' })
      }

      let updated
      try {
        updated = await storeDeckThumbnail(db, id, { bytes: parsed.bytes, mime: parsed.mime })
      } catch (err) {
        if (err instanceof ThumbnailFormatError) {
          return reply.status(400).send({ error: `dataUrl: ${err.message}` })
        }
        if (!(err instanceof ThumbnailStorageError)) throw err
        request.log.error({ err, deckId: id }, 'thumbnail upload failed')
        return reply.status(502).send({ error: 'storage upload failed' })
      }
      if (!updated) {
        return reply.status(404).send({ error: 'Deck not found' })
      }
      // The editor drew it from what it had; the server no longer knows what
      // the card shows, so the next background pass draws it again.
      forgetCard({ kind: 'deck', id })
      return reply.send(deckRecord(updated))
    },
  )

  // ---------------------------------------------------------------------------
  // DELETE /decks/:id — delete deck (owner only)
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/decks/:id',
    { preHandler: [authPreHandler, requireDeckRole('owner')] },
    async (request, reply) => {
      try {
        await createDecksService(routeDeps(app, db, request.log)).delete({
          deckId: request.params.id,
          userId: request.user!.sub,
        })
        return reply.status(204).send()
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}
