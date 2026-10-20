/**
 * state/useFolderComponents.test.ts
 *
 * Smoke tests for the folder-components cache hook (M16 P6).
 *
 * Verifies:
 *   - eager fetch populates the cache
 *   - invalidate() forces a re-fetch
 *   - the cache is shared across hook instances for the same folderId
 *   - an out-of-band invalidation (promote, thumbnail upload, delete)
 *     re-fetches for mounted views, and a response it overtook is not kept
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import {
  useFolderComponents,
  invalidateFolderComponentsCache,
  __resetFolderComponentsCacheForTests,
} from './useFolderComponents.js'
import type { ComponentSummary } from '../api/client.js'

// Mock useApi
let listComponentsMock: ReturnType<typeof vi.fn>
vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../api/client.js')>('../api/client.js')
  return {
    ...actual,
    useApi: () => ({
      listComponents: listComponentsMock,
    }),
  }
})

const promoted: ComponentSummary[] = [
  { id: 'c1', folderId: 'f1', name: 'One', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  {
    id: 'c2',
    folderId: 'f1',
    name: 'Red square',
    createdAt: '2026-01-02',
    updatedAt: '2026-01-02',
  },
]

const sample: ComponentSummary[] = [
  {
    id: 'c1',
    folderId: 'f1',
    name: 'One',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
]

beforeEach(() => {
  __resetFolderComponentsCacheForTests()
  listComponentsMock = vi.fn().mockResolvedValue(sample)
})

describe('useFolderComponents', () => {
  it('eager fetch populates components', async () => {
    const { result } = renderHook(() => useFolderComponents('f1', { eager: true }), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    })
    await waitFor(() => expect(result.current.components).not.toBeNull())
    expect(result.current.components).toEqual(sample)
    expect(listComponentsMock).toHaveBeenCalledTimes(1)
  })

  it('invalidate() re-fetches', async () => {
    const { result } = renderHook(() => useFolderComponents('f1', { eager: true }), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    })
    await waitFor(() => expect(result.current.components).not.toBeNull())
    await act(async () => {
      await result.current.invalidate()
    })
    expect(listComponentsMock).toHaveBeenCalledTimes(2)
  })

  it('returns null components for null folderId', () => {
    const { result } = renderHook(() => useFolderComponents(null, { eager: true }), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    })
    expect(result.current.components).toBeNull()
    expect(listComponentsMock).not.toHaveBeenCalled()
  })

  it('an out-of-band invalidation re-fetches for a mounted view and keeps the old list meanwhile', async () => {
    const { result } = renderHook(() => useFolderComponents('f1', { eager: true }), {
      wrapper,
    })
    await waitFor(() => expect(result.current.components).toEqual(sample))

    const next = deferred<ComponentSummary[]>()
    listComponentsMock.mockReturnValueOnce(next.promise)
    act(() => invalidateFolderComponentsCache('f1'))
    expect(listComponentsMock).toHaveBeenCalledTimes(2)
    expect(result.current.components).toEqual(sample)

    await act(async () => next.resolve(promoted))
    expect(result.current.components).toEqual(promoted)
    expect(result.current.loading).toBe(false)
  })

  it('a list fetched before an invalidation is fetched again instead of kept', async () => {
    // The picker opens (fetch 1, answered with the list before a promote's
    // thumbnail upload); the upload's invalidation lands while it is in
    // flight. Fetch 1's answer is stale, so the cache asks again.
    listComponentsMock.mockReset()
    const first = deferred<ComponentSummary[]>()
    listComponentsMock.mockReturnValueOnce(first.promise).mockResolvedValue(promoted)
    const { result } = renderHook(() => useFolderComponents('f1', { eager: true }), {
      wrapper,
    })
    await waitFor(() => expect(listComponentsMock).toHaveBeenCalledTimes(1))

    act(() => invalidateFolderComponentsCache('f1'))
    await act(async () => first.resolve(sample))

    await waitFor(() => expect(result.current.components).toEqual(promoted))
    expect(listComponentsMock).toHaveBeenCalledTimes(2)
    expect(result.current.loading).toBe(false)
  })

  it('with nothing mounted, an invalidation drops the list and the next mount fetches it', async () => {
    const first = renderHook(() => useFolderComponents('f1', { eager: true }), { wrapper })
    await waitFor(() => expect(first.result.current.components).toEqual(sample))
    first.unmount()

    invalidateFolderComponentsCache('f1')
    expect(listComponentsMock).toHaveBeenCalledTimes(1)

    listComponentsMock.mockResolvedValue(promoted)
    const second = renderHook(() => useFolderComponents('f1', { eager: true }), { wrapper })
    await waitFor(() => expect(second.result.current.components).toEqual(promoted))
    expect(listComponentsMock).toHaveBeenCalledTimes(2)
  })
})

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
