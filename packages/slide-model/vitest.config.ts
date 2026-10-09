import { defineConfig } from 'vitest/config'
import path from 'path'
import { TEST_TIMEOUTS } from '../../vitest.timeouts.js'

export default defineConfig({
  resolve: {
    alias: {
      '@narrative/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  test: {
    ...TEST_TIMEOUTS,
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
})
