import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_TIMEOUTS } from '../../vitest.timeouts.js'
import { fsModuleCacheFor } from '../../vitest.cache.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@narrative/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    ...TEST_TIMEOUTS,
    ...fsModuleCacheFor(__dirname),
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
