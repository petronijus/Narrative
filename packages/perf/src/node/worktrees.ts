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

import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { run } from './webBuild.js'

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
  if (!existsSync(path.join(dir, 'node_modules'))) {
    log(`pnpm install in ${dir}`)
    await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: dir,
      env: { ...process.env, CI: '1' },
    })
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
