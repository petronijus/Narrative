/**
 * media/routes.ts
 *
 * REST routes for the media subsystem:
 *
 *   GET  /api/media/:assetId/url?variant=<thumb|display|original>
 *     Returns a signed imgproxy URL for the given asset + variant.
 *     Auth: JWT required (authPreHandler). Deck access: viewer or above.
 *     Cache-Control: max-age=600 (10 min). Signed URLs are stable so caching is safe.
 *
 *   DELETE /api/media/:assetId
 *     Removes the media_assets row (owner only).
 *     The MinIO object is NOT deleted — documented M29 GC TODO.
 *
 * Consumer expectations for phase 3 (editor-ui + renderer):
 *   - Editor-ui fetches GET /api/media/:assetId/url?variant=display for <img src>.
 *   - Renderer calls same endpoint, caches result in ResourceManager.
 *
 * Security notes:
 *   - Share token (viewer via share link) does NOT permit uploads — only reads.
 *   - Deck ownership verified via getMediaAsset → deckId → resolveDeckAccess chain.
 */

import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { getMediaAsset, deleteMediaAsset } from './assets.js'
import { signImgproxyUrl, type ImgproxyVariant } from './imgproxyUrl.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'

export interface MediaRoutesOpts {
  db: Database
}

const ALLOWED_VARIANTS: ImgproxyVariant[] = ['thumb', 'display', 'original']

function isImgproxyVariant(v: string): v is ImgproxyVariant {
  return (ALLOWED_VARIANTS as string[]).includes(v)
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  opts: MediaRoutesOpts,
): Promise<void> {
  const { db } = opts

  // -------------------------------------------------------------------------
  // GET /api/media/:assetId/url?variant=<variant>
  // -------------------------------------------------------------------------
  app.get<{
    Params: { assetId: string }
    Querystring: { variant?: string }
  }>('/api/media/:assetId/url', { preHandler: authPreHandler }, async (request, reply) => {
    const { assetId } = request.params
    const variantParam = request.query.variant ?? 'display'

    if (!isImgproxyVariant(variantParam)) {
      return reply.status(400).send({
        error: `Invalid variant. Allowed: ${ALLOWED_VARIANTS.join(', ')}`,
      })
    }

    // 1. Look up the asset
    const asset = await getMediaAsset(db, assetId)
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' })
    }

    // 2. Resolve deck access — viewer is sufficient for reads
    const userId = request.user?.sub ?? null
    const shareToken = (request.query as Record<string, string>)['share_token'] ?? null
    const access = await resolveDeckAccess(db, {
      deckId: asset.deckId,
      userId,
      shareToken,
    })

    if (!access || !roleAtLeast(access.role, 'viewer')) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    // 3. Sign the imgproxy URL
    const url = signImgproxyUrl({
      storageKey: asset.storageKey,
      variant: variantParam,
    })

    return reply.header('Cache-Control', 'public, max-age=600').send({ url })
  })

  // -------------------------------------------------------------------------
  // DELETE /api/media/:assetId  (owner only)
  // -------------------------------------------------------------------------
  app.delete<{
    Params: { assetId: string }
  }>('/api/media/:assetId', { preHandler: authPreHandler }, async (request, reply) => {
    const { assetId } = request.params

    // 1. Look up the asset
    const asset = await getMediaAsset(db, assetId)
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' })
    }

    // 2. Only owner may delete
    const userId = request.user?.sub ?? null
    const access = await resolveDeckAccess(db, {
      deckId: asset.deckId,
      userId,
      shareToken: null,
    })

    if (!access || !roleAtLeast(access.role, 'owner')) {
      return reply.status(403).send({ error: 'Forbidden: owner role required' })
    }

    // 3. Delete DB row
    // NOTE: MinIO object remains — see TODO(M29) for GC job.
    await deleteMediaAsset(db, assetId)

    return reply.status(204).send()
  })
}
