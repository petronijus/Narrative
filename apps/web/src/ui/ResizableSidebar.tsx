/**
 * ui/ResizableSidebar.tsx
 *
 * P3: horizontally resizable sidebar wrapper. The user drags the right
 * edge to resize; the width is persisted to localStorage so the choice
 * survives reloads. Local-only preference — not synced via Y.Doc.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface ResizableSidebarProps {
  storageKey: string
  minWidth: number
  maxWidth: number
  defaultWidth: number
  side?: 'left' | 'right'
  className?: string
  children: ReactNode
}

function readStored(key: string, fallback: number): number {
  try {
    const v = window.localStorage.getItem(key)
    if (v === null) return fallback
    const n = parseInt(v, 10)
    if (!Number.isFinite(n)) return fallback
    return n
  } catch {
    return fallback
  }
}

export function ResizableSidebar({
  storageKey,
  minWidth,
  maxWidth,
  defaultWidth,
  side = 'left',
  className,
  children,
}: ResizableSidebarProps) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth
    return Math.min(maxWidth, Math.max(minWidth, readStored(storageKey, defaultWidth)))
  })
  const startRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(width))
    } catch {
      // Storage disabled — in-memory width still works for this session.
    }
  }, [storageKey, width])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      startRef.current = { startX: e.clientX, startWidth: width }
      e.preventDefault()
    },
    [width],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const s = startRef.current
      if (s === null) return
      const delta = e.clientX - s.startX
      const raw = side === 'left' ? s.startWidth + delta : s.startWidth - delta
      const clamped = Math.min(maxWidth, Math.max(minWidth, raw))
      setWidth(clamped)
    },
    [minWidth, maxWidth, side],
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    startRef.current = null
    ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
  }, [])

  const handleClass =
    side === 'left'
      ? 'absolute right-0 top-0 h-full w-1.5 -mr-0.5 cursor-col-resize'
      : 'absolute left-0 top-0 h-full w-1.5 -ml-0.5 cursor-col-resize'

  return (
    <aside
      className={'relative flex flex-shrink-0 flex-col ' + (className ?? '')}
      style={{ width }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className={
          handleClass + ' z-10 transition-colors hover:bg-border-strong/60 active:bg-border-strong'
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </aside>
  )
}
