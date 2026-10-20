/**
 * state/DeckRoleContext.test.tsx — the deck's role is asked for once per
 * deck and share link, not on every change of the query: the render page
 * switches `?slide=` for every slide it shows, and each switch used to ask
 * GET /decks/:id again (docs/plans/performance.md, R1).
 */

import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { MemoryRouter, useSearchParams } from 'react-router-dom'
import { DeckRoleProvider, useDeckRole } from './DeckRoleContext'

const getDeck = vi.fn(async (_id: string, _opts?: { shareToken?: string }) => ({
  viewerRole: 'editor' as const,
  folderId: 'f1',
}))

// One client and one signed-in person for the whole test, as the app's providers hold them.
const api = { getDeck }
const auth = { user: { sub: 'u1' } }
vi.mock('../api/client.js', () => ({ useApi: () => api }))
vi.mock('./AuthContext.js', () => ({ useAuth: () => auth }))

let setParams: ReturnType<typeof useSearchParams>[1] = () => undefined
let role = ''

function Probe() {
  const [, set] = useSearchParams()
  setParams = set
  role = useDeckRole().role
  return null
}

describe('DeckRoleProvider', () => {
  it('reads the deck once while ?slide= changes, again for another share link', async () => {
    render(
      <MemoryRouter initialEntries={['/deck/d1/render?slide=0']}>
        <DeckRoleProvider deckId="d1">
          <Probe />
        </DeckRoleProvider>
      </MemoryRouter>,
    )
    await act(async () => undefined)
    expect(getDeck).toHaveBeenCalledTimes(1)
    expect(role).toBe('editor')

    for (const slide of ['1', '2', '3']) {
      await act(async () => {
        setParams((p) => {
          const next = new URLSearchParams(p)
          next.set('slide', slide)
          return next
        })
      })
    }
    expect(getDeck).toHaveBeenCalledTimes(1)

    await act(async () => {
      setParams({ slide: '3', share_token: 'tok' })
    })
    expect(getDeck).toHaveBeenCalledTimes(2)
    expect(getDeck).toHaveBeenLastCalledWith('d1', { shareToken: 'tok' })
  })
})
