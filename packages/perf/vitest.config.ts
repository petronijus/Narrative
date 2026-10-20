import { defineConfig } from 'vitest/config'
import path from 'path'
import { TEST_TIMEOUTS } from '../../vitest.timeouts.js'
import { fsModuleCacheFor } from '../../vitest.cache.js'

export default defineConfig({
  resolve: {
    alias: {
      '@narrative/commands': path.resolve(import.meta.dirname, '../commands/src/index.ts'),
      '@narrative/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts'),
      '@narrative/slide-model': path.resolve(import.meta.dirname, '../slide-model/src/index.ts'),
    },
  },
  test: {
    ...TEST_TIMEOUTS,
    ...fsModuleCacheFor(import.meta.dirname),
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
})
