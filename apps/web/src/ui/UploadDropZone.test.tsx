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
import { screen, fireEvent, act } from '@testing-library/react'
import { renderWithProviders as render } from '../test/renderWithProviders'
import { useRef } from 'react'
import { UploadDropZone } from './UploadDropZone'
import type { MediaUploadContextValue, UploadEntry } from '../state/useMediaUpload'
import type { DeckRole } from '../state/DeckRoleContext'
import { createSlideDoc, getSlideObjectsCtx, yMapToPlainObject } from '@narrative/slide-model'
import { createMockSlideDocValue } from '../state/slideDocContext'

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

// The component reads the active slide itself (to address commands); the
// tests mock the slide's objects, so they supply the slide id too.
let mockActiveSlideId = 'slide-1'
vi.mock('../state/ActiveSlideContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/ActiveSlideContext.js')>()),
  useActiveSlide: () => ({ activeSlideId: mockActiveSlideId, setActiveSlideId: vi.fn() }),
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
    // A real DataTransfer always exposes getData; onDrop reads the
    // component-drag MIME via it. These are file drops, so return '' —
    // omitting it made `getData is not a function` throw inside event
    // dispatch and trip vitest's exit code (all assertions still passed).
    getData: (_type: string) => '',
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
  mockActiveSlideId = 'slide-1'
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

  it('a dropped image lands on the slide under the cursor, at any zoom', () => {
    const { doc, slides } = createSlideDoc()
    const deckCtx = { doc, slides }
    mockActiveSlideId = slides.get(0).get('id') as string
    // The artboard at 50%: its visual rect is half the slide, offset in the page.
    window.sessionStorage.setItem('narrative:zoom-level', '0.5')
    try {
      const { container } = render(<Wrapper />, {
        slideDocValue: createMockSlideDocValue({ deckCtx }),
      })
      const artboard = container.firstElementChild as HTMLElement
      artboard.getBoundingClientRect = () => new DOMRect(100, 50, 960, 540)
      const zone = container.querySelector('[aria-hidden="true"]') as HTMLElement

      // jsdom has no DragEvent, and fireEvent.drop drops clientX/Y: a mouse
      // event of type 'drop' carries the position, the files ride along.
      const drop = new MouseEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: 100 + 300,
        clientY: 50 + 200,
      })
      Object.defineProperty(drop, 'dataTransfer', {
        value: makeDataTransfer([makeImageFile()]),
      })
      act(() => {
        zone.dispatchEvent(drop)
      })
      const onDone = mockStartUpload.mock.calls[0]?.[1]?.onDone as (e: UploadEntry) => void
      act(() => {
        onDone({
          id: 'x',
          filename: 'photo.jpg',
          sizeBytes: 100,
          mimeType: 'image/jpeg',
          status: 'done',
          progress: 1,
          assetId: 'asset-1',
          width: 800,
          height: 600,
        })
      })

      const objects = getSlideObjectsCtx(deckCtx, mockActiveSlideId)!.objects
      expect(objects.toArray().map((o) => yMapToPlainObject(o))).toEqual([
        // 300 × 200 visual px at 50% are 600 × 400 on the slide.
        expect.objectContaining({ type: 'image', assetId: 'asset-1', x: 600, y: 400 }),
      ])
    } finally {
      window.sessionStorage.removeItem('narrative:zoom-level')
    }
  })
})
