/**
 * scripts/build.test.ts
 *
 * What the packaged shell relies on in its bundles: each preload requires
 * `electron` and nothing else (a sandboxed preload can load nothing else),
 * the main bundle leaves only `electron` and Node built-ins unbundled, and
 * the server dialog's CSP admits exactly its inlined script.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let out: string

beforeAll(() => {
  out = mkdtempSync(path.join(tmpdir(), 'narrative-desktop-build-'))
  execFileSync(process.execPath, ['scripts/build.mjs', '--out', out], { cwd: root })
}, 60_000)
afterAll(() => {
  rmSync(out, { recursive: true, force: true })
})

const requires = (file: string): string[] =>
  [...readFileSync(path.join(out, file), 'utf8').matchAll(/\brequire\("([^"]+)"\)/g)].map(
    (m) => m[1]!,
  )

describe('desktop build', () => {
  it.each(['preload.cjs', 'serverDialogPreload.cjs'])('%s requires only electron', (file) => {
    expect(new Set(requires(file))).toEqual(new Set(['electron']))
  })

  it('leaves only electron and Node built-ins unbundled in the main process', () => {
    const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
    const external = requires('main.cjs').filter((m) => m !== 'electron' && !builtins.has(m))
    expect(external).toEqual([])
  })

  it('admits exactly the server dialog script in its CSP', () => {
    const html = readFileSync(path.join(out, 'serverDialog.html'), 'utf8')
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(scripts).toHaveLength(1)
    const hash = createHash('sha256').update(scripts[0]!, 'utf8').digest('base64')
    expect(html).toContain(`script-src 'sha256-${hash}'`)
    expect(html).not.toContain('__SCRIPT')
  })

  it('records what was built', () => {
    const info = JSON.parse(readFileSync(path.join(out, 'build-info.json'), 'utf8'))
    expect(info.version).toBe(
      JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    )
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof info.dirty).toBe('boolean')
  })
})
