import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/**
 * Integration tests (`*.integration.test.ts`) against the real local Postgres
 * (POSTGRES_URL from the repo .env). Not part of `pnpm test`. Usage:
 *   node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/**/*.integration.test.ts'],
    exclude: [],
    // One file at a time: several suites use database-wide state (migration
    // 0031 re-run over every deck, "no admin yet" at sign-in), and a file
    // deleting its decks meanwhile made them fail by timing alone.
    fileParallelism: false,
    // The PDF export queue of these tests is their own: a dev server's
    // worker on the same Redis would take their jobs (render/pdfExportQueue.ts).
    env: { PDF_EXPORT_QUEUE_NAME: 'pdf-export-it' },
  },
})
