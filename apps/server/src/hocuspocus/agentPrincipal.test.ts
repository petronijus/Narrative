/**
 * hocuspocus/agentPrincipal.test.ts — each signed-in editor is told its own
 * agent principal key over the WebSocket; share-link viewers are not.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_PRINCIPAL_MESSAGE_TYPE, parseAgentPrincipalMessage } from '@narrative/shared'
import { createAgentPrincipalKeys } from '../agent/presence.js'
import {
  DEV_AGENT_PRINCIPAL_KEY_SECRET,
  agentPrincipalKeySecretFromEnv,
} from '../agent/principalKeySecret.js'
import { agentPrincipalMessageFor } from './agentPrincipal.js'
import {
  createAgentWorld,
  eventually,
  settle,
  type AgentWorld,
} from '../test-support/agentWorld.js'

const keys = createAgentPrincipalKeys('unit-test-secret-for-agent-principal-keys')

describe('agentPrincipalMessageFor', () => {
  it('names the key of the connection user on that document', () => {
    expect(agentPrincipalMessageFor(keys, 'deck1', { userId: 'ed', role: 'editor' })).toEqual({
      type: AGENT_PRINCIPAL_MESSAGE_TYPE,
      documentName: 'deck1',
      principalKey: keys.keyFor('deck1', 'ed'),
    })
    expect(agentPrincipalMessageFor(keys, 'component:c1', { userId: 'ed' })?.principalKey).toBe(
      keys.keyFor('component:c1', 'ed'),
    )
  })

  it('sends nothing to share-link connections, unauthenticated ones or folder documents', () => {
    expect(
      agentPrincipalMessageFor(keys, 'deck1', { userId: 'share:abcd1234', shareToken: 't' }),
    ).toBeNull()
    expect(agentPrincipalMessageFor(keys, 'deck1', { userId: 'share:abcd1234' })).toBeNull()
    expect(agentPrincipalMessageFor(keys, 'deck1', {})).toBeNull()
    expect(agentPrincipalMessageFor(keys, 'deck1', undefined)).toBeNull()
    expect(agentPrincipalMessageFor(keys, 'folder:f1', { userId: 'ed' })).toBeNull()
  })
})

describe('agentPrincipalKeySecretFromEnv', () => {
  it('requires a secret of at least 32 characters in production', () => {
    expect(() => agentPrincipalKeySecretFromEnv({}, { isProd: true })).toThrow(/must be set/)
    expect(() =>
      agentPrincipalKeySecretFromEnv({ AGENT_PRINCIPAL_KEY_SECRET: 'short' }, { isProd: true }),
    ).toThrow(/at least 32/)
    expect(() =>
      agentPrincipalKeySecretFromEnv(
        { AGENT_PRINCIPAL_KEY_SECRET: DEV_AGENT_PRINCIPAL_KEY_SECRET },
        { isProd: true },
      ),
    ).toThrow(/dev-only/)
    const secret = 'x'.repeat(48)
    expect(
      agentPrincipalKeySecretFromEnv(
        { AGENT_PRINCIPAL_KEY_SECRET: ` ${secret} ` },
        { isProd: true },
      ),
    ).toBe(secret)
  })

  it('falls back to the dev-only secret outside production', () => {
    expect(agentPrincipalKeySecretFromEnv({}, { isProd: false })).toBe(
      DEV_AGENT_PRINCIPAL_KEY_SECRET,
    )
  })
})

describe('over WebSocket', () => {
  let world: AgentWorld
  afterEach(async () => {
    await world.destroy()
  })

  it('tells a signed-in editor its own key, which is what its agent peer carries', async () => {
    world = await createAgentWorld()
    world.createDeck('deck1')
    world.grant('deck1', 'ed', 'editor')
    world.grant('deck1', 'share:abcd1234', 'viewer')
    const editor = await world.connect('deck1', 'ed')
    const viewer = await world.connect('deck1', 'share:abcd1234')

    await eventually(() => editor.stateless.some((p) => parseAgentPrincipalMessage(p) !== null))
    const message = editor.stateless.map(parseAgentPrincipalMessage).find((m) => m !== null)!
    expect(message).toEqual({
      type: AGENT_PRINCIPAL_MESSAGE_TYPE,
      documentName: 'deck1',
      principalKey: world.principalKeys.keyFor('deck1', 'ed'),
    })

    await settle()
    expect(viewer.stateless.map(parseAgentPrincipalMessage).filter((m) => m !== null)).toEqual([])
  })
})
