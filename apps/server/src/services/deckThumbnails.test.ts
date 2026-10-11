/**
 * services/deckThumbnails.test.ts
 *
 * The card scheduler (services/deckThumbnails.ts) around a fake render
 * service: a deck is drawn once it has been quiet, never while a signed-in
 * editor has it open (also when one opens it during the drawing), as its
 * owner; at most once per minimum interval; one deck at a time, owners
 * taking turns, a bounded number waiting per owner; only a busy renderer is
 * tried again, a bounded number of times. (Whether the first slide changed
 * is the render service's: render.test.ts.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceDeps } from './deps.js'
import { failed } from './errors.js'
import {
  createDeckThumbnailScheduler,
  MAX_PENDING_PER_OWNER,
  MIN_INTERVAL_MS,
  THUMBNAIL_QUIET_MS,
  THUMBNAIL_RETRY_MS,
} from './deckThumbnails.js'
import { RendererBusyError, type BackgroundThumbnailOutcome } from './render.js'

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as ServiceDeps['log']

type DrawArgs = {
  userId: string
  card: { kind: 'deck' | 'component'; id: string }
  stillWanted?: () => boolean
}
type Draw = (args: DrawArgs) => Promise<BackgroundThumbnailOutcome>

function setup(opts: { draw?: Draw; editors?: Set<string>; owners?: Map<string, string> } = {}) {
  const editors = opts.editors ?? new Set<string>()
  const owners =
    opts.owners ??
    new Map([
      ['d1', 'owner-1'],
      ['d2', 'owner-2'],
    ])
  const draw = vi.fn<Draw>(opts.draw ?? (async () => ({ status: 'stored' })))
  const scheduler = createDeckThumbnailScheduler({
    db: {} as ServiceDeps['db'],
    log,
    now: () => Date.now(),
    render: { backgroundThumbnail: draw },
    hasSignedInEditor: (card) => editors.has(card.id),
    ownerOf: async (card) => owners.get(card.id) ?? null,
  })
  return { scheduler, draw, editors }
}

async function settle(scheduler: ReturnType<typeof setup>['scheduler'], ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await scheduler.idle()
}

const drawn = (draw: ReturnType<typeof setup>['draw']) =>
  draw.mock.calls.map(([args]) => `${args.userId}:${args.card.id}`)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('deck card scheduler', () => {
  it('draws a deck once it has been quiet, as its owner, however many stores came before', async () => {
    const { scheduler, draw } = setup()
    scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await settle(scheduler, THUMBNAIL_QUIET_MS - 1_000)
    scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await settle(scheduler, THUMBNAIL_QUIET_MS - 1_000)
    expect(draw).not.toHaveBeenCalled()
    await settle(scheduler, 1_000)
    expect(drawn(draw)).toEqual(['owner-1:d1'])
    scheduler.stop()
  })

  it('leaves the card to a signed-in editor who has the deck open, or opens it meanwhile', async () => {
    const { scheduler, draw, editors } = setup({ editors: new Set(['d1']) })
    scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await settle(scheduler, THUMBNAIL_QUIET_MS)
    expect(draw).not.toHaveBeenCalled()
    // They left; the next change is drawn — and the render service asks
    // again before storing, in case someone opened it while it drew.
    editors.delete('d1')
    scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await settle(scheduler, THUMBNAIL_QUIET_MS)
    const { stillWanted } = draw.mock.calls[0]![0]
    expect(stillWanted?.()).toBe(true)
    editors.add('d1')
    expect(stillWanted?.()).toBe(false)
    scheduler.stop()
  })

  it('draws a deck at most once per interval, however often it changes', async () => {
    const { scheduler, draw } = setup()
    scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await settle(scheduler, THUMBNAIL_QUIET_MS)
    expect(draw).toHaveBeenCalledTimes(1)
    scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await settle(scheduler, THUMBNAIL_QUIET_MS)
    expect(draw).toHaveBeenCalledTimes(1)
    // The first card was drawn at the first quiet; the next waits a full interval from it.
    await settle(scheduler, MIN_INTERVAL_MS - THUMBNAIL_QUIET_MS - 1)
    expect(draw).toHaveBeenCalledTimes(1)
    await settle(scheduler, 1)
    expect(draw).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('makes a deck changed during its own drawing wait its interval too', async () => {
    let release: () => void = () => {}
    const { scheduler, draw } = setup({
      draw: async () => {
        if (draw.mock.calls.length === 1) await new Promise<void>((r) => (release = r))
        return { status: 'stored' }
      },
    })
    scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_QUIET_MS)
    scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_QUIET_MS)
    release()
    await scheduler.idle()
    expect(draw).toHaveBeenCalledTimes(1)
    await settle(scheduler, MIN_INTERVAL_MS)
    expect(draw).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('draws one deck at a time, owners taking turns, and skips a deck that is gone', async () => {
    let release: () => void = () => {}
    const { scheduler, draw } = setup({
      owners: new Map([
        ['a1', 'alice'],
        ['a2', 'alice'],
        ['a3', 'alice'],
        ['b1', 'bob'],
      ]),
      draw: async (args) => {
        if (args.card.id === 'a1') await new Promise<void>((r) => (release = r))
        return { status: 'stored' }
      },
    })
    scheduler.cardChanged({ kind: 'deck', id: 'a1' })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_QUIET_MS)
    for (const deckId of ['a2', 'a3', 'gone', 'b1'])
      scheduler.cardChanged({ kind: 'deck', id: deckId })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_QUIET_MS)
    expect(drawn(draw)).toEqual(['alice:a1'])
    release()
    await scheduler.idle()
    expect(drawn(draw)).toEqual(['alice:a1', 'alice:a2', 'bob:b1', 'alice:a3'])
    scheduler.stop()
  })

  it('keeps a bounded number of decks waiting per owner', async () => {
    let release: () => void = () => {}
    const ids = Array.from({ length: MAX_PENDING_PER_OWNER + 3 }, (_, i) => `x${i}`)
    const { scheduler, draw } = setup({
      owners: new Map([['busy', 'mallory'], ...ids.map((id) => [id, 'mallory'] as const)]),
      draw: async (args) => {
        if (args.card.id === 'busy') await new Promise<void>((r) => (release = r))
        return { status: 'stored' }
      },
    })
    scheduler.cardChanged({ kind: 'deck', id: 'busy' })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_QUIET_MS)
    for (const id of ids) scheduler.cardChanged({ kind: 'deck', id })
    await vi.advanceTimersByTimeAsync(THUMBNAIL_QUIET_MS)
    release()
    await scheduler.idle()
    expect(draw).toHaveBeenCalledTimes(1 + MAX_PENDING_PER_OWNER)
    scheduler.stop()
  })

  it('tries a busy renderer again, a bounded number of times, and not a card that failed on its page', async () => {
    const busy = setup({
      draw: async () => {
        throw new RendererBusyError('failed', 503, 'The renderer is busy right now')
      },
    })
    busy.scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await settle(busy.scheduler, THUMBNAIL_QUIET_MS)
    await settle(busy.scheduler, THUMBNAIL_RETRY_MS)
    await settle(busy.scheduler, THUMBNAIL_RETRY_MS)
    await settle(busy.scheduler, THUMBNAIL_RETRY_MS * 3)
    expect(busy.draw).toHaveBeenCalledTimes(3)

    const broken = setup({
      draw: async () => {
        throw failed('The render failed', 503)
      },
    })
    broken.scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    await settle(broken.scheduler, THUMBNAIL_QUIET_MS)
    await settle(broken.scheduler, THUMBNAIL_RETRY_MS * 3)
    expect(broken.draw).toHaveBeenCalledTimes(1)
    busy.scheduler.stop()
    broken.scheduler.stop()
  })

  it('forgets every pending card when stopped', async () => {
    const { scheduler, draw } = setup()
    scheduler.cardChanged({ kind: 'deck', id: 'd1' })
    scheduler.stop()
    scheduler.cardChanged({ kind: 'deck', id: 'd2' })
    await settle(scheduler, THUMBNAIL_QUIET_MS * 2)
    expect(draw).not.toHaveBeenCalled()
  })
})
