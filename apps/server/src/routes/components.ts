/**
 * routes/components.ts
 *
 * REST API for component master management (M16 P5).
 *
 * Endpoints:
 *   GET    /folders/:folderId/components   → list components in a folder (folder members)
 *   POST   /folders/:folderId/components   → create an empty component (row + empty master slide)
 *   POST   /decks/:id/promote-component    → component.promote: objects of a slide become a component
 *   POST   /decks/:id/stamp-component      → component.stamp: a master stamped onto a slide
 *   POST   /components/:id/insert-objects  → object.insertFromDeck into a master (paste)
 *   PATCH  /components/:id                 → rename (folder editors)
 *   DELETE /components/:id                 → delete (folder editors; cascades component_updates)
 *
 * Auth:
 *   All endpoints require authPreHandler (JWT Bearer or BYPASS_AUTH=true dev mode).
 *   The user's role in the component's folder (folder_permissions): viewers
 *   read, editors change (docs/plans/folder-sharing.md).
 *
 * Thumbnail:
 *   Mirrors the deck thumbnail pattern — NULL until the editor uploads a snapshot.
 *   Served via signImgproxyUrl exactly as deck thumbnails are.
 *
 * Shared implementation: the handlers call services/components.ts and services/componentStaging.ts — the
 * same code the `component.*` agent commands run (ADR 0010), so the two cannot drift apart.
 */

import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import type { Database } from '../db/client.js'
import { components } from '../db/schema.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { parseDataUrl } from '../media/dataUrl.js'
import { createComponentsService, MAX_COMPONENT_NAME } from '../services/components.js'
import { createEmptyComponent, stampComponentIntoDeck } from '../services/componentStaging.js'
import { sendInsertObjects } from './insertObjects.js'
import { isBypass, routeDeps } from '../services/http.js'
import { requireComponentRole } from '../services/shared.js'
import { sendCommandOrServiceError, sendServiceError } from '../services/errors.js'

/**
 * Hard cap on the data-URL payload — protects against giant uploads.
 * Mirrors `routes/decks.ts:MAX_THUMBNAIL_BYTES` (6 MB after base64
 * decode) so component master thumbnails don't get rejected on
 * image-heavy designs the way deck thumbnails were before this bump.
 */
const MAX_THUMBNAIL_BYTES = 6 * 1024 * 1024

const Id = z.string().min(1).max(64)

/** Body of POST /decks/:id/promote-component. */
const PromoteBody = z.strictObject({
  slideId: Id,
  objectIds: z.array(Id).min(1).max(500),
  name: z
    .string()
    .max(MAX_COMPONENT_NAME)
    .refine((t) => t.trim().length > 0, 'the name must not be blank'),
})

/** Body of POST /decks/:id/stamp-component. */
const StampBody = z.strictObject({
  componentId: Id,
  slideId: Id,
  at: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
})

function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComponentRow {
  id: string
  folderId: string
  name: string
  thumbnailKey: string | null
  createdAt: Date
  updatedAt: Date
}

function withThumbnailUrl(row: ComponentRow): ComponentRow & { thumbnailUrl: string | null } {
  let thumbnailUrl: string | null = null
  if (row.thumbnailKey !== null) {
    thumbnailUrl = signImgproxyUrl({
      storageKey: row.thumbnailKey,
      variant: 'thumb',
      extension: 'jpg',
    })
  }
  return { ...row, thumbnailUrl }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerComponentRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /folders/:folderId/components — list components in a folder
  // -------------------------------------------------------------------------
  app.get<{ Params: { folderId: string } }>(
    '/folders/:folderId/components',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await createComponentsService(routeDeps(app, db, request.log)).list({
            userId: request.user!.sub,
            folderId: request.params.folderId,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // POST /folders/:folderId/components — create an empty component
  //
  // Body: { name?: string }. The row and its empty master slide
  // (services/componentStaging.ts). A component made from objects comes from
  // POST /decks/:id/promote-component.
  // -------------------------------------------------------------------------
  app.post<{ Params: { folderId: string }; Body: { name?: unknown } }>(
    '/folders/:folderId/components',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const rawName = request.body?.name
      try {
        const created = await createEmptyComponent(routeDeps(app, db, request.log), {
          userId: request.user!.sub,
          folderId: request.params.folderId,
          name: typeof rawName === 'string' ? rawName : '',
        })
        return reply.status(201).send(created)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // POST /decks/:id/promote-component — `component.promote` for the editor:
  // the selected objects of slide `slideId` become a new component of the
  // deck's folder (its media copied into the component). Editor of the deck,
  // owner of its folder.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/decks/:id/promote-component',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      const parsed = PromoteBody.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: issuesText(parsed.error) })
      try {
        const promoted = await createComponentsService(routeDeps(app, db, request.log)).promote({
          userId: request.user!.sub,
          deckId: request.params.id,
          slide: parsed.data.slideId,
          objects: parsed.data.objectIds,
          name: parsed.data.name,
        })
        return reply.status(201).send(promoted)
      } catch (err) {
        return sendCommandOrServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // POST /decks/:id/stamp-component — `component.stamp` for the editor: the
  // master stamped onto slide `slideId` as one server write (its pictures
  // and videos linked, not copied: the deck may show its folder's component
  // media), reaching open editors as a remote change. Editor of the deck,
  // and a role in its folder.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/decks/:id/stamp-component',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      const parsed = StampBody.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: issuesText(parsed.error) })
      const deps = routeDeps(app, db, request.log)
      const deckId = request.params.id
      try {
        const stamped = await stampComponentIntoDeck(deps, {
          deckId,
          componentId: parsed.data.componentId,
          slideId: parsed.data.slideId,
          at: parsed.data.at,
          prepare: () =>
            createComponentsService(deps).prepareStamp({
              userId: request.user!.sub,
              componentId: parsed.data.componentId,
              deckId,
            }),
        })
        return reply.status(200).send(stamped)
      } catch (err) {
        return sendCommandOrServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // POST /components/:id/insert-objects — the master editor's cross-document
  // paste: objects read from a deck or another master onto the master's
  // slide, their pictures and videos copied into the component
  // (routes/insertObjects.ts). Editor in the component's folder (checked by
  // the service, as the master's document is), editor of a source deck.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/components/:id/insert-objects',
    { preHandler: authPreHandler },
    async (request, reply) =>
      sendInsertObjects(app, db, request, reply, { componentId: request.params.id }),
  )

  // -------------------------------------------------------------------------
  // PATCH /components/:id — rename (folder editors)
  //
  // Body: { name?: string }
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    '/components/:id',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        const updated = await createComponentsService(routeDeps(app, db, request.log)).rename({
          userId: request.user!.sub,
          componentId: request.params.id,
          name: request.body?.name as string,
        })
        return reply.send(updated)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // PUT /components/:id/thumbnail — upload component master snapshot (folder editors)
  //
  // Accepts a JSON body { dataUrl: "data:image/(jpeg|png);base64,..." }.
  // Mirrors the deck thumbnail pattern. The MinIO key is stable per
  // component (`components/<id>/thumb.<ext>`) so overwrites coalesce.
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string }; Body: { dataUrl?: unknown } }>(
    '/components/:id/thumbnail',
    {
      preHandler: authPreHandler,
      // Per-route bodyLimit override — same reasoning as the deck
      // thumbnail route in `routes/decks.ts`. Without this, Fastify's
      // 4 MB global limit rejects high-resolution component snapshots
      // before our per-payload check (which returns a structured error)
      // gets a chance to run.
      bodyLimit: Math.floor(MAX_THUMBNAIL_BYTES * 1.5) + 1024,
    },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user!.sub

      // Folder editors write the snapshot, as they write the master.
      try {
        await requireComponentRole(db, id, userId, 'editor', { bypass: isBypass(app) })
      } catch (err) {
        return sendServiceError(reply, err)
      }

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

      const ext = parsed.mime === 'image/png' ? 'png' : 'jpg'
      const storageKey = `components/${id}/thumb.${ext}`
      const s3 = buildS3Client()
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: MEDIA_BUCKET,
            Key: storageKey,
            Body: parsed.bytes,
            ContentType: parsed.mime,
            CacheControl: 'public, max-age=60',
          }),
        )
      } catch (err) {
        request.log.error({ err, componentId: id }, 'component thumbnail upload failed')
        return reply.status(502).send({ error: 'storage upload failed' })
      }

      const [updated] = await db
        .update(components)
        .set({ thumbnailKey: storageKey, updatedAt: new Date() })
        .where(eq(components.id, id))
        .returning()
      if (!updated) {
        return reply.status(404).send({ error: 'Component not found' })
      }
      return reply.send(withThumbnailUrl(updated))
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /components/:id — delete component + cascade component_updates
  //
  // The caller (UI) is responsible for replacing or removing instances on slides.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/components/:id',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        await createComponentsService(routeDeps(app, db, request.log)).delete({
          userId: request.user!.sub,
          componentId: request.params.id,
        })
        return reply.status(204).send()
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}
