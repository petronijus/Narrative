/**
 * e2e/perf/lib/reactHook.ts — React render accounting for the perf scenarios.
 *
 * A minimal React DevTools hook, installed with `page.addInitScript` before
 * the page's own scripts run (React reads the hook while its chunk evaluates,
 * so nothing loaded later could install it). Every commit is counted, and the
 * components that rendered in it by name: `window.__narrative_react_perf`,
 * which the in-page harness (apps/web/src/perf/harness.ts) reads and resets.
 *
 * Render counts work in every build; render times (`actualDuration`) exist
 * in dev and profiling builds only, and component names are minified in a
 * prod build (the profiling build keeps them). Taken from the crowded-slide
 * probe (perf-heavy-slide.spec.ts, PERF_REACT=1), now always on: a hook that
 * React talks to costs a little itself, the same in every run and mode.
 *
 * Self-contained: Playwright serialises the function into the page.
 */

export function installReactPerfHook(): void {
  interface Fiber {
    tag: number
    type: {
      displayName?: string
      name?: string
      render?: { displayName?: string; name?: string }
    } | null
    flags: number
    alternate: Fiber | null
    _debugOwner?: Fiber | null
    child: Fiber | null
    sibling: Fiber | null
    actualDuration?: number
  }
  const w = window as unknown as {
    __narrative_react_perf: {
      commits: number
      renders: number
      byName: Record<string, { n: number; ms: number }>
    }
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown>
  }
  w.__narrative_react_perf = { commits: 0, renders: 0, byName: {} }
  const PERFORMED_WORK = 1
  // Function, class, forwardRef, memo, simple memo components.
  const COMPONENT = new Set([0, 1, 11, 14, 15])
  const nameOf = (f: Fiber): string =>
    f.type?.displayName ??
    f.type?.name ??
    f.type?.render?.displayName ??
    f.type?.render?.name ??
    '(anon)'
  const onCommit = (root: { current: Fiber }): void => {
    const r = w.__narrative_react_perf
    r.commits++
    const record = (f: Fiber): void => {
      if ((f.flags & PERFORMED_WORK) === 0 || !COMPONENT.has(f.tag)) return
      r.renders++
      let childMs = 0
      for (let c = f.child; c !== null; c = c.sibling) childMs += c.actualDuration ?? 0
      const own = nameOf(f)
      const owner = f._debugOwner != null ? nameOf(f._debugOwner) : ''
      const key = own === '(anon)' || own.length <= 2 ? `${own} <${owner}` : own
      const e = (r.byName[key] ??= { n: 0, ms: 0 })
      e.n++
      e.ms += Math.max(0, (f.actualDuration ?? 0) - childMs)
    }
    // A subtree React bailed out of keeps its old fibers, flags and all:
    // descend only where the child list changed (as DevTools does).
    const mounted = (f: Fiber): void => {
      record(f)
      for (let c = f.child; c !== null; c = c.sibling) mounted(c)
    }
    const updated = (next: Fiber, prev: Fiber): void => {
      record(next)
      if (next.child === prev.child) return
      for (let c = next.child; c !== null; c = c.sibling) {
        if (c.alternate !== null) updated(c, c.alternate)
        else mounted(c)
      }
    }
    const fiber = root.current
    if (fiber.alternate !== null) updated(fiber, fiber.alternate)
    else mounted(fiber)
  }
  const existing = w.__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (existing !== undefined) {
    // A real DevTools hook (an extension): count alongside it.
    const original = existing['onCommitFiberRoot'] as ((...a: unknown[]) => unknown) | undefined
    existing['onCommitFiberRoot'] = (...a: unknown[]) => {
      onCommit(a[1] as { current: Fiber })
      return original?.(...a)
    }
    return
  }
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => undefined,
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => onCommit(root),
  }
}
