/**
 * observability/fpsTracker.ts
 *
 * rAF-based FPS tracker s rolling window pro frame times.
 * Počítá: FPS (rolling 1s), frame time avg, p95, p99.
 *
 * Použití:
 *   const tracker = createFpsTracker()
 *   // periodicky čti stats:
 *   const s = tracker.stats()
 *   // při unmount:
 *   tracker.destroy()
 */

const WINDOW_SIZE = 60 // samples

export interface FpsStats {
  /** Rolling 1-second average FPS. */
  fps: number
  /** Average frame time (ms) across current window. */
  frameTimeAvg: number
  /** 95th percentile frame time (ms). */
  frameTimeP95: number
  /** 99th percentile frame time (ms). */
  frameTimeP99: number
}

export interface FpsTracker {
  stats(): FpsStats
  destroy(): void
}

/**
 * Vypočítá percentil p (0–1) z pole čísel. Modifikuje vstupní pole (sort in-place).
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1)
  return sorted[index] ?? 0
}

export function createFpsTracker(): FpsTracker {
  const frameTimes: number[] = []
  let lastTimestamp: number | null = null
  let fps = 0
  let frameCount = 0
  let windowStart = performance.now()
  let rafHandle: number | null = null

  function tick(timestamp: number): void {
    if (lastTimestamp !== null) {
      const dt = timestamp - lastTimestamp
      // Ignoruj nerealisticky velké skoky (tab byl v pozadí)
      if (dt > 0 && dt < 1000) {
        frameTimes.push(dt)
        if (frameTimes.length > WINDOW_SIZE) {
          frameTimes.shift()
        }
        frameCount++
      }
    }
    lastTimestamp = timestamp

    // Reset FPS counter každou sekundu
    const elapsed = timestamp - windowStart
    if (elapsed >= 1000) {
      fps = Math.round((frameCount / elapsed) * 1000)
      frameCount = 0
      windowStart = timestamp
    }

    rafHandle = requestAnimationFrame(tick)
  }

  rafHandle = requestAnimationFrame(tick)

  return {
    stats(): FpsStats {
      if (frameTimes.length === 0) {
        return { fps: 0, frameTimeAvg: 0, frameTimeP95: 0, frameTimeP99: 0 }
      }

      const sum = frameTimes.reduce((a, b) => a + b, 0)
      const avg = sum / frameTimes.length

      // Seřadíme kopii pro percentily
      const sorted = [...frameTimes].sort((a, b) => a - b)

      return {
        fps,
        frameTimeAvg: Math.round(avg * 100) / 100,
        frameTimeP95: Math.round(percentile(sorted, 0.95) * 100) / 100,
        frameTimeP99: Math.round(percentile(sorted, 0.99) * 100) / 100,
      }
    },

    destroy(): void {
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle)
        rafHandle = null
      }
    },
  }
}
