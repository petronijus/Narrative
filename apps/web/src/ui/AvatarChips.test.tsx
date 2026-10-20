/**
 * ui/AvatarChips.test.tsx
 *
 * Testy pro AvatarChips komponentu.
 *
 * Strategie: mock useAwareness hook — různé scénáře počtu peerů.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act } from '@testing-library/react'
import { renderWithProviders as render } from '../test/renderWithProviders'
import { AvatarChips } from './AvatarChips'
import type { PeerInfo } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Mock useAwareness
// ---------------------------------------------------------------------------

const mockAwarenessData = {
  peers: [] as PeerInfo[],
  remotePeers: [] as PeerInfo[],
  localClientId: 1,
}

vi.mock('../state/useAwareness.js', () => ({
  useAwareness: () => mockAwarenessData,
  usePresencePeers: () => mockAwarenessData,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePeer(clientId: number, name: string, color: string, isLocal = false): PeerInfo {
  return {
    clientId,
    isLocal,
    state: {
      user: { id: `user-${clientId}`, name, color },
      selectedObjectIds: [],
      cursor: null,
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockAwarenessData.peers = []
  mockAwarenessData.remotePeers = []
  mockAwarenessData.localClientId = 1
})

describe('AvatarChips', () => {
  it('renders nothing when no peers', () => {
    const { container } = render(<AvatarChips />)
    expect(container.firstChild).toBeNull()
  })

  it('renders single local peer chip', () => {
    const local = makePeer(1, 'Alice', 'hsl(142, 70%, 55%)', true)
    mockAwarenessData.peers = [local]
    mockAwarenessData.localClientId = 1

    render(<AvatarChips />)
    // Chip má aria-label s "(you)" pro lokálního peera
    const chip = screen.getByRole('list')
    expect(chip).toBeInTheDocument()
    expect(screen.getByLabelText('Alice (you)')).toBeInTheDocument()
  })

  it('renders N chips for N peers (N <= 5)', () => {
    const peers = [
      makePeer(1, 'Alice', 'hsl(0, 70%, 55%)', true),
      makePeer(2, 'Bob', 'hsl(60, 70%, 55%)'),
      makePeer(3, 'Carol', 'hsl(120, 70%, 55%)'),
    ]
    mockAwarenessData.peers = peers
    mockAwarenessData.localClientId = 1

    render(<AvatarChips />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
  })

  it('shows "+N" chip when more than 5 peers', () => {
    const peers = [
      makePeer(1, 'Alice', 'hsl(0, 70%, 55%)', true),
      makePeer(2, 'Bob', 'hsl(30, 70%, 55%)'),
      makePeer(3, 'Carol', 'hsl(60, 70%, 55%)'),
      makePeer(4, 'Dave', 'hsl(90, 70%, 55%)'),
      makePeer(5, 'Eve', 'hsl(120, 70%, 55%)'),
      makePeer(6, 'Frank', 'hsl(150, 70%, 55%)'),
      makePeer(7, 'Grace', 'hsl(180, 70%, 55%)'),
    ]
    mockAwarenessData.peers = peers
    mockAwarenessData.localClientId = 1

    render(<AvatarChips />)
    // 5 visible + 1 overflow chip = 6 listitem
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(6)

    // Overflow button shows "+2" (7 - 5 = 2)
    const overflowBtn = screen.getByRole('button', { name: /2 more collaborators/i })
    expect(overflowBtn).toBeInTheDocument()
    expect(overflowBtn.textContent).toBe('+2')
  })

  it('overflow popover opens on click and shows hidden peer names', () => {
    const peers = [
      makePeer(1, 'Alice', 'hsl(0, 70%, 55%)', true),
      makePeer(2, 'Bob', 'hsl(30, 70%, 55%)'),
      makePeer(3, 'Carol', 'hsl(60, 70%, 55%)'),
      makePeer(4, 'Dave', 'hsl(90, 70%, 55%)'),
      makePeer(5, 'Eve', 'hsl(120, 70%, 55%)'),
      makePeer(6, 'Frank', 'hsl(150, 70%, 55%)'),
    ]
    mockAwarenessData.peers = peers
    mockAwarenessData.localClientId = 1

    render(<AvatarChips />)

    // Popover ještě není viditelný
    expect(screen.queryByRole('listbox')).toBeNull()

    // Klik na overflow button
    const overflowBtn = screen.getByRole('button', { name: /1 more collaborators/i })
    act(() => {
      overflowBtn.click()
    })

    // Popover se otevřel
    const popover = screen.getByRole('listbox')
    expect(popover).toBeInTheDocument()
    expect(popover).toHaveTextContent('Frank')
  })

  it('local peer chip has "(you)" in label', () => {
    const peers = [
      makePeer(1, 'Alice', 'hsl(0, 70%, 55%)', true),
      makePeer(2, 'Bob', 'hsl(30, 70%, 55%)'),
    ]
    mockAwarenessData.peers = peers
    mockAwarenessData.localClientId = 1

    render(<AvatarChips />)
    expect(screen.getByLabelText('Alice (you)')).toBeInTheDocument()
    expect(screen.getByLabelText('Bob')).toBeInTheDocument()
  })

  it('renders initials from name', () => {
    const peers = [makePeer(2, 'Bob Smith', 'hsl(30, 70%, 55%)')]
    mockAwarenessData.peers = peers
    mockAwarenessData.localClientId = 1

    render(<AvatarChips />)
    // "Bob Smith" → "BS"
    expect(screen.getByLabelText('Bob Smith').textContent).toBe('BS')
  })

  it('renders initials for single-word name', () => {
    const peers = [makePeer(2, 'Alice', 'hsl(0, 70%, 55%)')]
    mockAwarenessData.peers = peers
    mockAwarenessData.localClientId = 1

    render(<AvatarChips />)
    // "Alice" → "AL"
    expect(screen.getByLabelText('Alice').textContent).toBe('AL')
  })
})
