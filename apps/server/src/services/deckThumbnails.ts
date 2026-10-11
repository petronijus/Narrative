/**
 * services/deckThumbnails.ts — the card picture of a deck nobody has open
 * follows its changes (agentic A3.5, docs/plans/a3-render-worker.md).
 *
 * The editor keeps the card current while someone edits (SlidesPanel uploads
 * the first slide it rendered). A deck changed by an agent, an import or a
 * server-side write while no editor has it open kept a stale card, or none.
 * So after every stored snapshot of a deck (PostgresPersistence
 * `onDeckStored`), once the deck has been quiet for `THUMBNAIL_QUIET_MS`:
 *
 *   - a signed-in editor has it open → nothing (their browser uploads it);
 *   - otherwise the render worker draws the first slide as the card
 *     (services/render.ts `backgroundThumbnail`): as the deck's owner (a
 *     master: an owner of its folder), in a
 *     render lane of its own (its own render session and request budget,
 *     and a page it does not keep warm), behind every person's job and
 *     outside anyone's in-flight share — unless the first slide is as it was
 *     when the card was last drawn (render/cardState.ts), and not stored if
 *     an editor opened the deck while it was being drawn.
 *
 * Kept from crowding the renderer: one card at a time; a deck is drawn at
 * most once per `MIN_INTERVAL_MS` (a deck edited every few seconds waits);
 * the decks waiting take turns by owner, so one account's flood of decks
 * cannot hold everyone else's cards back (`MAX_PENDING_PER_OWNER` bounds
 * only the memory a flood takes). A busy or unavailable renderer (RendererBusyError) is tried again
 * after `THUMBNAIL_RETRY_MS`, up to `MAX_ATTEMPTS`; a card that failed on its
 * page is logged and waits for the deck's next change.
 */

import { and, asc, eq } from 'drizzle-orm'
import { components, decks, folderPermissions } from '../db/schema.js'
import { hasSignedInEditor as liveEditorOn } from '../hocuspocus/connections.js'
import type { CardRef } from './deckThumbnailStore.js'
import { createRenderService, RendererBusyError, type RenderServiceDeps } from './render.js'

export const THUMBNAIL_QUIET_MS = 10_000
export const THUMBNAIL_RETRY_MS = 60_000
export const MIN_INTERVAL_MS = 60_000
/** Only a memory bound: owners take turns, so a long line holds back no one else. */
export const MAX_PENDING_PER_OWNER = 500
const MAX_ATTEMPTS = 3
/** Decks whose last drawing time is remembered (oldest forgotten first). */
const MAX_REMEMBERED = 2_000

export interface DeckThumbnailScheduler {
  /** A snapshot of the deck's or the master's document was stored. */
  cardChanged(card: CardRef): void
  /** Forget every pending card (shutdown, tests). */
  stop(): void
  /** Test helper: until nothing is pending or drawing. */
  idle(): Promise<void>
}

export interface DeckThumbnailSchedulerDeps extends RenderServiceDeps {
  quietMs?: number
  retryMs?: number
  minIntervalMs?: number
  /** Defaults to the live sync server's connections. */
  hasSignedInEditor?: (card: CardRef) => boolean
  /** Defaults to the render service built from these deps. */
  render?: Pick<ReturnType<typeof createRenderService>, 'backgroundThumbnail'>
  /**
   * Whom the card is drawn as: the deck's owner, the master's folder's owner;
   * null for one that is gone (defaults to the rows).
   */
  ownerOf?: (card: CardRef) => Promise<string | null>
}

export function createDeckThumbnailScheduler(
  deps: DeckThumbnailSchedulerDeps,
): DeckThumbnailScheduler {
  const quietMs = deps.quietMs ?? THUMBNAIL_QUIET_MS
  const retryMs = deps.retryMs ?? THUMBNAIL_RETRY_MS
  const minIntervalMs = deps.minIntervalMs ?? MIN_INTERVAL_MS
  const now = deps.now ?? Date.now
  const hasSignedInEditor = deps.hasSignedInEditor ?? liveEditorOn
  const render = deps.render ?? createRenderService(deps)
  const ownerOf =
    deps.ownerOf ??
    (async (card: CardRef) => {
      if (card.kind === 'deck') {
        const [deck] = await deps.db
          .select({ ownerUserId: decks.ownerUserId })
          .from(decks)
          .where(eq(decks.id, card.id))
        return deck?.ownerUserId ?? null
      }
      // An owner of the folder now (its creator may have been removed).
      const [row] = await deps.db
        .select({ userId: folderPermissions.userId })
        .from(components)
        .innerJoin(
          folderPermissions,
          and(
            eq(folderPermissions.folderId, components.folderId),
            eq(folderPermissions.role, 'owner'),
          ),
        )
        .where(eq(components.id, card.id))
        .orderBy(asc(folderPermissions.userId))
        .limit(1)
      return row?.userId ?? null
    })
  /** The maps below are keyed `deck:<id>` / `component:<id>`. */
  const keyOf = (card: CardRef): string => `${card.kind}:${card.id}`
  const cardOf = (key: string): CardRef =>
    key.startsWith('deck:')
      ? { kind: 'deck', id: key.slice('deck:'.length) }
      : { kind: 'component', id: key.slice('component:'.length) }

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Decks waiting for their turn, by owner (owners in turn order), with their attempt. */
  const pending = new Map<string, Map<string, number>>()
  /** When each deck's card was last drawn. */
  const drawnAt = new Map<string, number>()
  let drawing: Promise<void> | null = null
  /** The card being drawn now. */
  let drawingKey: string | null = null
  /** Decks gone quiet whose owner is being looked up (queued once it is known). */
  const enqueuing = new Set<Promise<void>>()
  let stopped = false

  function arm(key: string, delayMs: number, attempt: number): void {
    const previous = timers.get(key)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      timers.delete(key)
      const queued = enqueue(key, attempt).finally(() => enqueuing.delete(queued))
      enqueuing.add(queued)
    }, delayMs)
    timer.unref?.()
    timers.set(key, timer)
  }

  async function enqueue(key: string, attempt: number): Promise<void> {
    // Changed again while its card is being drawn: it waits its interval too.
    if (key === drawingKey) {
      arm(key, minIntervalMs, attempt)
      return
    }
    const last = drawnAt.get(key)
    if (last !== undefined && now() - last < minIntervalMs) {
      arm(key, last + minIntervalMs - now(), attempt)
      return
    }
    let owner: string | null
    try {
      owner = await ownerOf(cardOf(key))
    } catch (err) {
      deps.log.warn(
        { card: key, err: err instanceof Error ? err.message : String(err) },
        'card: owner lookup failed',
      )
      owner = null
    }
    if (owner === null || stopped) return
    const queue = pending.get(owner) ?? new Map<string, number>()
    if (!queue.has(key) && queue.size >= MAX_PENDING_PER_OWNER) {
      deps.log.warn({ card: key, owner }, 'card: too many waiting for this owner; skipped')
      return
    }
    queue.set(key, attempt)
    pending.set(owner, queue)
    pump()
  }

  /** The next deck: the first waiting of the owner whose turn it is (who then goes last). */
  function takeNext(): { owner: string; key: string; attempt: number } | null {
    const first = pending.entries().next()
    if (first.done === true) return null
    const [owner, queue] = first.value
    const [key, attempt] = queue.entries().next().value!
    queue.delete(key)
    pending.delete(owner)
    if (queue.size > 0) pending.set(owner, queue)
    return { owner, key, attempt }
  }

  async function draw(owner: string, key: string, attempt: number): Promise<void> {
    const card = cardOf(key)
    if (hasSignedInEditor(card)) return
    try {
      const outcome = await render.backgroundThumbnail({
        userId: owner,
        card,
        stillWanted: () => !hasSignedInEditor(card),
      })
      if (outcome.status === 'stored') {
        drawnAt.delete(key)
        drawnAt.set(key, now())
        if (drawnAt.size > MAX_REMEMBERED) drawnAt.delete(drawnAt.keys().next().value!)
      }
    } catch (err) {
      const retry = err instanceof RendererBusyError && attempt < MAX_ATTEMPTS
      deps.log.warn(
        { card: key, attempt, err: err instanceof Error ? err.message : String(err), retry },
        'card: drawing failed',
      )
      // A change meanwhile has armed its own timer; that one wins.
      if (retry && !stopped && !timers.has(key)) arm(key, retryMs, attempt + 1)
    }
  }

  function pump(): void {
    if (drawing !== null || stopped) return
    const next = takeNext()
    if (next === null) return
    drawingKey = next.key
    drawing = draw(next.owner, next.key, next.attempt)
      .catch((err: unknown) => {
        deps.log.error(
          { card: next.key, err: err instanceof Error ? err.message : String(err) },
          'card: unexpected failure',
        )
      })
      .finally(() => {
        drawing = null
        drawingKey = null
        pump()
      })
  }

  return {
    cardChanged(card) {
      if (stopped) return
      arm(keyOf(card), quietMs, 1)
    },
    stop() {
      stopped = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
    },
    async idle() {
      // A queued deck starts drawing at once (pump), so nothing waits but these.
      while (drawing !== null || enqueuing.size > 0) {
        await Promise.all([drawing, ...enqueuing])
      }
    },
  }
}
