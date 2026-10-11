/**
 * render/queue.test.ts — the render queue with its media Redis unreachable
 * from the start: BullMQ waits for a connection that has never been ready
 * forever (whatever the offline queue says), so every call must give up on
 * its own and say "unavailable" — the caller gets a quick 503, not a hang
 * until Cloudflare's 524.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bullRenderQueue,
  closeRenderQueue,
  REDIS_CALL_TIMEOUT_MS,
  RenderUnavailableError,
} from './queue.js'

const saved = process.env['MEDIA_REDIS_URL']

beforeAll(() => {
  // Nothing listens on port 1.
  process.env['MEDIA_REDIS_URL'] = 'redis://127.0.0.1:1'
})

afterAll(async () => {
  await closeRenderQueue()
  if (saved === undefined) delete process.env['MEDIA_REDIS_URL']
  else process.env['MEDIA_REDIS_URL'] = saved
})

describe('bullRenderQueue with Redis down', () => {
  it('gives up counting and queueing within seconds', async () => {
    const started = Date.now()
    await expect(bullRenderQueue.waiting()).rejects.toBeInstanceOf(RenderUnavailableError)
    await expect(
      bullRenderQueue.run(
        {
          kind: 'export',
          deckId: 'd',
          uploads: [],
          token: 'nrr_x',
          stateVector: '',
          deadline: Date.now() + 90_000,
          workBudgetMs: 20_000,
        },
        { priority: 1 },
      ),
    ).rejects.toBeInstanceOf(RenderUnavailableError)
    expect(Date.now() - started).toBeLessThan(2 * REDIS_CALL_TIMEOUT_MS + 1_000)
  }, 15_000)
})
