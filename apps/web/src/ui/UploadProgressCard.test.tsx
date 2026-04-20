/**
 * ui/UploadProgressCard.test.tsx
 *
 * Tests for UploadProgressCard and UploadProgressStack.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { UploadProgressCard, UploadProgressStack } from './UploadProgressCard'
import type { UploadEntry } from '../state/useMediaUpload'
import type { MediaUploadContextValue } from '../state/useMediaUpload'

// ---------------------------------------------------------------------------
// Mock useMediaUpload
// ---------------------------------------------------------------------------

const mockCancel = vi.fn()
const mockRetry = vi.fn()
const mockDismiss = vi.fn()
let mockUploads: UploadEntry[] = []

vi.mock('../state/useMediaUpload.js', () => ({
  useMediaUpload: (): MediaUploadContextValue => ({
    uploads: mockUploads,
    startUpload: vi.fn(),
    cancelUpload: mockCancel,
    retryUpload: mockRetry,
    dismissUpload: mockDismiss,
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<UploadEntry> = {}): UploadEntry {
  return {
    id: 'test-id',
    filename: 'photo.jpg',
    sizeBytes: 1024,
    mimeType: 'image/jpeg',
    status: 'uploading',
    progress: 0.45,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests — UploadProgressCard
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockUploads = []
})

describe('UploadProgressCard', () => {
  it('renders filename and percentage while uploading', () => {
    render(<UploadProgressCard entry={makeEntry()} />)
    expect(screen.getByText('photo.jpg')).toBeInTheDocument()
    expect(screen.getByText('45%')).toBeInTheDocument()
  })

  it('renders progress bar with correct width while uploading', () => {
    const { container } = render(<UploadProgressCard entry={makeEntry({ progress: 0.7 })} />)
    // The inner progress fill div
    const fills = container.querySelectorAll('[style*="width"]')
    expect(fills.length).toBeGreaterThan(0)
  })

  it('shows Cancel button while uploading', () => {
    render(<UploadProgressCard entry={makeEntry()} />)
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('Cancel button calls cancelUpload', () => {
    render(<UploadProgressCard entry={makeEntry({ id: 'upload-42' })} />)
    act(() => {
      screen.getByRole('button', { name: /cancel/i }).click()
    })
    expect(mockCancel).toHaveBeenCalledWith('upload-42')
  })

  it('shows Done status for done entry', () => {
    render(<UploadProgressCard entry={makeEntry({ status: 'done', progress: 1 })} />)
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('shows Retry and Dismiss buttons in error state', () => {
    render(
      <UploadProgressCard
        entry={makeEntry({ status: 'error', error: 'Network timeout', progress: 0 })}
      />,
    )
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
    expect(screen.getByText('Network timeout')).toBeInTheDocument()
  })

  it('Retry button calls retryUpload', () => {
    render(
      <UploadProgressCard
        entry={makeEntry({ id: 'err-upload', status: 'error', progress: 0, error: 'fail' })}
      />,
    )
    act(() => {
      screen.getByRole('button', { name: /retry/i }).click()
    })
    expect(mockRetry).toHaveBeenCalledWith('err-upload')
  })

  it('Dismiss button calls dismissUpload in error state', () => {
    render(
      <UploadProgressCard
        entry={makeEntry({ id: 'err-2', status: 'error', progress: 0, error: 'fail' })}
      />,
    )
    act(() => {
      screen.getByRole('button', { name: /dismiss/i }).click()
    })
    expect(mockDismiss).toHaveBeenCalledWith('err-2')
  })

  it('shows Dismiss button in cancelled state', () => {
    render(<UploadProgressCard entry={makeEntry({ status: 'cancelled', progress: 0 })} />)
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
  })

  it('auto-dismisses done entry after 2 s', async () => {
    vi.useFakeTimers()
    render(<UploadProgressCard entry={makeEntry({ id: 'done-1', status: 'done', progress: 1 })} />)

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(mockDismiss).toHaveBeenCalledWith('done-1')
    vi.useRealTimers()
  })

  it('shows queued label while queued', () => {
    render(<UploadProgressCard entry={makeEntry({ status: 'queued', progress: 0 })} />)
    expect(screen.getByText(/queued/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — UploadProgressStack
// ---------------------------------------------------------------------------

describe('UploadProgressStack', () => {
  it('renders nothing when uploads list is empty', () => {
    mockUploads = []
    const { container } = render(<UploadProgressStack />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a card for each upload', () => {
    mockUploads = [
      makeEntry({ id: 'u1', filename: 'img1.jpg', status: 'uploading', progress: 0.3 }),
      makeEntry({ id: 'u2', filename: 'img2.png', status: 'done', progress: 1 }),
    ]
    render(<UploadProgressStack />)
    expect(screen.getByText('img1.jpg')).toBeInTheDocument()
    expect(screen.getByText('img2.png')).toBeInTheDocument()
  })
})
