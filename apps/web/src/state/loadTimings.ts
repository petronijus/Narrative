/**
 * state/loadTimings.ts
 *
 * P12d/P12e: cold-start timing breakdown surfaced in the perf HUD.
 *
 * Usage:
 *   - Record `loadStart` as early as possible on a deck navigation.
 *     `DeckEditor` mounts → calls `markDeckLoadStart()` once per deck.
 *   - Each subsequent milestone calls its own marker
 *     (`markWsConnected`, `markWsSynced`, `markPixiReady`,
 *     `markFirstPaint`). Each marker stores `performance.now() - start`
 *     so the HUD can render absolute deltas without extra math.
 *
 * The data lives on `window.__narrative_perf.loadTimings` so the perf
 * HUD reads it via the same handle that already exposes `app` +
 * `resourceManager`. Read-only from the HUD's perspective.
 *
 * Restart semantics: navigating to a different deck resets `start` —
 * subsequent markers are measured from the new navigation, so each
 * deck load shows its own breakdown without history accumulation.
 */

export interface LoadTimings {
  /** Absolute `performance.now()` at navigation start. */
  start: number
  /** Hocuspocus provider `onConnect` fired (ms since start). */
  wsConnectedMs: number | null
  /** Hocuspocus provider `onSynced` fired (ms since start). */
  wsSyncedMs: number | null
  /** Pixi `app.init()` resolved + scene graph ready (ms since start). */
  pixiReadyMs: number | null
  /** First synchronous render landed (ms since start). */
  firstPaintMs: number | null
}

interface PerfWindow {
  __narrative_perf?: { loadTimings?: LoadTimings; [key: string]: unknown }
}

function getOrInit(): LoadTimings | null {
  const w = window as unknown as PerfWindow
  if (w.__narrative_perf === undefined) return null
  return w.__narrative_perf.loadTimings ?? null
}

function ensure(start?: number): LoadTimings {
  const w = window as unknown as PerfWindow
  if (w.__narrative_perf === undefined) {
    w.__narrative_perf = {}
  }
  let t = w.__narrative_perf.loadTimings
  if (t === undefined || start !== undefined) {
    t = {
      start: start ?? performance.now(),
      wsConnectedMs: null,
      wsSyncedMs: null,
      pixiReadyMs: null,
      firstPaintMs: null,
    }
    w.__narrative_perf.loadTimings = t
  }
  return t
}

/**
 * Stamp t0. Called on `DeckEditor` mount per deck navigation. Resets
 * subsequent milestone markers so each navigation gets a fresh
 * breakdown.
 */
export function markDeckLoadStart(): void {
  ensure(performance.now())
}

function markMilestone(field: keyof Omit<LoadTimings, 'start'>): void {
  const t = getOrInit()
  if (t === null) return
  if (t[field] !== null) return
  t[field] = Math.round(performance.now() - t.start)
}

export function markWsConnected(): void {
  markMilestone('wsConnectedMs')
}
export function markWsSynced(): void {
  markMilestone('wsSyncedMs')
}
export function markPixiReady(): void {
  markMilestone('pixiReadyMs')
}
export function markFirstPaint(): void {
  markMilestone('firstPaintMs')
}

/** Read-only snapshot for the HUD. */
export function readLoadTimings(): LoadTimings | null {
  return getOrInit()
}
