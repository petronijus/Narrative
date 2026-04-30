/**
 * apps/web/src/main.tsx
 *
 * App entry point.
 *
 * M6: Sentry lazy init — jen pokud VITE_SENTRY_DSN je set.
 * Bez DSN = tiché, žádný overhead, dev-friendly.
 *
 * __BUILD_VERSION__ je injektovaný Vite define pluginem z vite.config.ts.
 * V dev = 'dev', v prod CI = VITE_BUILD_VERSION env (git sha).
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { registerBundledFonts } from './state/bundledFonts.js'

// Self-hosted webfonts the picker advertises (Inter). Fire-and-forget
// — the FontLoader for deck-uploaded fonts uses the same Pixi Cache
// shape so any Inter-using text in the deck picks up the metrics
// once registration resolves. We do NOT await here because blocking
// on woff2 fetch would visibly delay the editor mount.
void registerBundledFonts()

// Global pointer-capture lifecycle for native range inputs.
//
// A fast drag that strays outside the slider element otherwise loses
// tracking (especially in scroll containers / popovers). We pin the
// pointer to the slider on pointerdown so the drag follows the
// cursor anywhere.
//
// We also have to be careful to RELEASE capture on every terminal
// event — pointerup, pointercancel, lostpointercapture, and window
// blur — because if the pointerup event is preempted (e.g. the
// inspector unmounts the slider mid-drag when the user changes
// slide / selection, or the OS / browser steals focus) the capture
// leaks: subsequent pointerdown events fire on a "still captured"
// element and the slider behaves as if the mouse is permanently
// down. Tracking the active pointer/input pair lets us force a
// release on any of those signals.
const activeRangeDrags = new Map<number, HTMLInputElement>()

function releaseRangeCapture(pointerId: number): void {
  const input = activeRangeDrags.get(pointerId)
  activeRangeDrags.delete(pointerId)
  if (input === undefined) return
  try {
    if (input.hasPointerCapture(pointerId)) {
      input.releasePointerCapture(pointerId)
    }
  } catch {
    // Detached node / older browser — non-fatal.
  }
}

document.addEventListener(
  'pointerdown',
  (e) => {
    const target = e.target
    if (!(target instanceof HTMLInputElement)) return
    if (target.type !== 'range') return
    // Defensive: if a previous drag never released (window blur,
    // unmounted slider, etc) the same pointer ID could still be
    // held. Drop it before re-capturing the new target.
    releaseRangeCapture(e.pointerId)
    try {
      target.setPointerCapture(e.pointerId)
      activeRangeDrags.set(e.pointerId, target)
    } catch {
      /* Older browsers / detached nodes — non-fatal. */
    }
  },
  // Capture phase so it runs before any React handler that might
  // stopPropagation on the event.
  true,
)

// Terminal events — release capture from whatever input still holds
// the pointer for that ID. All registered in capture phase so they
// fire even when the pointer ends up outside the originally-captured
// element.
const terminate = (e: PointerEvent): void => releaseRangeCapture(e.pointerId)
document.addEventListener('pointerup', terminate, true)
document.addEventListener('pointercancel', terminate, true)
document.addEventListener('lostpointercapture', terminate, true)

// Window blur (alt-tab, devtools focus, OS modal) — the browser
// stops delivering further pointer events but the slider may still
// think the drag is in progress. Release every active drag.
window.addEventListener('blur', () => {
  for (const [pointerId] of activeRangeDrags) {
    releaseRangeCapture(pointerId)
  }
})

// Declare global injected by Vite define
declare const __BUILD_VERSION__: string

// Sentry init — dev-gated, tiché bez DSN
const sentryDsn = import.meta.env['VITE_SENTRY_DSN'] as string | undefined
if (sentryDsn) {
  // Lazy import — Sentry se nenačte pokud DSN není set (tree-shakeable)
  const { init, browserTracingIntegration } = await import('@sentry/react')
  init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    integrations: [browserTracingIntegration()],
    tracesSampleRate: 0.1,
    release: __BUILD_VERSION__,
  })
  console.log('[sentry] Initialized (client)')
}

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root element #root not found')
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
