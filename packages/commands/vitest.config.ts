import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@narrative/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      '@narrative/slide-model': path.resolve(__dirname, '../slide-model/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
