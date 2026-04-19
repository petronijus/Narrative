/**
 * routes/decks.ts
 *
 * REST API pro správu prezentací (decks).
 *
 * Endpointy:
 *   GET    /decks      → list všech decků (hardcoded owner='demo-user')
 *   POST   /decks      → create nový deck, vrátí metadata
 *   DELETE /decks/:id  → smaž deck a jeho Yjs updates (cascade)
 *
 * Security (M4):
 *   Žádný auth — hardcoded ownerUserId='demo-user' pro všechny operace.
 *   TODO(M10): číst userId z JWT Bearer tokenu
 *
 * Seed slide:
 *   POST /decks vytvoří záznam v DB a zároveň seeduje Y.Doc přes Hocuspocus
 *   server-side klientem (jednoduché prázdné pole slides). Deck začíná s
 *   prázdným Y.Doc — client-side initializeDefaultSlide přidá první slide
 *   pokud ještě žádný neexistuje (idempotentní check).
 */

import type { FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { decks } from '../db/schema.js'

const DEMO_USER_ID = 'demo-user'

interface CreateDeckBody {
  title?: string
}

export async function registerDeckRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /decks — list all decks for demo-user
  app.get('/decks', async (_request, reply) => {
    const rows = await db
      .select()
      .from(decks)
      .where(eq(decks.ownerUserId, DEMO_USER_ID))
      .orderBy(decks.createdAt)

    return reply.send(rows)
  })

  // POST /decks — create new deck
  app.post<{ Body: CreateDeckBody }>('/decks', async (request, reply) => {
    const { title = 'Untitled Deck' } = request.body ?? {}

    const id = nanoid(12)
    const now = new Date()

    const [deck] = await db
      .insert(decks)
      .values({
        id,
        title,
        ownerUserId: DEMO_USER_ID,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    if (!deck) {
      return reply.status(500).send({ error: 'Failed to create deck' })
    }

    return reply.status(201).send(deck)
  })

  // DELETE /decks/:id — delete deck + cascade deck_updates
  app.delete<{ Params: { id: string } }>('/decks/:id', async (request, reply) => {
    const { id } = request.params

    const deleted = await db.delete(decks).where(eq(decks.id, id)).returning({ id: decks.id })

    if (deleted.length === 0) {
      return reply.status(404).send({ error: 'Deck not found' })
    }

    return reply.status(204).send()
  })
}
