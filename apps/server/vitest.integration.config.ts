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
  },
})
