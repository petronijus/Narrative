/**
 * observability/metricsDashboard.tsx
 *
 * Dev-only overlay pro zobrazení real-time metrik.
 * Zobrazí se při Ctrl+Shift+M a skryje při stejném zkratce.
 *
 * Obsah:
 *   - FPS + frame time p99
 *   - Yjs update rate per sec
 *   - WebSocket connection status
 *
 * NIKDY neshipovat do produkčního buildu — celý soubor je tree-shaken
 * pokud není importován, a import je vždy za `if (import.meta.env.DEV)`.
 *
 * Aktualizace každých 500ms.
 */

import { useEffect, useRef, useState } from 'react'
import type { FpsTracker } from './fpsTracker.js'
import type { YjsMetricsTracker } from './yjsMetrics.js'

// ---------------------------------------------------------------------------
// FpsOnlyDashboard — standalone verze bez Yjs tracker (pro M6 EditorLayout).
// Yjs metrics budou integrované v M8 když awareness context bude dostupný.
// ---------------------------------------------------------------------------

interface FpsOnlyDashboardProps {
  fpsTracker: FpsTracker
  wsStatus?: 'connected' | 'disconnected' | 'connecting'
}

interface FpsOnlySnapshot {
  fps: number
  frameTimeAvg: number
  frameTimeP99: number
  wsStatus: string
}

export function FpsOnlyDashboard({ fpsTracker, wsStatus = 'connecting' }: FpsOnlyDashboardProps) {
  const [snapshot, setSnapshot] = useState<FpsOnlySnapshot | null>(null)

  useEffect(() => {
    const interval = setInterval(() => {
      const s = fpsTracker.stats()
      setSnapshot({
        fps: s.fps,
        frameTimeAvg: s.frameTimeAvg,
        frameTimeP99: s.frameTimeP99,
        wsStatus,
      })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fpsTracker, wsStatus])

  if (snapshot === null) return null

  const fpsColor = snapshot.fps >= 55 ? '#4ade80' : snapshot.fps >= 30 ? '#facc15' : '#f87171'
  const wsColor =
    snapshot.wsStatus === 'connected'
      ? '#4ade80'
      : snapshot.wsStatus === 'connecting'
        ? '#facc15'
        : '#f87171'

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.85)',
        color: '#e5e7eb',
        fontFamily: 'monospace',
        fontSize: 11,
        padding: '8px 12px',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.15)',
        minWidth: 200,
        lineHeight: 1.6,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
      aria-label="Dev metrics overlay"
    >
      <div style={{ fontWeight: 700, marginBottom: 4, color: '#9ca3af', fontSize: 10 }}>
        NARRATIVE DEV METRICS
      </div>
      <Row label="FPS" value={`${snapshot.fps}`} valueColor={fpsColor} />
      <Row label="Frame avg" value={`${snapshot.frameTimeAvg} ms`} />
      <Row label="Frame p99" value={`${snapshot.frameTimeP99} ms`} />
      <Row label="WS" value={snapshot.wsStatus} valueColor={wsColor} />
      <div style={{ marginTop: 4, color: '#6b7280', fontSize: 10 }}>Ctrl+Shift+M to hide</div>
    </div>
  )
}

interface MetricsDashboardProps {
  fpsTracker: FpsTracker
  yjsTracker: YjsMetricsTracker
  wsStatus: 'connected' | 'disconnected' | 'connecting'
}

interface Snapshot {
  fps: number
  frameTimeP99: number
  updatesReceivedPerSec: number
  updatesSentPerSec: number
  awarenessChangesTotal: number
  wsStatus: string
}

const POLL_INTERVAL_MS = 500

export function MetricsDashboard({ fpsTracker, yjsTracker, wsStatus }: MetricsDashboardProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const prevYjsRef = useRef<{ received: number; sent: number; ts: number } | null>(null)

  useEffect(() => {
    const interval = setInterval(() => {
      const fps = fpsTracker.stats()
      const yjs = yjsTracker.stats()
      const now = Date.now()

      let receivedPerSec = 0
      let sentPerSec = 0

      if (prevYjsRef.current !== null) {
        const elapsed = (now - prevYjsRef.current.ts) / 1000
        if (elapsed > 0) {
          receivedPerSec =
            Math.round(((yjs.updatesReceived - prevYjsRef.current.received) / elapsed) * 10) / 10
          sentPerSec = Math.round(((yjs.updatesSent - prevYjsRef.current.sent) / elapsed) * 10) / 10
        }
      }

      prevYjsRef.current = { received: yjs.updatesReceived, sent: yjs.updatesSent, ts: now }

      setSnapshot({
        fps: fps.fps,
        frameTimeP99: fps.frameTimeP99,
        updatesReceivedPerSec: Math.max(0, receivedPerSec),
        updatesSentPerSec: Math.max(0, sentPerSec),
        awarenessChangesTotal: yjs.awarenessChanges,
        wsStatus,
      })
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [fpsTracker, yjsTracker, wsStatus])

  if (snapshot === null) return null

  const fpsColor = snapshot.fps >= 55 ? '#4ade80' : snapshot.fps >= 30 ? '#facc15' : '#f87171'
  const wsColor =
    snapshot.wsStatus === 'connected'
      ? '#4ade80'
      : snapshot.wsStatus === 'connecting'
        ? '#facc15'
        : '#f87171'

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.85)',
        color: '#e5e7eb',
        fontFamily: 'monospace',
        fontSize: 11,
        padding: '8px 12px',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.15)',
        minWidth: 200,
        lineHeight: 1.6,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
      aria-label="Dev metrics overlay"
    >
      <div style={{ fontWeight: 700, marginBottom: 4, color: '#9ca3af', fontSize: 10 }}>
        NARRATIVE DEV METRICS
      </div>
      <Row label="FPS" value={`${snapshot.fps}`} valueColor={fpsColor} />
      <Row label="Frame p99" value={`${snapshot.frameTimeP99} ms`} />
      <Row label="Yjs in/s" value={`${snapshot.updatesReceivedPerSec}`} />
      <Row label="Yjs out/s" value={`${snapshot.updatesSentPerSec}`} />
      <Row label="Awareness" value={`${snapshot.awarenessChangesTotal} total`} />
      <Row label="WS" value={snapshot.wsStatus} valueColor={wsColor} />
      <div style={{ marginTop: 4, color: '#6b7280', fontSize: 10 }}>Ctrl+Shift+M to hide</div>
    </div>
  )
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ color: '#9ca3af' }}>{label}</span>
      <span style={{ color: valueColor ?? '#e5e7eb' }}>{value}</span>
    </div>
  )
}
