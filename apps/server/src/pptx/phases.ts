/**
 * pptx/phases.ts
 *
 * Where a PowerPoint import or export spends its time: each step announces
 * its end on a `node:diagnostics_channel`. Nothing listens in production, and
 * an unsubscribed channel costs one property read per phase; the performance
 * driver (`apps/server/perf/pptx.ts`, `just perf-pptx`) subscribes and turns
 * the marks into per-phase wall time and RSS.
 *
 * A phase is the time from the previous mark of the same operation (or from
 * when the caller started it) to this one, so the phases of one run add up to
 * its wall time. Marks carry no deck id: the driver runs one operation at a
 * time, and a server that wanted per-request numbers would wrap the call in
 * its own span instead.
 */

import { channel } from 'node:diagnostics_channel'

export const PPTX_PHASE_CHANNEL = 'narrative:pptx:phase'

export type PptxOperation = 'import' | 'export'

export interface PptxPhaseMark {
  op: PptxOperation
  /** The step that just ended, e.g. `unzip`, `images`, `zip`. */
  phase: string
}

const phases = channel(PPTX_PHASE_CHANNEL)

/** Announce that `phase` of `op` has just ended. */
export function endPhase(op: PptxOperation, phase: string): void {
  if (phases.hasSubscribers) phases.publish({ op, phase } satisfies PptxPhaseMark)
}
