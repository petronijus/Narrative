/**
 * state/useZoomLevel.ts
 *
 * P4: editor zoom factor for the artboard (1 = 100 %). Per-tab via
 * sessionStorage — not synced via Y.Doc (each viewer can zoom
 * independently) and not shared across tabs (multi-user test flow).
 */

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'narrative:zoom-level'
const DEFAULT_ZOOM = 1
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4

type Listener = (next: number) => void
const listeners = new Set<Listener>()

function readStored(): number {
  if (typeof window === 'undefined') return DEFAULT_ZOOM
  try {
    const v = window.sessionStorage.getItem(STORAGE_KEY)
    if (v === null || v === '') return DEFAULT_ZOOM
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_ZOOM
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, n))
  } catch {
    return DEFAULT_ZOOM
  }
}

function writeStored(next: number): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    // Storage disabled — in-memory state still holds.
  }
}

export function useZoomLevel(): {
  zoom: number
  setZoom: (next: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
} {
  const [zoom, setZoomState] = useState<number>(() => readStored())

  useEffect(() => {
    const listener: Listener = (next) => setZoomState(next)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const setZoom = useCallback((next: number) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next))
    writeStored(clamped)
    for (const l of listeners) l(clamped)
  }, [])

  const zoomIn = useCallback(() => setZoom(zoom * 1.25), [zoom, setZoom])
  const zoomOut = useCallback(() => setZoom(zoom / 1.25), [zoom, setZoom])
  const resetZoom = useCallback(() => setZoom(1), [setZoom])

  return { zoom, setZoom, zoomIn, zoomOut, resetZoom }
}
