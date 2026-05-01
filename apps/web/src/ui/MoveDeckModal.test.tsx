/**
 * ui/MoveDeckModal.test.tsx
 *
 * M16 P1 — RTL tests for the deck-move folder picker modal.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MoveDeckModal } from './MoveDeckModal'
import type { FolderSummary } from '../api/client'

const FOLDERS: FolderSummary[] = [
  { id: 'folder-drafts', name: 'Drafts', deckCount: 3, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'folder-work', name: 'Work', deckCount: 5, createdAt: '2026-01-02T00:00:00Z' },
  { id: 'folder-personal', name: 'Personal', deckCount: 1, createdAt: '2026-01-03T00:00:00Z' },
]

function renderModal({
  deckIds = ['deck-1'],
  currentFolderId = 'folder-work',
  folders = FOLDERS,
  onConfirm = vi.fn(),
  onClose = vi.fn(),
} = {}) {
  return render(
    <MoveDeckModal
      deckIds={deckIds}
      currentFolderId={currentFolderId}
      folders={folders}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  )
}

describe('MoveDeckModal', () => {
  it('renders the dialog with the correct heading', () => {
    renderModal()
    expect(screen.getByRole('dialog', { name: /move deck to folder/i })).toBeTruthy()
    expect(screen.getByText(/move deck to/i)).toBeTruthy()
  })

  it('shows plural heading for multiple decks', () => {
    renderModal({ deckIds: ['deck-1', 'deck-2', 'deck-3'] })
    expect(screen.getByText(/move 3 decks to/i)).toBeTruthy()
  })

  it('excludes the current folder from the list', () => {
    renderModal({ currentFolderId: 'folder-work' })
    // Only Drafts and Personal should be visible
    expect(screen.getByText('Drafts')).toBeTruthy()
    expect(screen.getByText('Personal')).toBeTruthy()
    // Work is the current folder — should not appear
    const items = screen.getAllByRole('option')
    const names = items.map((el) => el.textContent)
    expect(names.some((n) => n?.includes('Work'))).toBe(false)
  })

  it('shows deck counts next to each folder', () => {
    renderModal({ currentFolderId: 'folder-work' })
    // Drafts has 3, Personal has 1
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('pre-selects the first available folder', () => {
    renderModal({ currentFolderId: 'folder-work' })
    // Drafts is the first after Work is excluded
    const draftsOption = screen.getByRole('option', { name: /Drafts/i })
    expect(draftsOption.getAttribute('aria-selected')).toBe('true')
  })

  it('changes selection when another folder is clicked', () => {
    renderModal({ currentFolderId: 'folder-work' })
    const personalOption = screen.getByRole('option', { name: /Personal/i })
    fireEvent.click(personalOption)
    expect(personalOption.getAttribute('aria-selected')).toBe('true')
  })

  it('calls onConfirm with selected folder id when Move here is clicked', () => {
    const onConfirm = vi.fn()
    renderModal({ onConfirm, currentFolderId: 'folder-work' })
    // Drafts is pre-selected
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }))
    expect(onConfirm).toHaveBeenCalledWith('folder-drafts')
  })

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows "no other folders" message when only current folder exists', () => {
    renderModal({ currentFolderId: 'folder-work', folders: [FOLDERS[1]!] })
    expect(screen.getByText(/no other folders available/i)).toBeTruthy()
  })

  it('disables Move here button when no targets exist', () => {
    renderModal({ currentFolderId: 'folder-work', folders: [FOLDERS[1]!] })
    const moveBtn = screen.getByRole('button', { name: 'Move here' })
    expect(moveBtn).toHaveProperty('disabled', true)
  })
})
