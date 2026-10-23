// @vitest-environment node
/**
 * ui/animationTriggers.test.ts
 *
 * The trigger pickers (timeline bar, Inspector) never offer the legacy
 * `onEnter` for a new choice, but keep it selectable on a step that still
 * has it, so a picker never claims a trigger the step does not have.
 * (Where steps sit on the timeline is pinned against the compiler in
 * packages/animation/src/__tests__/timelineLayout.test.ts.)
 */

import { describe, expect, it } from 'vitest'
import { triggerOptionsFor } from './animationTriggers.js'

describe('triggerOptionsFor', () => {
  it('keeps a stored legacy onEnter selectable, and offers it to nobody else', () => {
    expect(triggerOptionsFor('onEnter')).toContain('onEnter')
    for (const t of ['withPrevious', 'afterPrevious', 'onClick'] as const) {
      const options = triggerOptionsFor(t)
      expect(options).not.toContain('onEnter')
      expect(options).toContain(t)
    }
  })
})
