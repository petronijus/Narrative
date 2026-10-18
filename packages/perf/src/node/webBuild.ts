/**
 * node/webBuild.ts — production and profiling builds of the web app, served
 * by `vite preview` in front of the dev backend (docs/plans/performance.md →
 * G1, perf-harness.md → Decisions: a third build mode `profiling`).
 *
 * A build goes to an outDir of its own (`apps/web/dist-perf-<mode>`, never the
 * `dist/` the image build and `just size` use), made with NODE_ENV=production
 * and production's relative endpoints (`VITE_API_URL=/api`,
 * `VITE_HOCUSPOCUS_URL=/ws`): the preview's proxies (apps/web/vite.config.ts →
 * `preview.proxy`) map those to the dev backend the way production's Caddy
 * maps them to the API, so the page talks to its own origin on any port.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import type { BuildMode } from '../fingerprint.js'

export type BuiltMode = Exclude<BuildMode, 'dev'>

/** The Vite mode of a build mode: `production`, or `profiling` (react-dom/profiling, kept names). */
export function viteMode(mode: BuiltMode): string {
  return mode === 'prod' ? 'production' : 'profiling'
}

export function outDirFor(mode: BuiltMode): string {
  return `dist-perf-${mode}`
}

/** The environment of a perf build: production's, with production's relative endpoints. */
export function buildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    NODE_ENV: 'production',
    VITE_API_URL: '/api',
    VITE_HOCUSPOCUS_URL: '/ws',
  }
}

export interface RunOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Print the child's output (default: only when it fails). */
  verbose?: boolean
}

/** Run a program to completion; rejects with its output when it fails. */
export function run(file: string, args: readonly string[], o: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: 'pipe' })
    let out = ''
    const take = (b: Buffer): void => {
      out += b.toString()
      if (o.verbose) process.stderr.write(b)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else
        reject(
          new Error(`${file} ${args.join(' ')} (in ${o.cwd}) exited ${code}:\n${out.slice(-4000)}`),
        )
    })
  })
}

/** Vite's CLI as `webDir` resolves it (a worktree has its own). */
function viteBin(webDir: string): string {
  const pkg = createRequire(path.join(webDir, 'package.json')).resolve('vite/package.json')
  const bin = (JSON.parse(readFileSync(pkg, 'utf8')) as { bin: { vite: string } }).bin.vite
  return path.join(path.dirname(pkg), bin)
}

/** `vite build` of `webDir` (an apps/web) in `mode`; returns the outDir's absolute path. */
export async function buildWeb(webDir: string, mode: BuiltMode, verbose = false): Promise<string> {
  const outDir = outDirFor(mode)
  await run(
    process.execPath,
    [viteBin(webDir), 'build', '--mode', viteMode(mode), '--outDir', outDir, '--emptyOutDir'],
    { cwd: webDir, env: buildEnv(), verbose },
  )
  return path.join(webDir, outDir)
}

/** The `/version.json` a build wrote (its identity in a fingerprint), or undefined. */
export function builtVersion(outDirAbs: string): string | undefined {
  const file = path.join(outDirAbs, 'version.json')
  if (!existsSync(file)) return undefined
  const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version
  return typeof v === 'string' ? v : undefined
}

/** A free TCP port on localhost. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, 'localhost', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export interface Preview {
  url: string
  stop(): Promise<void>
}

/** Serve a build with `vite preview` (and its proxies) on a free port; resolves once it answers. */
export async function startPreview(
  webDir: string,
  mode: BuiltMode,
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<Preview> {
  const port = opts.port ?? (await freePort())
  // Vite itself, in a process group of its own: stop() ends the group, so no
  // grandchild keeps the port (or our pipes) after a run.
  const child: ChildProcess = spawn(
    process.execPath,
    [
      viteBin(webDir),
      'preview',
      '--mode',
      viteMode(mode),
      '--outDir',
      outDirFor(mode),
      '--host',
      'localhost',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: webDir, env: buildEnv(), stdio: 'pipe', detached: true },
  )
  let out = ''
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  child.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  const url = `http://localhost:${port}`
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  for (;;) {
    if (child.exitCode !== null) throw new Error(`vite preview exited ${child.exitCode}:\n${out}`)
    try {
      const res = await fetch(`${url}/version.json`)
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      killGroup(child)
      throw new Error(`vite preview did not answer on ${url} within the timeout:\n${out}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        killGroup(child)
      }),
  }
}

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

/** Whether something answers HTTP at `url`. */
export async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return res.status < 500
  } catch {
    return false
  }
}
