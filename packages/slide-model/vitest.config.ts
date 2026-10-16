import { defineConfig } from 'vitest/config'
import path from 'path'
import { TEST_TIMEOUTS } from '../../vitest.timeouts.js'
import { fsModuleCacheFor } from '../../vitest.cache.js'

export default defineConfig({
  resolve: {
    alias: {
      '@narrative/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  test: {
    ...TEST_TIMEOUTS,
    ...fsModuleCacheFor(__dirname),
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
})
