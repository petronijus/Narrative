/**
 * render/jobTimings.test.ts — the worker's steps are checked before they
 * become phases of a timed request.
 */

import { describe, expect, it } from 'vitest'
import { MAX_WORKER_STEPS, reportedWorkerSteps } from './jobTimings.js'

describe('reportedWorkerSteps', () => {
  it('keeps worker.* and page.* steps with plain names and sane durations, in order', () => {
    expect(
      reportedWorkerSteps([
        ['worker.page', 540],
        ['page.ready', 51],
        ['page.ready;dur=0, x', 1],
        ['page.Ready', 1],
        ['other.step', 1],
        ['page.', 1],
        ['page.settle', -1],
        ['page.extract', Number.NaN],
        ['page.encode', Number.POSITIVE_INFINITY],
        ['page.compose', '55'],
        'page.sync',
        ['page.sync', 0, 'extra'],
        ['worker.upload', 17],
      ]),
    ).toEqual([
      ['worker.page', 540],
      ['page.ready', 51],
      ['worker.upload', 17],
    ])
  })

  it('takes none from a malformed field, and at most MAX_WORKER_STEPS', () => {
    for (const bad of [undefined, null, 'x', { steps: [] }])
      expect(reportedWorkerSteps(bad)).toEqual([])
    const many = Array.from({ length: MAX_WORKER_STEPS + 20 }, () => ['page.settle', 1])
    expect(reportedWorkerSteps(many)).toHaveLength(MAX_WORKER_STEPS)
  })
})
