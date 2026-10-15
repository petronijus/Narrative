import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUTS } from '../../vitest.timeouts.js'
import { fsModuleCacheFor } from '../../vitest.cache.js'

export default defineConfig({
  test: {
    ...TEST_TIMEOUTS,
    ...fsModuleCacheFor(import.meta.dirname),
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
})
