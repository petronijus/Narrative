/**
 * pages/renderTimings.ts — where a render job's time went, for the render
 * worker's log: the page's steps in order (`sync`, then `ready`,
 * `settle` and `extract` per slide, then `encode` or `compose`), and the slowest network
 * loads of the job (path only — a query can carry a signed URL or a token).
 * On the production VM a slide of a photo-heavy deck took 9–15 s where a
 * simple one takes under one; this says which part.
 */

export interface JobTimings {
  /** Milliseconds per step, in order (a step repeats per slide). */
  steps: Array<[string, number]>
  totalMs: number
  /** settleScene's own breakdown per slide (renderer/settleScene.ts, `phases`). */
  settles: Array<Record<string, number>>
  /** Network loads that started during the job. */
  loads: { count: number; totalMs: number; slowest: Array<[string, number]> }
}

export interface JobTimer {
  /** The step that ends now (its time runs from the previous mark). */
  mark(step: string): void
  /** settleScene's breakdown of the slide just settled. */
  settled(phases: Record<string, number>): void
  done(): JobTimings
}

export function startJobTimer(): JobTimer {
  // This page's earlier loads say nothing about this job, and the buffer
  // (250 entries by default) would otherwise fill up and drop this job's.
  performance.clearResourceTimings()
  performance.setResourceTimingBufferSize(2_000)
  const start = performance.now()
  let last = start
  const steps: Array<[string, number]> = []
  const settles: Array<Record<string, number>> = []
  return {
    settled(phases) {
      settles.push(phases)
    },
    mark(step) {
      const now = performance.now()
      steps.push([step, Math.round(now - last)])
      last = now
    },
    done() {
      const entries = performance
        .getEntriesByType('resource')
        .filter((e) => e.startTime >= start) as PerformanceResourceTiming[]
      const slowest = [...entries]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 5)
        .map((e): [string, number] => [pathOf(e.name), Math.round(e.duration)])
      return {
        steps,
        totalMs: Math.round(performance.now() - start),
        settles,
        loads: {
          count: entries.length,
          totalMs: Math.round(entries.reduce((sum, e) => sum + e.duration, 0)),
          slowest,
        },
      }
    },
  }
}

function pathOf(url: string): string {
  try {
    const { pathname } = new URL(url)
    return pathname.length > 80 ? `…${pathname.slice(-80)}` : pathname
  } catch {
    return '(unknown)'
  }
}
