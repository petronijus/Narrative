// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentRunSummary } from '@narrative/commands'
import {
  formatRelativeTime,
  notRevertibleText,
  runClientLabel,
  runRequestText,
} from './agentActivity'

const NOW = Date.parse('2026-09-26T12:00:00.000Z')
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString()

function run(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    id: 'run_1',
    userId: 'alice',
    userName: 'Alice',
    surface: 'mcp',
    clientName: null,
    request: 'Shorten slide 3',
    status: 'closed',
    createdAt: ago(600),
    lastActivityAt: ago(300),
    revertedAt: null,
    revertedBy: null,
    opCount: 4,
    changeCount: 2,
    revertibleChanges: 2,
    revertible: true,
    notRevertibleReason: null,
    ...overrides,
  }
}

describe('formatRelativeTime', () => {
  it('reads recent and slightly-future times as "just now"', () => {
    expect(formatRelativeTime(ago(10), NOW)).toBe('just now')
    expect(formatRelativeTime(ago(-5), NOW)).toBe('just now')
  })

  it('picks the largest whole unit', () => {
    expect(formatRelativeTime(ago(90), NOW)).toBe('1 minute ago')
    expect(formatRelativeTime(ago(5 * 60), NOW)).toBe('5 minutes ago')
    expect(formatRelativeTime(ago(2 * 3600), NOW)).toBe('2 hours ago')
    expect(formatRelativeTime(ago(26 * 3600), NOW)).toBe('yesterday')
  })

  it('returns an empty string for an unparseable timestamp', () => {
    expect(formatRelativeTime('not a date', NOW)).toBe('')
  })
})

describe('run wording', () => {
  it('names implicit runs "Automatic run"', () => {
    expect(runRequestText(run({ request: null }))).toBe('Automatic run')
    expect(runRequestText(run({ request: '   ' }))).toBe('Automatic run')
  })

  it('labels the client like the agent peer chip', () => {
    expect(runClientLabel(run())).toBe('Claude (MCP)')
    expect(runClientLabel(run({ surface: 'api', clientName: 'deck-bot' }))).toBe('deck-bot (API)')
    expect(runClientLabel(run({ surface: 'api' }))).toBe('Script (API)')
  })
})

describe('notRevertibleText', () => {
  it('is null while the run can be reverted', () => {
    expect(notRevertibleText(run(), 'me', NOW)).toBeNull()
  })

  it('explains an unloaded document in plain words', () => {
    const text = notRevertibleText(
      run({ revertible: false, notRevertibleReason: 'unloaded' }),
      'me',
      NOW,
    )
    expect(text).toBe('No longer revertible — the deck was closed on the server')
  })

  it('names a component master when the runs worked on one', () => {
    const text = (reason: 'unloaded' | 'nothing_to_revert' | 'not_document'): string | null =>
      notRevertibleText(
        run({ revertible: false, notRevertibleReason: reason }),
        'me',
        NOW,
        'component master',
      )
    expect(text('unloaded')).toBe(
      'No longer revertible — the component master was closed on the server',
    )
    expect(text('nothing_to_revert')).toBe(
      'Nothing to revert — this run did not change the component master',
    )
    expect(text('not_document')).toBe('Not revertible — this run did not edit the component master')
  })

  it('says who reverted, as far as the ids allow', () => {
    const reverted = (revertedBy: string): string | null =>
      notRevertibleText(
        run({
          status: 'reverted',
          revertible: false,
          notRevertibleReason: 'reverted',
          revertedBy,
          revertedAt: ago(120),
        }),
        'me',
        NOW,
      )
    expect(reverted('me')).toBe('Reverted by you 2 minutes ago')
    expect(reverted('alice')).toBe('Reverted by Alice 2 minutes ago')
    expect(reverted('carol')).toBe('Reverted by another collaborator 2 minutes ago')
  })
})
