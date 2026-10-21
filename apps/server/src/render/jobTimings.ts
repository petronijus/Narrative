/**
 * render/jobTimings.ts — the render worker's own steps of a job
 * (`RenderJobResult.timings`) as phases of a timed request
 * (observability/phases.ts, docs/plans/performance.md G7).
 *
 * The worker is a separate process and its page runs the web app: what it
 * hands back is checked before it becomes a phase name — `worker.<step>` or
 * `page.<step>`, the step a plain lower-case dotted token — with a finite,
 * non-negative duration, and at most MAX_WORKER_STEPS of them. Anything
 * else is dropped (security review of G7, 2026-10-20).
 */

/** At most this many worker steps become phases. */
export const MAX_WORKER_STEPS = 64

const WORKER_STEP = /^(worker|page)\.[a-z][a-z0-9.]{0,40}$/

/** The worker's steps that may become `render.<step>` phases, in order. */
export function reportedWorkerSteps(timings: unknown): Array<[string, number]> {
  if (!Array.isArray(timings)) return []
  const out: Array<[string, number]> = []
  for (const entry of timings) {
    if (out.length >= MAX_WORKER_STEPS) break
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [step, ms] = entry as [unknown, unknown]
    if (typeof step !== 'string' || !WORKER_STEP.test(step)) continue
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) continue
    out.push([step, ms])
  }
  return out
}
