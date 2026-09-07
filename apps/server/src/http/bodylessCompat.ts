/**
 * http/bodylessCompat.ts
 *
 * Fallback content-type parser that keeps *bodyless* POST/PUT/PATCH requests
 * working behind Cloudflare Tunnel.
 *
 * The problem it solves
 * --------------------
 * A browser sends a bodyless POST with `Content-Length: 0` and no
 * `Content-Type` (tus upload creation, `POST /auth/logout`, …). Fastify's
 * `handleRequest` treats that as "no body to parse" and dispatches straight to
 * the route:
 *
 *   const isEmptyBody = transferEncoding === undefined &&
 *     (contentLength === undefined || contentLength === '0')
 *
 * Cloudflare (Tunnel → cloudflared → Caddy → us) re-frames those requests:
 * `Content-Length: 0` is dropped and `Transfer-Encoding: chunked` is added,
 * even though zero bytes follow. `isEmptyBody` is then false, Fastify looks up
 * a parser for the *absent* Content-Type (`contentTypeParser.run('')`), finds
 * none and answers **415 FST_ERR_CTP_INVALID_MEDIA_TYPE before any route or
 * hook runs**. In prod that killed every tus upload (`POST /api/uploads`) and
 * `POST /auth/logout`; locally, with no Cloudflare in front, the same code
 * worked — which is why it survived to production.
 *
 * The fix
 * -------
 * Register the `'*'` fallback parser. Fastify stores it under the empty-string
 * key, which is exactly the lookup used both for a missing Content-Type and
 * for one nothing else matched. We accept the request only when the body is
 * genuinely empty (`body.length === 0` → `body: undefined`, same shape the
 * route would have seen without Cloudflare in the path). A non-empty payload
 * with an unknown/absent Content-Type still gets the original 415, so the API
 * contract for real unsupported media types is unchanged.
 *
 * Note the fallback is only consulted after every registered parser misses, so
 * JSON, the tus `application/offset+octet-stream` passthrough and the pptx
 * raw-buffer parser keep their own handling.
 */

import { errorCodes, type FastifyInstance } from 'fastify'

export function registerBodylessRequestCompat(app: FastifyInstance): void {
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    if (body.length === 0) {
      // Bodyless request that Cloudflare re-framed as chunked.
      done(null, undefined)
      return
    }
    done(new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE())
  })
}
