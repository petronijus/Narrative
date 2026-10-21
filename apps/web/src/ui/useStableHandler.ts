/**
 * ui/useStableHandler.ts — an event handler whose identity never changes but
 * which always runs the latest `handler` it was given.
 *
 * For handlers handed to many memoised children (the slide panel's rows): a
 * `useCallback` that depends on the active slide or the selection is a new
 * function on every switch, so every row re-rendered on every switch — 300
 * rows of a 300-slide deck for the two that changed (docs/plans/
 * performance.md → B3, 2026-10-20). Only for handlers called from events,
 * never during render: the latest one is installed in a layout effect.
 */

import { useCallback, useLayoutEffect, useRef } from 'react'

export function useStableHandler<A extends unknown[], R>(
  handler: (...args: A) => R,
): (...args: A) => R {
  const latest = useRef(handler)
  useLayoutEffect(() => {
    latest.current = handler
  })
  return useCallback((...args: A) => latest.current(...args), [])
}
