// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { cutSelection, type CutDeps } from './cutSelection.js'

function deps(copied = true) {
  return {
    copy: vi.fn<CutDeps['copy']>(() => copied),
    remove: vi.fn<CutDeps['remove']>(),
    clear: vi.fn<CutDeps['clear']>(),
  }
}

describe('cutSelection', () => {
  it('copies every target as a cut and deletes the unlocked ones', () => {
    const d = deps()
    const cut = cutSelection(
      [{ id: 'a' }, { id: 'b', locked: true }, { id: 'c', locked: false }],
      d,
    )
    expect(cut).toBe(true)
    expect(d.copy).toHaveBeenCalledWith(['a', 'b', 'c'], { cut: true })
    expect(d.remove).toHaveBeenCalledWith(['a', 'c'])
    expect(d.clear).toHaveBeenCalledOnce()
  })

  it('deletes nothing when every target is locked, but still copies them', () => {
    const d = deps()
    expect(cutSelection([{ id: 'a', locked: true }], d)).toBe(true)
    expect(d.remove).not.toHaveBeenCalled()
  })

  it('deletes nothing when the copy failed, and nothing at all without targets', () => {
    const failed = deps(false)
    expect(cutSelection([{ id: 'a' }], failed)).toBe(false)
    expect(failed.remove).not.toHaveBeenCalled()
    expect(failed.clear).not.toHaveBeenCalled()
    const empty = deps()
    expect(cutSelection([], empty)).toBe(false)
    expect(empty.copy).not.toHaveBeenCalled()
  })
})
