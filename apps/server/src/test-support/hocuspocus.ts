/**
 * test-support/hocuspocus.ts — tearing down a bare Hocuspocus document
 * engine in tests.
 *
 * Since Hocuspocus 3 the engine (`Hocuspocus`) and the WebSocket server
 * (`Server`, which has `listen` / `destroy`) are separate; a test that drives
 * documents through direct connections only builds the engine, which has no
 * `destroy`. This releases what it holds instead: connections closed,
 * debounced stores run, every document unloaded — no timer outlives the test.
 */

import type { Hocuspocus } from '@hocuspocus/server'

export async function releaseHocuspocus(hocuspocus: Hocuspocus): Promise<void> {
  hocuspocus.closeConnections()
  hocuspocus.flushPendingStores()
  await Promise.all([...hocuspocus.documents.values()].map((d) => hocuspocus.unloadDocument(d)))
}
