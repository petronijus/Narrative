/**
 * shutdown.test.ts — the server's stop order: Hocuspocus stores its
 * documents before anything slow (a PDF worker, requests in flight) is
 * waited for, the agent host lets go of its documents before that, and the
 * database closes only after the requests that use it.
 */

import { describe, expect, it } from 'vitest'
import { shutdownServer, type ShutdownParts } from './shutdown.js'

function parts(slow: { pdf?: Promise<void>; http?: Promise<void> } = {}) {
  const events: string[] = []
  const step = (name: string, wait?: Promise<void>) => async (): Promise<void> => {
    events.push(`${name}:start`)
    await wait
    events.push(`${name}:end`)
  }
  const p: ShutdownParts = {
    stopBackground: () => void events.push('background'),
    stopPdfExports: step('pdf', slow.pdf),
    closeHttp: step('http', slow.http),
    closeAgent: step('agent'),
    closeHocuspocus: step('hocuspocus'),
    closePostgres: step('postgres'),
    closeQueues: step('queues'),
    log: { info: () => undefined, error: (m) => void events.push(`error:${m}`) },
  }
  return { p, events }
}

const never = new Promise<void>(() => undefined)

describe('shutdownServer', () => {
  it('stores documents before waiting for the PDF worker or requests in flight', async () => {
    let endPdf!: () => void
    let endHttp!: () => void
    const { p, events } = parts({
      pdf: new Promise((r) => (endPdf = r)),
      http: new Promise((r) => (endHttp = r)),
    })
    const done = shutdownServer(p)
    await new Promise((r) => setImmediate(r))
    expect(events).toEqual([
      'background',
      'pdf:start',
      'http:start',
      'agent:start',
      'agent:end',
      'hocuspocus:start',
      'hocuspocus:end',
    ])
    endPdf()
    endHttp()
    await done
    expect(events.slice(-4)).toEqual([
      'postgres:start',
      'postgres:end',
      'queues:start',
      'queues:end',
    ])
    expect(events.indexOf('http:end')).toBeLessThan(events.indexOf('postgres:start'))
  })

  it('moves on from requests that do not finish within the budget', async () => {
    const { p, events } = parts({ http: never })
    await shutdownServer(p, { httpBudgetMs: 20 })
    expect(events).toContain('hocuspocus:end')
    expect(events.some((e) => e.startsWith('error:Error closing Fastify'))).toBe(true)
    expect(events.at(-1)).toBe('queues:end')
  })

  it('carries on when a step fails', async () => {
    const { p, events } = parts()
    p.closeAgent = async () => {
      throw new Error('agent broke')
    }
    await shutdownServer(p)
    expect(events).toContain('hocuspocus:end')
    expect(events).toContain('error:Error closing Agent host:')
  })
})
