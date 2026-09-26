/**
 * observability/yjsMetrics.ts
 *
 * Yjs update rate counter + awareness change counter.
 * Hookuje na Y.Doc events a HocuspocusProvider events.
 *
 * Počítá:
 *   - updatesReceived  — počet doc updates přijatých ze serveru
 *   - updatesSent      — počet doc updates odeslaných (lokální mutace)
 *   - bytesReceived    — celkové byty přijaté
 *   - bytesSent        — celkové byty odeslané
 *   - awarenessChanges — počet awareness state změn
 *
 * Spike B zjištění: origin=null jsou lokální updates, origin=non-null jsou remote.
 * HocuspocusProvider odesílá lokální updates se specifickým origin (provider instance).
 */

import type { Doc as YDoc } from 'yjs'
import { LOCAL_ORIGIN } from '@narrative/slide-model'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { TOKEN_PROPAGATION_ORIGIN } from '../state/origins.js'

export interface YjsMetrics {
  updatesReceived: number
  updatesSent: number
  bytesReceived: number
  bytesSent: number
  awarenessChanges: number
}

export interface YjsMetricsTracker {
  stats(): YjsMetrics
  destroy(): void
}

export function createYjsMetrics(doc: YDoc, provider: HocuspocusProvider): YjsMetricsTracker {
  let updatesReceived = 0
  let updatesSent = 0
  let bytesReceived = 0
  let bytesSent = 0
  let awarenessChanges = 0

  /**
   * doc.on('update', handler) — fires for every Yjs update.
   *
   * Local vs remote is decided by the transaction origin. HocuspocusProvider
   * stamps itself as the origin on updates it applies from the server, while
   * local mutations either carry `LOCAL_ORIGIN` (everything in
   * `slide-model/mutations.ts`, and the text-editing overlay since 2026-09-09)
   * or no origin at all (a plain `doc.transact(fn)` somewhere). Deliberately
   * untracked local writes carry a named origin (`state/origins.ts`, e.g.
   * the text-style token propagation) and count as sent too.
   *
   * Treating "has an origin" as "remote" — which this did until 2026-09-09 —
   * files every LOCAL_ORIGIN mutation under `updatesReceived`, i.e. most local
   * editing, so both counters were wrong in opposite directions.
   */
  function onUpdate(update: Uint8Array, origin: unknown): void {
    const byteLength = update.byteLength
    const isLocal =
      origin === null ||
      origin === undefined ||
      origin === LOCAL_ORIGIN ||
      origin === TOKEN_PROPAGATION_ORIGIN
    if (isLocal) {
      updatesSent++
      bytesSent += byteLength
    } else {
      updatesReceived++
      bytesReceived += byteLength
    }
  }

  /**
   * Awareness změna — provider.awareness je Y.Awareness instance.
   * Event 'change' se volá při každé změně stavu libovolného peera.
   */
  function onAwarenessChange(): void {
    awarenessChanges++
  }

  doc.on('update', onUpdate)

  // HocuspocusProvider exponuje awareness jako property
  const awareness = provider.awareness
  if (awareness !== null && awareness !== undefined) {
    awareness.on('change', onAwarenessChange)
  }

  return {
    stats(): YjsMetrics {
      return {
        updatesReceived,
        updatesSent,
        bytesReceived,
        bytesSent,
        awarenessChanges,
      }
    },

    destroy(): void {
      doc.off('update', onUpdate)
      if (awareness !== null && awareness !== undefined) {
        awareness.off('change', onAwarenessChange)
      }
    },
  }
}
