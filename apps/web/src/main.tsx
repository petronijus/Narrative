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
