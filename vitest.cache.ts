/**
 * vitest.cache.ts — where each workspace's vitest keeps its fs module cache
 * (each package's config spreads `fsModuleCacheFor(<its dir>)` into `test`,
 * beside TEST_TIMEOUTS; the server's integration suite inherits it).
 *
 * Vitest 5 caches transformed modules on disk, by default in ONE directory
 * for the whole workspace (`<root>/node_modules/.vitest-cache`), and every
 * vitest process wipes that directory when it finds the lockfile changed.
 * `just test` starts up to four packages' vitest at once, and `just mutate`
 * four Stryker workers: after any lockfile change they all `rm -r` the same
 * directory together, and the losers die with ENOTEMPTY (the first
 * `just mutate` after the Stryker runner patch, 2026-10-15). So each package
 * gets its own cache, inside its own node_modules (a reinstall still clears
 * it). Stryker's workers share one sandbox — and through its symlinks one
 * package's node_modules — so under Stryker the cache is off: each worker
 * builds one vitest instance and keeps its modules in memory anyway.
 */
import path from 'node:path'

export function fsModuleCacheFor(
  packageDir: string,
): { fsModuleCache: false } | { fsModuleCachePath: string } {
  if (process.env.STRYKER_MUTATOR_WORKER !== undefined) return { fsModuleCache: false }
  return { fsModuleCachePath: path.join(packageDir, 'node_modules', '.vitest-cache') }
}
