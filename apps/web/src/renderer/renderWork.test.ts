import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetRenderWorkForTests,
  pendingRenderWork,
  trackRenderWork,
  whenRenderWorkIdle,
} from './renderWork'

afterEach(() => _resetRenderWorkForTests())

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('renderWork', () => {
  it('is idle with nothing tracked', async () => {
    expect(pendingRenderWork()).toBe(0)
    await expect(whenRenderWorkIdle()).resolves.toBeUndefined()
  })

  it('counts work until it settles, failures included', async () => {
    const a = deferred()
    const b = deferred()
    trackRenderWork(a.promise)
    trackRenderWork(b.promise).catch(() => {})
    expect(pendingRenderWork()).toBe(2)
    let idle = false
    void whenRenderWorkIdle().then(() => (idle = true))
    a.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(idle).toBe(false)
    b.reject(new Error('404'))
    await new Promise((r) => setTimeout(r, 0))
    expect(pendingRenderWork()).toBe(0)
    expect(idle).toBe(true)
  })

  it('stays busy across a chain that starts its next step on settle', async () => {
    const url = deferred<string>()
    const texture = deferred()
    let idle = false
    const chain = trackRenderWork(url.promise).then(() => trackRenderWork(texture.promise))
    void whenRenderWorkIdle().then(() => (idle = true))
    url.resolve('https://cdn.example/x.png')
    await new Promise((r) => setTimeout(r, 0))
    expect(idle).toBe(false)
    expect(pendingRenderWork()).toBe(1)
    texture.resolve()
    await chain
    await new Promise((r) => setTimeout(r, 0))
    expect(idle).toBe(true)
  })

  it('returns the tracked promise unchanged', async () => {
    const p = Promise.resolve(42)
    expect(trackRenderWork(p)).toBe(p)
    await expect(p).resolves.toBe(42)
  })
})
