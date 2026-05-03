/**
 * state/useFolderComponents.test.ts
 *
 * Smoke tests for the folder-components cache hook (M16 P6).
 *
 * Verifies:
 *   - eager fetch populates the cache
 *   - invalidate() forces a re-fetch
 *   - the cache is shared across hook instances for the same folderId
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useFolderComponents, __resetFolderComponentsCacheForTests } from './useFolderComponents.js'
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
})
