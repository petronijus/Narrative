/**
 * email/templates/deckInvite.test.ts — what the sharing email says: a
 * pending invite and access already given read differently, the role is
 * explained, a deck shows its thumbnail or a title card, a folder up to three
 * of its decks, and nothing a user typed reaches the HTML unescaped.
 */

import { describe, it, expect } from 'vitest'
import { renderDeckInviteEmail, renderFolderInviteEmail } from './deckInvite.js'

const base = {
  recipientEmail: 'jana@example.com',
  inviterName: 'Petr',
  inviterEmail: 'petr@example.com',
  signInUrl: 'https://narrative.example/api/auth/start?returnTo=%2Fdeck%2Fd1',
  role: 'editor' as const,
}

describe('renderDeckInviteEmail', () => {
  it('announces a pending invite that expires', () => {
    const m = renderDeckInviteEmail({ ...base, deckTitle: 'Pitch' })
    expect(m.subject).toBe('Petr shared "Pitch" with you on Narrative')
    expect(m.html).toContain('You’re invited to')
    expect(m.text).toContain('The invite expires in 30 days.')
    expect(m.text).toContain('Role:  Editor — You can edit its slides, text and animations.')
  })

  it('tells someone who already uses Narrative that it is theirs, with no expiry', () => {
    const m = renderDeckInviteEmail({ ...base, deckTitle: 'Pitch', access: 'granted' })
    expect(m.html).toContain('You now have access to')
    expect(m.html).not.toContain('expires')
    expect(m.text).toContain('It is already in your Narrative, under jana@example.com.')
  })

  it("shows the deck's thumbnail when there is one, else a title card", () => {
    const withThumb = renderDeckInviteEmail({
      ...base,
      deckTitle: 'Pitch',
      previewUrl: 'https://narrative.example/imgproxy/sig/x.jpg',
    })
    expect(withThumb.html).toContain('<img src="https://narrative.example/imgproxy/sig/x.jpg"')
    const without = renderDeckInviteEmail({ ...base, deckTitle: 'Pitch' })
    expect(without.html).not.toContain('imgproxy')
  })

  it('escapes everything a person typed', () => {
    const m = renderDeckInviteEmail({
      ...base,
      inviterName: '<b>Eve</b>',
      deckTitle: '"><script>alert(1)</script>',
      previewUrl: 'https://x.example/a.jpg" onerror="alert(1)',
    })
    expect(m.html).not.toContain('<script>')
    expect(m.html).not.toContain('<b>Eve</b>')
    expect(m.html).not.toContain('" onerror="')
  })
})

describe('renderFolderInviteEmail', () => {
  it('shows up to three decks and how many more there are', () => {
    const m = renderFolderInviteEmail({
      ...base,
      role: 'owner',
      folderName: 'Clients',
      access: 'granted',
      deckCount: 7,
      decks: [
        { title: 'A', previewUrl: null },
        { title: 'B', previewUrl: 'https://x.example/b.jpg' },
        { title: 'C', previewUrl: null },
        { title: 'D', previewUrl: null },
      ],
    })
    expect(m.html).toContain('7 decks in this folder &middot; 4 more inside')
    expect(m.html).not.toContain('>D<')
    expect(m.text).toContain('Decks: 7 decks — A, B, C, …')
    expect(m.text).toContain('You can edit everything in it, and share, rename or delete it.')
  })
})
