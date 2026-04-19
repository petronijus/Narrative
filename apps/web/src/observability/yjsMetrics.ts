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
import type { HocuspocusProvider } from '@hocuspocus/provider'

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
   * doc.on('update', handler) — volá se pro každý Yjs update.
   * origin: null/undefined = lokální, non-null = remote (z provideru).
   *
   * HocuspocusProvider nastavuje origin na sebe samotného pro remote updates.
   */
  function onUpdate(update: Uint8Array, origin: unknown): void {
    const byteLength = update.byteLength
    if (origin === null || origin === undefined) {
      // Lokální update odeslán
      updatesSent++
      bytesSent += byteLength
    } else {
      // Remote update přijat
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
