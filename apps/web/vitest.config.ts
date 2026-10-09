import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'
import { TEST_TIMEOUTS } from '../../vitest.timeouts.js'

/**
 * The unit-test config: vite.config.ts (whose `test` block holds the suite's
 * settings) plus the repo-wide time limits. Kept apart from vite.config.ts
 * because the production image builds the web app with that file alone and
 * copies only apps/ and packages/ — a root import there would break it.
 */
export default defineConfig((env) =>
  mergeConfig(viteConfig(env), defineConfig({ test: { ...TEST_TIMEOUTS } })),
)
