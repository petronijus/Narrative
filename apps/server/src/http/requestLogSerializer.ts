/**
 * http/requestLogSerializer.ts
 *
 * What Fastify logs about a request (`incoming request` / `request
 * completed`). Fastify's default puts the raw URL in the log, and a URL can
 * carry a credential: a share link's token in `?share_token=` — a viewer's or
 * an editor's, valid until revoked — and the render worker's short-lived
 * `nrr_` tokens, which travel the same way (auth/renderTokens.ts). Both are
 * masked here, as is any other Narrative credential that ends up in a path or
 * query (auth/credentialPatterns.ts).
 */

import type { FastifyReply, FastifyRequest } from 'fastify'
import { maskCredentials, maskShareTokens } from '../auth/credentialPatterns.js'

const MASK = '***'

/** `url` with share-token values and Narrative credentials masked. */
export function redactUrl(url: string): string {
  return maskShareTokens(maskCredentials(url, MASK), MASK)
}

/** The fields of Fastify's default `req` serializer, with the URL redacted. */
export function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  }
}

/**
 * The 404 handler: Fastify's default logs `Route GET:<raw url> not found`
 * and echoes it in the reply. Same message and status, URL redacted.
 */
export async function notFoundWithRedactedUrl(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const message = `Route ${request.method}:${redactUrl(request.url)} not found`
  request.log.info(message)
  await reply.status(404).send({ message, error: 'Not Found', statusCode: 404 })
}
