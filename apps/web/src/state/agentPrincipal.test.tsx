import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  AGENT_PRINCIPAL_MESSAGE_TYPE,
  parseAgentPrincipalMessage,
  type AgentPrincipalMessage,
} from '@narrative/shared'
import {
  AgentPrincipalStoreContext,
  createAgentPrincipalStore,
  useAgentPrincipalKeyFor,
  type AgentPrincipalStore,
} from './agentPrincipal'

const KEY = 'suMEL2lykgqwQ5l03rNxzW'

function wrapperFor(store: AgentPrincipalStore | null) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AgentPrincipalStoreContext value={store}>{children}</AgentPrincipalStoreContext>
  }
}

describe('createAgentPrincipalStore', () => {
  it('notifies only on a change', () => {
    const store = createAgentPrincipalStore()
    let calls = 0
    store.subscribe(() => calls++)
    const message: AgentPrincipalMessage = {
      type: AGENT_PRINCIPAL_MESSAGE_TYPE,
      documentName: 'deck1',
      principalKey: KEY,
    }
    store.set(message)
    store.set({ ...message })
    expect(calls).toBe(1)
    store.set(null)
    expect(calls).toBe(2)
    expect(store.get()).toBeNull()
  })
})

describe('useAgentPrincipalKeyFor', () => {
  it('returns the key the server sent for this document once it arrives', () => {
    const store = createAgentPrincipalStore()
    const { result } = renderHook(() => useAgentPrincipalKeyFor('deck1'), {
      wrapper: wrapperFor(store),
    })
    expect(result.current).toBeNull()
    // The same path SlideDocProvider takes with a stateless payload.
    const parsed = parseAgentPrincipalMessage(
      JSON.stringify({
        type: AGENT_PRINCIPAL_MESSAGE_TYPE,
        documentName: 'deck1',
        principalKey: KEY,
      }),
    )
    act(() => store.set(parsed))
    expect(result.current).toBe(KEY)
  })

  it('never returns a key told for another document', () => {
    const store = createAgentPrincipalStore()
    store.set({ type: AGENT_PRINCIPAL_MESSAGE_TYPE, documentName: 'deck_old', principalKey: KEY })
    const { result } = renderHook(() => useAgentPrincipalKeyFor('deck1'), {
      wrapper: wrapperFor(store),
    })
    expect(result.current).toBeNull()
  })

  it('is null without a store (local-only documents) or without a document', () => {
    expect(
      renderHook(() => useAgentPrincipalKeyFor('deck1'), { wrapper: wrapperFor(null) }).result
        .current,
    ).toBeNull()
    const store = createAgentPrincipalStore()
    store.set({ type: AGENT_PRINCIPAL_MESSAGE_TYPE, documentName: 'deck1', principalKey: KEY })
    expect(
      renderHook(() => useAgentPrincipalKeyFor(null), { wrapper: wrapperFor(store) }).result
        .current,
    ).toBeNull()
  })
})
