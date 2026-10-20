import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cgroupAvailableBytes, MemoryGate, MemoryWaitTimeout } from './memory.js'

const MB = 1024 * 1024
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cgroup(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cgroup-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content)
  return dir
}

describe('cgroupAvailableBytes', () => {
  it('is the limit less what is used, page cache the kernel can drop not counted', () => {
    const root = cgroup({
      'memory.max': `${1200 * MB}\n`,
      'memory.current': `${700 * MB}\n`,
      'memory.stat': `anon ${500 * MB}\ninactive_file ${100 * MB}\nactive_file ${100 * MB}\n`,
    })
    expect(cgroupAvailableBytes(root)).toBe(600 * MB)
  })

  it('is null without a limit or without cgroup files (a developer machine)', () => {
    expect(
      cgroupAvailableBytes(
        cgroup({ 'memory.max': 'max\n', 'memory.current': '1\n', 'memory.stat': '' }),
      ),
    ).toBeNull()
    expect(cgroupAvailableBytes(cgroup({}))).toBeNull()
  })
})

describe('MemoryGate', () => {
  const log = () => undefined

  it('lets a job in alone whatever the memory, and a second only with room for it', async () => {
    let free = 100 * MB
    const gate = new MemoryGate({
      reserveBytes: 450 * MB,
      available: () => free,
      evictIdle: () => false,
      pollMs: 5,
      log,
    })
    await gate.enter(Date.now() + 1_000, 'first')
    let second = false
    const entering = gate.enter(Date.now() + 1_000, 'second').then(() => (second = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(second).toBe(false)
    free = 500 * MB
    await entering
    expect(gate.active).toBe(2)
    gate.leave()
    gate.leave()
    expect(gate.active).toBe(0)
  })

  it('a waiting job goes in once the job before it leaves', async () => {
    const gate = new MemoryGate({
      reserveBytes: 450 * MB,
      available: () => 0,
      evictIdle: () => false,
      pollMs: 5,
      log,
    })
    await gate.enter(Date.now() + 1_000, 'first')
    const entering = gate.enter(Date.now() + 1_000, 'second')
    setTimeout(() => gate.leave(), 20)
    await entering
    expect(gate.active).toBe(1)
  })

  it('closes idle pages for room, one per look', async () => {
    let free = 300 * MB
    let evicted = 0
    const gate = new MemoryGate({
      reserveBytes: 450 * MB,
      available: () => free,
      evictIdle: () => {
        evicted += 1
        free += 100 * MB
        return true
      },
      pollMs: 5,
      log,
    })
    await gate.enter(Date.now() + 1_000, 'first')
    await gate.enter(Date.now() + 1_000, 'second')
    // 300 → 400 → 500: two pages closed, the second job in.
    expect(evicted).toBe(2)
  })

  it('gives up at the deadline when another job still holds the memory', async () => {
    const gate = new MemoryGate({
      reserveBytes: 450 * MB,
      available: () => 0,
      evictIdle: () => false,
      pollMs: 5,
      log,
    })
    await gate.enter(Date.now() + 1_000, 'first')
    await expect(gate.enter(Date.now() + 30, 'second')).rejects.toBeInstanceOf(MemoryWaitTimeout)
    expect(gate.active).toBe(1)
  })

  it('never waits where no limit is known', async () => {
    const gate = new MemoryGate({
      reserveBytes: 450 * MB,
      available: () => null,
      evictIdle: () => false,
      log,
    })
    await gate.enter(Date.now() + 1_000, 'a')
    await gate.enter(Date.now() + 1_000, 'b')
    expect(gate.active).toBe(2)
  })
})
