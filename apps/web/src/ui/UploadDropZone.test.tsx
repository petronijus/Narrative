/**
 * ui/UploadDropZone.test.tsx
 *
 * Tests for the UploadDropZone component.
 *
 * Strategy:
 *   - Mock useMediaUpload, useDeckRole, useSlideObjects.
 *   - Simulate drag events with DataTransfer items.
 *   - Assert overlay visibility + startUpload calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useRef } from 'react'
import { UploadDropZone } from './UploadDropZone'
import type { MediaUploadContextValue, UploadEntry } from '../state/useMediaUpload'
import type { DeckRole } from '../state/DeckRoleContext'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStartUpload = vi.fn()
let mockRole: DeckRole = 'editor'

vi.mock('../state/useMediaUpload.js', () => ({
  useMediaUpload: (): Partial<MediaUploadContextValue> => ({
    startUpload: mockStartUpload,
    uploads: [],
  }),
}))

vi.mock('../state/DeckRoleContext.js', () => ({
  useDeckRole: () => ({ role: mockRole }),
}))

vi.mock('../state/useSlideObjects.js', () => ({
  useSlideObjects: () => ({ objectsCtx: null, objects: [] }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDataTransfer(files: File[]): Partial<DataTransfer> {
  const items = files.map((f) => ({
    kind: 'file',
    type: f.type,
    getAsFile: () => f,
  }))
  return {
    items: items as unknown as DataTransferItemList,
    files: files as unknown as FileList,
    dropEffect: 'none' as DataTransfer['dropEffect'],
  }
}

function makeImageFile(name = 'photo.jpg', type = 'image/jpeg'): File {
  return new File(['x'], name, { type })
}

function makeTextFile(): File {
  return new File(['hello'], 'doc.txt', { type: 'text/plain' })
}

/**
 * Wrapper that provides a stable canvasContainerRef
 */
function Wrapper({ role = 'editor' as DeckRole }: { role?: DeckRole } = {}) {
  mockRole = role
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} style={{ width: 800, height: 600 }}>
      <UploadDropZone canvasContainerRef={ref} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockRole = 'editor'
})

describe('UploadDropZone', () => {
  it('shows drop overlay on dragenter with image files', () => {
    const { container } = render(<Wrapper />)
    const zone = container.querySelector('[aria-hidden="true"]') as HTMLElement

    act(() => {
      fireEvent.dragEnter(zone, {
        dataTransfer: makeDataTransfer([makeImageFile()]),
      })
    })

    expect(screen.getByText('Drop image here')).toBeInTheDocument()
  })

  it('hides drop overlay after dragleave', () => {
    const { container } = render(<Wrapper />)
    const zone = container.querySelector('[aria-hidden="true"]') as HTMLElement

    act(() => {
      fireEvent.dragEnter(zone, {
        dataTransfer: makeDataTransfer([makeImageFile()]),
      })
    })

    expect(screen.getByText('Drop image here')).toBeInTheDocument()

    act(() => {
      fireEvent.dragLeave(zone, {
        dataTransfer: makeDataTransfer([makeImageFile()]),
      })
    })

    expect(screen.queryByText('Drop image here')).not.toBeInTheDocument()
  })

  it('calls startUpload for each image file on drop', () => {
    const { container } = render(<Wrapper />)
    const zone = container.querySelector('[aria-hidden="true"]') as HTMLElement

    const files = [makeImageFile('a.jpg'), makeImageFile('b.png', 'image/png')]

    act(() => {
      fireEvent.drop(zone, {
        dataTransfer: makeDataTransfer(files),
      })
    })

    expect(mockStartUpload).toHaveBeenCalledTimes(2)
    expect(mockStartUpload).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'a.jpg' }),
      expect.objectContaining({ onDone: expect.any(Function) }),
    )
    expect(mockStartUpload).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'b.png' }),
      expect.objectContaining({ onDone: expect.any(Function) }),
    )
  })

  it('silently filters non-image files on drop', () => {
    const { container } = render(<Wrapper />)
    const zone = container.querySelector('[aria-hidden="true"]') as HTMLElement

    act(() => {
      fireEvent.drop(zone, {
        dataTransfer: makeDataTransfer([makeTextFile()]),
      })
    })

    expect(mockStartUpload).not.toHaveBeenCalled()
  })

  it('mixes image and non-image files — only images uploaded', () => {
    const { container } = render(<Wrapper />)
    const zone = container.querySelector('[aria-hidden="true"]') as HTMLElement

    act(() => {
      fireEvent.drop(zone, {
        dataTransfer: makeDataTransfer([makeImageFile('img.jpg'), makeTextFile()]),
      })
    })

    expect(mockStartUpload).toHaveBeenCalledTimes(1)
    expect(mockStartUpload).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'img.jpg' }),
      expect.any(Object),
    )
  })

  it('hides overlay and does not respond to drag for viewer role', () => {
    const { container } = render(<Wrapper role="viewer" />)
    const zone = container.querySelector('[aria-hidden="true"]') as HTMLElement

    // For viewer the zone is pointer-events-none, dragenter should be harmless
    act(() => {
      fireEvent.dragEnter(zone, {
        dataTransfer: makeDataTransfer([makeImageFile()]),
      })
    })

    // No "Drop image here" label should appear
    expect(screen.queryByText('Drop image here')).not.toBeInTheDocument()
    expect(mockStartUpload).not.toHaveBeenCalled()
  })

  it('onDone callback creates ImageObject when objectsCtx would be available', () => {
    // This test verifies the callback is wired — createObjectOfType would be called
    // but objectsCtx is null in this test (mocked), so it's a safe no-op.
    // The contract is that startUpload is called with an onDone option.
    const { container } = render(<Wrapper />)
    const zone = container.querySelector('[aria-hidden="true"]') as HTMLElement

    act(() => {
      fireEvent.drop(zone, {
        dataTransfer: makeDataTransfer([makeImageFile()]),
      })
    })

    expect(mockStartUpload).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ onDone: expect.any(Function) }),
    )

    // Simulate calling onDone — with null objectsCtx it should be a no-op (no throw)
    const onDone = mockStartUpload.mock.calls[0]?.[1]?.onDone as
      | ((e: UploadEntry) => void)
      | undefined
    expect(() =>
      onDone?.({
        id: 'x',
        filename: 'photo.jpg',
        sizeBytes: 100,
        status: 'done',
        progress: 1,
        assetId: 'asset-1',
        width: 800,
        height: 600,
      }),
    ).not.toThrow()
  })
})
