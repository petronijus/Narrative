/**
 * auth/index.ts
 *
 * Barrel export for server-side auth helpers.
 *
 * Consumers:
 *   - jwt.ts: JwtVerifier factory (createJwtVerifier)
 *   - fastifyAuth.ts: Fastify pre-handler hooks (authPreHandler, requireDeckRole, registerAuthPlugin)
 *   - permissions.ts: deck access resolution + role checks
 *   - shareLinks.ts: share-link CRUD
 */

export * from './permissions.js'
export * from './shareLinks.js'
export * from './jwt.js'
export * from './fastifyAuth.js'
