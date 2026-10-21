/**
 * authBroadcast.test.ts — a tab that hears another tab run for someone else
 * (or sign out) stops its local-copy writes and reloads; the same user, or a
 * tab that does not know its own user yet, changes nothing (ADR 0017,
 * security review M3).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_CHANNEL, __setSessionChangeHandlerForTests, announceSession } from './authBroadcast'
import { localCopyUser, setLocalCopyUser } from './localDocCopy'

/** What another tab sends on the channel. */
async function fromOtherTab(sub: string | null): Promise<void> {
  const other = new BroadcastChannel(AUTH_CHANNEL)
  other.postMessage({ type: 'session', sub })
  other.close()
  // BroadcastChannel delivers asynchronously.
  await new Promise((r) => setTimeout(r, 20))
}

afterEach(() => {
  __setSessionChangeHandlerForTests(null)
  setLocalCopyUser(null)
})

describe('session broadcast', () => {
  it('stops writing and reloads when another tab signs out or signs in as someone else', async () => {
    for (const other of [null, 'bob']) {
      const changed = vi.fn()
      __setSessionChangeHandlerForTests(changed)
      setLocalCopyUser('ann')
      announceSession('ann')
      await fromOtherTab(other)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(localCopyUser()).toBeNull()
      __setSessionChangeHandlerForTests(null)
    }
  })

  it('changes nothing for the same user, or while the tab does not know its own', async () => {
    const changed = vi.fn()
    __setSessionChangeHandlerForTests(changed)
    await fromOtherTab('bob')
    expect(changed).not.toHaveBeenCalled()
    setLocalCopyUser('ann')
    announceSession('ann')
    await fromOtherTab('ann')
    await fromOtherTab('ann')
    expect(changed).not.toHaveBeenCalled()
    expect(localCopyUser()).toBe('ann')
  })

  it('ignores anything that is not a session message', async () => {
    const changed = vi.fn()
    __setSessionChangeHandlerForTests(changed)
    announceSession('ann')
    const other = new BroadcastChannel(AUTH_CHANNEL)
    other.postMessage({ type: 'other', sub: 'bob' })
    other.postMessage('nonsense')
    other.close()
    await new Promise((r) => setTimeout(r, 20))
    expect(changed).not.toHaveBeenCalled()
  })
})
