/**
 * packages/animation/src/inputBridge.ts
 *
 * InputBridge implementace pro browser prostředí.
 *
 * createClickInputBridge — připojí click/tap listener na element.
 * PresentLayout (M6 fáze 2) zavolá:
 *   createClickInputBridge(document.body)
 * aby klik kdekoli v present modu advancoval onClick triggery.
 *
 * Multiple subscribers
 *   onAdvance() supports multiple concurrent listeners. The first
 *   implementation kept a single `currentListener` slot which silently
 *   dropped earlier subscriptions whenever a new one came in — so when a
 *   slide-transition timeline and a per-slide onClick timeline coexisted,
 *   only the most recent registration ever fired. The current Set-backed
 *   implementation broadcasts to every active subscriber.
 *
 * Cleanup
 *   `dispose()` removes the DOM listener and clears all subscribers. It is
 *   idempotent so callers can defensively dispose on every unmount.
 */

import type { InputBridge } from './types.js'

/**
 * Vytvoří InputBridge napojený na click eventy HTML elementu.
 *
 * POZOR: listener se přidá okamžitě — caller zodpovídá za lifecycle.
 * Zavolej bridge.dispose() při unmount (PresentLayout cleanup).
 */
export function createClickInputBridge(element: HTMLElement): InputBridge {
  const subscribers = new Set<() => void>()
  let disposed = false

  const handler = (): void => {
    // Snapshot before iteration — a subscriber may unsubscribe (or even
    // resubscribe) inside its own callback, mutating the Set mid-loop.
    for (const cb of [...subscribers]) {
      cb()
    }
  }

  element.addEventListener('click', handler)

  const bridge: InputBridge = {
    onAdvance(cb: () => void): () => void {
      if (disposed) {
        // Bridge already torn down — return a no-op unsub so callers don't
        // attach handlers to a dead bridge.
        return () => undefined
      }
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      element.removeEventListener('click', handler)
      subscribers.clear()
    },
  }

  return bridge
}

/**
 * Vytvoří InputBridge pro testovací prostředí nebo custom integrace.
 * Caller manuálně volá `trigger()` k simulaci user advance.
 */
export function createManualInputBridge(): InputBridge & { trigger(): void } {
  const subscribers = new Set<() => void>()

  return {
    onAdvance(cb: () => void): () => void {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
    trigger(): void {
      for (const cb of [...subscribers]) {
        cb()
      }
    },
    dispose(): void {
      subscribers.clear()
    },
  }
}
