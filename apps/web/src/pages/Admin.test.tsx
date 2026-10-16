/**
 * pages/Admin.test.tsx — the admin screen (docs/adr/0014): what an admin's
 * clicks send to the API, and that a refusal reads as one. The rules
 * themselves (who may, the last-admin and self guards) are the server's and
 * are tested there.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderWithProviders } from '../test/renderWithProviders'
import { Admin } from './Admin'

const T = '2026-10-16T08:00:00.000Z'

const api = {
  listAllowedEmails: vi.fn(),
  listAdminUsers: vi.fn(),
  allowEmail: vi.fn(),
  removeAllowedEmail: vi.fn(),
  setUserAdmin: vi.fn(),
  listEmailKinds: vi.fn(),
  setEmailEnabled: vi.fn(),
  previewEmail: vi.fn(),
}

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  useApi: () => api,
}))

const person = (over: Record<string, unknown>) => ({
  userId: 'u',
  email: 'u@example.com',
  name: null,
  isAdmin: false,
  firstSeenAt: T,
  lastSeenAt: T,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.listAllowedEmails.mockResolvedValue([
    { email: 'new.hire@example.com', addedBy: 'boss@example.com', addedAt: T, signedIn: false },
  ])
  api.listAdminUsers.mockResolvedValue([
    person({ userId: 'test-user', email: 'test@example.com', name: 'Test User', isAdmin: true }),
    person({ userId: 'jana', email: 'jana@example.com', name: 'Jana' }),
  ])
  api.allowEmail.mockResolvedValue({})
  api.removeAllowedEmail.mockResolvedValue(undefined)
  api.setUserAdmin.mockResolvedValue({})
  api.listEmailKinds.mockResolvedValue([
    {
      kind: 'deleted',
      label: 'Deck or folder deleted',
      description: 'A shared deck or folder is deleted.',
      recipient: 'Everyone else it was shared with',
      group: 'Sharing',
      enabled: true,
    },
  ])
  api.setEmailEnabled.mockImplementation(async (kind: string, enabled: boolean) => ({
    kind,
    label: 'Deck or folder deleted',
    description: 'A shared deck or folder is deleted.',
    recipient: 'Everyone else it was shared with',
    group: 'Sharing',
    enabled,
  }))
  api.previewEmail.mockResolvedValue({ subject: 'Petr deleted the folder', html: '<p>hi</p>' })
})

describe('Admin', () => {
  it('allows a typed address in lower case, then reloads the lists', async () => {
    renderWithProviders(<Admin />)
    const input = await screen.findByLabelText('Email address')
    expect(screen.getByRole('button', { name: /^allow$/i })).toBeDisabled()
    fireEvent.change(input, { target: { value: '  Bela@Example.COM ' } })
    fireEvent.click(screen.getByRole('button', { name: /^allow$/i }))
    await waitFor(() => expect(api.allowEmail).toHaveBeenCalledWith('bela@example.com'))
    await waitFor(() => expect(api.listAllowedEmails).toHaveBeenCalledTimes(2))
  })

  it('asks before it stops allowing an address, and does it on confirm', async () => {
    renderWithProviders(<Admin />)
    fireEvent.click(await screen.findByRole('button', { name: /stop allowing new\.hire/i }))
    expect(api.removeAllowedEmail).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop allowing' }))
    await waitFor(() => expect(api.removeAllowedEmail).toHaveBeenCalledWith('new.hire@example.com'))
  })

  it('makes someone an admin only after the confirmation, and offers no button on yourself', async () => {
    renderWithProviders(<Admin />, { authUser: { sub: 'test-user', email: 'test@example.com' } })
    await screen.findByText('Jana')
    expect(screen.queryByRole('button', { name: /remove admin/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /make admin/i }))
    expect(api.setUserAdmin).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Make admin' }))
    await waitFor(() => expect(api.setUserAdmin).toHaveBeenCalledWith('jana', true))
  })

  it('tells a non-admin that the page is for admins', async () => {
    const { ApiError } = await import('../api/client')
    api.listAllowedEmails.mockRejectedValue(new ApiError(403, 'Forbidden'))
    api.listAdminUsers.mockRejectedValue(new ApiError(403, 'Forbidden'))
    renderWithProviders(<Admin />)
    expect(await screen.findByText('Only admins can open this page.')).toBeTruthy()
  })

  it('turns a kind of email off with its switch, and shows its preview', async () => {
    renderWithProviders(<Admin />)
    const toggle = await screen.findByRole('switch', { name: /deck or folder deleted email on/i })
    fireEvent.click(toggle)
    await waitFor(() => expect(api.setEmailEnabled).toHaveBeenCalledWith('deleted', false))
    expect(
      await screen.findByRole('switch', { name: /deck or folder deleted email off/i }),
    ).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(
      screen.getByRole('button', { name: /preview the deck or folder deleted email/i }),
    )
    await waitFor(() => expect(api.previewEmail).toHaveBeenCalledWith('deleted'))
    const frame = await screen.findByTitle('Deck or folder deleted email preview')
    expect(frame.getAttribute('srcdoc')).toBe('<p>hi</p>')
    expect(frame.getAttribute('sandbox')).toBe('')
  })
})
