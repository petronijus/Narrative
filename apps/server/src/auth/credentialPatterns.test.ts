import { describe, expect, it } from 'vitest'
import {
  CREDENTIAL_PREFIXES,
  looksLikeNarrativeCredential,
  maskCredentials,
  scrubString,
} from '@narrative/shared'
import { redactForAudit } from '../agent/opRedaction.js'
import { scrubSecrets } from '../../../../tests/agent-eval/lib/report.js'

describe('Narrative credential patterns', () => {
  const secret = 'Ab9_-xYz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZa'

  it.each(CREDENTIAL_PREFIXES.map((p) => [p]))(
    '%s_… is masked by Sentry, the audit log and agent eval recordings',
    (prefix) => {
      const token = `${prefix}_${secret}`
      const line = `curl -H 'Authorization: Bearer ${token}' https://x/api`
      expect(maskCredentials(line, '[x]')).toBe(
        `curl -H 'Authorization: Bearer ${prefix}_[x]' https://x/api`,
      )
      expect(scrubString(line)).not.toContain(secret)
      expect(JSON.stringify(redactForAudit({ line }))).not.toContain(secret)
      expect(JSON.stringify(scrubSecrets({ transcript: [line] }))).not.toContain(secret)
    },
  )

  it('recognises each prefix, and nothing else, as a credential', () => {
    for (const prefix of CREDENTIAL_PREFIXES) {
      expect(looksLikeNarrativeCredential(`${prefix}_${secret}`)).toBe(true)
    }
    for (const other of ['cookie', 'metrics-secret', 'nrtx_abc', 'Bearer nrt_abc', '', null]) {
      expect(looksLikeNarrativeCredential(other)).toBe(false)
    }
  })

  it('covers every prefix a Narrative credential uses', () => {
    // Update packages/shared/src/credentialPatterns.ts (and this list) when a new format appears.
    expect([...CREDENTIAL_PREFIXES].sort()).toEqual([
      'nmc',
      'nmo',
      'nmr',
      'nms',
      'nrr',
      'nrt',
      'nus',
    ])
  })
})
