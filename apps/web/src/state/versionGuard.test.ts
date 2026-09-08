/**
 * state/versionGuard.test.ts
 *
 * The guard's whole job is to reload exactly when the running bundle is older
 * than what the server serves — and to stay put in every other case, because
 * a wrong "yes" here costs the user their unsaved editor state.
 */

import { describe, it, expect } from 'vitest'
import { shouldReloadForNewBuild } from './versionGuard.js'

const base = { running: 'v0.9.2+abc1234', served: 'v0.9.2+abc1234', alreadyReloadedFor: null }

describe('shouldReloadForNewBuild', () => {
  it('reloads when the server has moved on', () => {
    expect(shouldReloadForNewBuild({ ...base, served: 'v0.9.3+def5678' })).toBe(true)
  })

  it('stays put when the versions match', () => {
    expect(shouldReloadForNewBuild(base)).toBe(false)
  })

  it('stays put when the served version is unreadable', () => {
    // Offline, a proxy error, or a deploy mid-flight — a failed check must
    // never be mistaken for "you are stale".
    expect(shouldReloadForNewBuild({ ...base, served: null })).toBe(false)
    expect(shouldReloadForNewBuild({ ...base, served: '' })).toBe(false)
  })

  it('reloads only once for the same served version', () => {
    // Without this a document that keeps coming back stale — a proxy pinning
    // an old copy, say — would reload the tab forever.
    expect(
      shouldReloadForNewBuild({
        running: 'v0.9.2+abc1234',
        served: 'v0.9.3+def5678',
        alreadyReloadedFor: 'v0.9.3+def5678',
      }),
    ).toBe(false)
  })

  it('reloads again when a newer version appears after an earlier reload', () => {
    expect(
      shouldReloadForNewBuild({
        running: 'v0.9.2+abc1234',
        served: 'v0.9.4+999aaaa',
        alreadyReloadedFor: 'v0.9.3+def5678',
      }),
    ).toBe(true)
  })

  it('stays put when the running version is unknown', () => {
    expect(shouldReloadForNewBuild({ ...base, running: '', served: 'v0.9.3+def5678' })).toBe(false)
  })
})
