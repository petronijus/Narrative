/**
 * node/worktrees.ts — a checkout of another revision to build and serve for
 * `just perf-compare` / `just perf-bisect` (docs/plans/perf-harness.md →
 * Commands): a detached git worktree per commit under the harness's cache
 * directory, its dependencies installed from the pnpm store. The working tree
 * of this checkout is never touched (no `git checkout`, no `git bisect` in it).
 *
 * The special revision `.` is this checkout as it is, uncommitted changes
 * included.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { run } from './webBuild.js'

/** Written into a worktree's node_modules once its install succeeded. */
const INSTALLED_MARKER = '.narrative-perf-installed'

export const WORKING_TREE = '.'

export interface Checkout {
  /** As given: a ref, a sha, or `.`. */
  rev: string
  /** The commit (the working tree's HEAD for `.`). */
  sha: string
  /** The repository root of the checkout. */
  root: string
  /** Its apps/web. */
  webDir: string
}

export async function resolveSha(repo: string, rev: string): Promise<string> {
  const ref = rev === WORKING_TREE ? 'HEAD' : rev
  return (await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repo })).trim()
}

/** A checkout of `rev`: this repository for `.`, else a worktree under `cacheDir/worktrees/<sha>`. */
export async function checkout(
  repo: string,
  rev: string,
  cacheDir: string,
  log: (line: string) => void = () => undefined,
): Promise<Checkout> {
  const sha = await resolveSha(repo, rev)
  if (rev === WORKING_TREE) return { rev, sha, root: repo, webDir: path.join(repo, 'apps', 'web') }
  const dir = path.join(cacheDir, 'worktrees', sha.slice(0, 12))
  if (!existsSync(path.join(dir, '.git'))) {
    mkdirSync(path.dirname(dir), { recursive: true })
    log(`worktree ${sha.slice(0, 12)} → ${dir}`)
    await run('git', ['worktree', 'add', '--detach', dir, sha], { cwd: repo })
  }
  // A marker, not node_modules: a failed install leaves node_modules behind.
  const installed = path.join(dir, 'node_modules', INSTALLED_MARKER)
  if (!existsSync(installed)) {
    log(`pnpm install in ${dir}`)
    // An older revision may not yet decline a dependency's build script that
    // today's pnpm refuses to leave unapproved (strictDepBuilds: electron-
    // winstaller before 989163a5): a measured checkout needs the scripts its
    // own allowBuilds runs, never a failed install over one it ignores.
    await run(
      'pnpm',
      ['install', '--frozen-lockfile', '--prefer-offline', '--config.strict-dep-builds=false'],
      { cwd: dir, env: { ...process.env, CI: '1' } },
    )
    writeFileSync(installed, `${new Date().toISOString()}\n`)
  }
  return { rev, sha, root: dir, webDir: path.join(dir, 'apps', 'web') }
}

/** The first-parent commits after `good` up to and including `bad`, oldest first. */
export async function commitsBetween(repo: string, good: string, bad: string): Promise<string[]> {
  const out = await run('git', ['rev-list', '--first-parent', '--reverse', `${good}..${bad}`], {
    cwd: repo,
  })
  return out.split('\n').filter((l) => l.trim() !== '')
}
