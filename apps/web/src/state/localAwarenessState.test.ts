// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { peerColorFromId } from '@narrative/shared'
import { localPeerUser, restoredLocalState } from './localAwarenessState'

describe('localPeerUser', () => {
  const peerId = 'V1StGXR8_Z5jdHi6B-myT'

  it('publishes the random peer id and the sanitised profile name, never an account id', () => {
    expect(localPeerUser(peerId, ' Petr‮ <Janda> ')).toEqual({
      id: peerId,
      name: 'Petr Janda',
      color: peerColorFromId(peerId),
    })
  })

  it('falls back to a neutral label, not the email, without a profile name', () => {
    expect(localPeerUser(peerId, null).name).toBe('User V1St')
    expect(localPeerUser(peerId, undefined).name).toBe('User V1St')
    expect(localPeerUser(peerId, '​ ').name).toBe('User V1St')
  })

  it('carries over into the restored awareness state unchanged', () => {
    const user = localPeerUser(peerId, 'Petr')
    expect(restoredLocalState(user, null)).toEqual({
      user,
      selectedObjectIds: [],
      cursor: null,
      activeSlideId: null,
    })
  })
})
