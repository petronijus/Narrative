/**
 * ui/PerfHud.tsx
 *
 * P12 baseline measurement surface. Top-right floating panel,
 * sampled ~4×/s, reading from `window.__narrative_perf` which
 * Canvas.tsx populates after Pixi `app.init()` resolves.
 *
 * Numbers we care about during the perf pass:
 *   - FPS / frame ms — primary signal for "is the editor smooth?"
 *   - Pixi container count (recursive from stage) — catches scene
 *     graph leaks (forgotten transition incoming roots, ghost peers)
 *   - ResourceManager texture count — the gradient/background/etc.
 *     leak hunt; should stay roughly constant as the user edits.
 *   - JS heap (Chromium only) — mid-session memory drift.
 *
 * The HUD itself is deliberately cheap: a single setInterval at
 * 250 ms doing read-only field accesses and one React state update
 * per tick. It also samples a rolling FPS so the displayed value
 * isn't just whatever Pixi reported in the last frame (which can
 * spike misleadingly when an animation kicks in).
 */

import { useEffect, useRef, useState } from 'react'
import type { Application, Container } from 'pixi.js'
import { usePerfHud } from '../state/PerfHudContext.js'

interface PerfSnapshot {
  ready: boolean
  fps: number
  frameMs: number
  containers: number
  textures: number
  procedural: number
  heapMb: number | null
}

interface PerfHandle {
  app: Application
  resourceManager: {
    textureCount: number
    /** P12c: optional — older builds don't expose this. */
    proceduralTextureCount?: number
  }
}

function readHandle(): PerfHandle | null {
  return (window as unknown as { __narrative_perf?: PerfHandle }).__narrative_perf ?? null
}

function countContainers(node: Container): number {
  let n = 1
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child !== undefined) n += countContainers(child as Container)
  }
  return n
}

function readHeapMb(): number | null {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } }
  if (perf.memory === undefined) return null
  return Math.round(perf.memory.usedJSHeapSize / (1024 * 1024))
}

export function PerfHud() {
  const { enabled } = usePerfHud()
  const [snap, setSnap] = useState<PerfSnapshot>({
    ready: false,
    fps: 0,
    frameMs: 0,
    containers: 0,
    textures: 0,
    procedural: 0,
    heapMb: null,
  })

  // Rolling FPS — average over the last ~1s of samples so the number
  // doesn't twitch every 250 ms.
  const fpsBufRef = useRef<number[]>([])

  useEffect(() => {
    if (!enabled) return

    let stopped = false
    const id = window.setInterval(() => {
      if (stopped) return
      const handle = readHandle()
      if (handle === null) {
        setSnap((s) => (s.ready ? { ...s, ready: false } : s))
        return
      }
      const { app, resourceManager } = handle
      const fps = app.ticker.FPS
      const buf = fpsBufRef.current
      buf.push(fps)
      if (buf.length > 4) buf.shift()
      const avgFps = buf.reduce((a, b) => a + b, 0) / buf.length
      const frameMs = avgFps > 0 ? 1000 / avgFps : 0
      setSnap({
        ready: true,
        fps: Math.round(avgFps),
        frameMs: Math.round(frameMs * 10) / 10,
        containers: countContainers(app.stage),
        textures: resourceManager.textureCount,
        procedural: resourceManager.proceduralTextureCount ?? 0,
        heapMb: readHeapMb(),
      })
    }, 250)

    return () => {
      stopped = true
      window.clearInterval(id)
      fpsBufRef.current = []
    }
  }, [enabled])

  if (!enabled) return null

  return (
    <div
      className="pointer-events-none fixed right-2 top-2 z-50 select-none rounded-md border border-white/10 bg-black/70 px-3 py-2 font-mono text-[11px] leading-tight text-white shadow-lg backdrop-blur-sm"
      role="status"
      aria-live="off"
    >
      {!snap.ready ? (
        <div className="text-white/60">perf · waiting for renderer…</div>
      ) : (
        <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
          <span className="text-white/60">FPS</span>
          <span className={fpsClass(snap.fps)}>{snap.fps}</span>
          <span className="text-white/60">frame</span>
          <span>{snap.frameMs.toFixed(1)} ms</span>
          <span className="text-white/60">containers</span>
          <span>{snap.containers}</span>
          <span className="text-white/60">textures</span>
          <span>{snap.textures}</span>
          <span className="text-white/60">procedural</span>
          <span>{snap.procedural}</span>
          {snap.heapMb !== null && (
            <>
              <span className="text-white/60">heap</span>
              <span>{snap.heapMb} MB</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function fpsClass(fps: number): string {
  if (fps >= 55) return 'text-emerald-400'
  if (fps >= 40) return 'text-yellow-300'
  return 'text-red-400'
}
