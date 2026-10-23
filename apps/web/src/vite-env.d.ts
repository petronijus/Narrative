/// <reference types="vite/client" />

// Injektovaný Vite define pluginem (viz vite.config.ts)
declare const __BUILD_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_BUILD_VERSION?: string
  readonly VITE_HOCUSPOCUS_URL?: string
  readonly VITE_API_URL?: string
  /** Share of page sessions that report their timings (observability/sessionMetrics.ts); default 1. */
  readonly VITE_CLIENT_METRICS_SAMPLE_RATE?: string
  /** The canvas's text engine of this build when the page chooses none: `html` | `runs` (renderer/runText/flag.ts). */
  readonly VITE_TEXT_ENGINE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
