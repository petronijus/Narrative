/**
 * observability/useDevMetrics.ts
 *
 * Hook pro řízení MetricsDashboard — vytváří FPS tracker, toggleuje overlay
 * při Ctrl+Shift+M.
 *
 * DEV-only. V produkčním buildu by neměl být importován (volající je zodpovědný
 * za import.meta.env.DEV guard před použitím).
 */

import { useEffect, useRef, useState } from 'react'
import { createFpsTracker } from './fpsTracker.js'
import type { FpsTracker } from './fpsTracker.js'

export interface DevMetricsState {
  visible: boolean
  fpsTracker: FpsTracker | null
}

export function useDevMetrics(): DevMetricsState {
  const [visible, setVisible] = useState(false)
  const trackerRef = useRef<FpsTracker | null>(null)

  // Vytvoř FPS tracker jednou při mountu
  useEffect(() => {
    const tracker = createFpsTracker()
    trackerRef.current = tracker
    return () => {
      tracker.destroy()
      trackerRef.current = null
    }
  }, [])

  // Ctrl+Shift+M toggle
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
        e.preventDefault()
        setVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return { visible, fpsTracker: trackerRef.current }
}
