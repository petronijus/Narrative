import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { agentOrigin, isAgentOrigin, releaseAgentOrigin } from './origins.js'
import { LOCAL_ORIGIN } from './mutations.js'

describe('agentOrigin', () => {
  it('is identity-stable per run until released', () => {
    const a = agentOrigin('run-1')
    expect(agentOrigin('run-1')).toBe(a)
    expect(agentOrigin('run-2')).not.toBe(a)
    releaseAgentOrigin('run-1')
    expect(agentOrigin('run-1')).not.toBe(a)
    expect(agentOrigin('run-1')).toEqual(a)
  })

  it('rejects an empty run id', () => {
    expect(() => agentOrigin('')).toThrow()
  })

  it('is recognised by isAgentOrigin, and the human origin is not', () => {
    expect(isAgentOrigin(agentOrigin('run-3'))).toBe(true)
    expect(isAgentOrigin(LOCAL_ORIGIN)).toBe(false)
    expect(isAgentOrigin(null)).toBe(false)
    expect(isAgentOrigin({ kind: 'agent' })).toBe(false)
  })

  it('wins over the LOCAL_ORIGIN of a nested transaction', () => {
    // The whole agentic host design rests on this Yjs rule: the outermost
    // transaction's origin is the one observers and UndoManagers see.
    const doc = new Y.Doc()
    const seen: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => seen.push(tr.origin))
    const origin = agentOrigin('run-4')
    doc.transact(() => {
      doc.transact(() => doc.getArray('a').push([1]), LOCAL_ORIGIN)
    }, origin)
    expect(seen).toEqual([origin])
  })
})
