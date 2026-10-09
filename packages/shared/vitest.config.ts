import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUTS } from '../../vitest.timeouts.js'

export default defineConfig({
  test: {
    ...TEST_TIMEOUTS,
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
})
