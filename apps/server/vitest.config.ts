import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@narrative/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@narrative/slide-model': path.resolve(__dirname, '../../packages/slide-model/src/index.ts'),
      // The subpath first: aliases match by prefix, in order.
      '@narrative/commands/playbooks': path.resolve(
        __dirname,
        '../../packages/commands/src/playbooks/index.ts',
      ),
      '@narrative/commands': path.resolve(__dirname, '../../packages/commands/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    globals: false,
  },
})
