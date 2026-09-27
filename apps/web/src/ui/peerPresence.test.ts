import { describe, expect, it } from 'vitest'
import type { PeerAwarenessState, PeerInfo } from '@narrative/shared'
import { agentPeerLabel, peerSelectionOnSlide } from './peerPresence'

function peer(clientId: number, state: Partial<PeerAwarenessState>): PeerInfo {
  return {
    clientId,
    isLocal: false,
    state: {
      user: { id: `user-${clientId}`, name: `User ${clientId}`, color: 'hsl(0, 70%, 55%)' },
      selectedObjectIds: ['o1'],
      cursor: null,
      ...state,
    },
  }
}

const agent = (principalKey: string | null, principalName: string | null): PeerInfo =>
  peer(9, {
    user: { id: 'agent:run_1', name: 'Claude (MCP)', color: 'hsl(1, 70%, 55%)' },
    activeSlideId: 's1',
    agent: { runId: 'run_1', surface: 'mcp', principalName, principalKey },
  })

describe('peerSelectionOnSlide', () => {
  it('keeps the pre-A1 behaviour for a peer that does not publish its slide', () => {
    expect(peerSelectionOnSlide(peer(1, {}), 's1')).toEqual(['o1'])
  })

  it('draws a slide-aware peer only on its own slide', () => {
    expect(peerSelectionOnSlide(peer(1, { activeSlideId: 's1' }), 's1')).toEqual(['o1'])
    expect(peerSelectionOnSlide(peer(1, { activeSlideId: 's2' }), 's1')).toEqual([])
  })

  it('draws nothing for a peer that shows no slide (present mode)', () => {
    expect(peerSelectionOnSlide(peer(1, { activeSlideId: null }), 's1')).toEqual([])
  })
})

describe('agentPeerLabel', () => {
  const mine = 'Nr0FXJtfxptAS_duWznRdk'

  it('says "you" when the agent carries the local user\'s key', () => {
    expect(agentPeerLabel(agent(mine, 'Petr'), mine)).toBe('Claude (MCP) — working for you')
  })

  it('names the person by the display name the agent carries', () => {
    expect(agentPeerLabel(agent('someoneElsesKey0000000', 'Alice'), mine)).toBe(
      'Claude (MCP) — working for Alice',
    )
  })

  it('does not claim "you" before the local key is known (or for a share-link viewer)', () => {
    expect(agentPeerLabel(agent(mine, 'Petr'), null)).toBe('Claude (MCP) — working for Petr')
  })

  it('falls back to a neutral phrase without a display name (old server, or no profile name)', () => {
    expect(agentPeerLabel(agent(null, null), mine)).toBe(
      'Claude (MCP) — working for a collaborator',
    )
  })
})
