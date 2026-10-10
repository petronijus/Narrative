import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderersSandboxed } from './browser.js'

/** A fake /proc: the worker's own user namespace, and processes with their command lines. */
function fakeProc(own: string, processes: Array<{ cmdline: string; userns: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'proc-'))
  mkdirSync(join(root, 'self', 'ns'), { recursive: true })
  symlinkSync(own, join(root, 'self', 'ns', 'user'))
  processes.forEach((p, i) => {
    const dir = join(root, String(100 + i))
    mkdirSync(join(dir, 'ns'), { recursive: true })
    writeFileSync(join(dir, 'cmdline'), p.cmdline.replace(/ /g, '\0'))
    symlinkSync(p.userns, join(dir, 'ns', 'user'))
  })
  return root
}

const roots: string[] = []
const proc = (own: string, processes: Array<{ cmdline: string; userns: string }>) => {
  const root = fakeProc(own, processes)
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('renderersSandboxed', () => {
  it('is true when every renderer runs in another user namespace', () => {
    const root = proc('user:[1]', [
      { cmdline: 'chrome --type=browser', userns: 'user:[1]' },
      { cmdline: 'chrome --type=renderer --lang=en', userns: 'user:[7]' },
    ])
    expect(renderersSandboxed(root)).toBe(true)
  })

  it('is false when a renderer shares the worker’s namespace or runs with --no-sandbox', () => {
    expect(
      renderersSandboxed(
        proc('user:[1]', [{ cmdline: 'chrome --type=renderer', userns: 'user:[1]' }]),
      ),
    ).toBe(false)
    expect(
      renderersSandboxed(
        proc('user:[1]', [{ cmdline: 'chrome --type=renderer --no-sandbox', userns: 'user:[7]' }]),
      ),
    ).toBe(false)
  })

  it('cannot tell without a renderer (null), and that is not a pass', () => {
    expect(
      renderersSandboxed(
        proc('user:[1]', [{ cmdline: 'chrome --type=gpu-process', userns: 'user:[1]' }]),
      ),
    ).toBeNull()
  })
})
