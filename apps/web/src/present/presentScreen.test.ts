import { afterEach, describe, expect, it } from 'vitest'
import {
  displayName,
  findChosenDisplay,
  readDisplayChoice,
  writeDisplayChoice,
  type DisplayScreen,
} from './presentScreen'

const screen = (
  label: string,
  left: number,
  extra: Partial<DisplayScreen> = {},
): DisplayScreen => ({
  label,
  left,
  top: 0,
  width: 1920,
  height: 1080,
  isPrimary: false,
  isInternal: false,
  ...extra,
})

afterEach(() => localStorage.clear())

describe('the presentation display', () => {
  it('remembers the chosen display and finds it again', () => {
    const projector = screen('EPSON PJ', 1920)
    writeDisplayChoice(projector)
    expect(readDisplayChoice()).toEqual({ label: 'EPSON PJ', left: 1920, top: 0 })
    expect(findChosenDisplay([screen('Built-in', 0), projector], readDisplayChoice())).toBe(
      projector,
    )
  })

  it('finds a display that moved by its label, and nothing when it is gone', () => {
    writeDisplayChoice(screen('EPSON PJ', 1920))
    const moved = screen('EPSON PJ', -1920)
    expect(findChosenDisplay([screen('Built-in', 0), moved], readDisplayChoice())).toBe(moved)
    expect(findChosenDisplay([screen('Built-in', 0)], readDisplayChoice())).toBeNull()
  })

  it('forgets the choice, and ignores a stored value it cannot read', () => {
    writeDisplayChoice(screen('X', 0))
    writeDisplayChoice(null)
    expect(readDisplayChoice()).toBeNull()
    localStorage.setItem('narrative.present.display', '{"label":3}')
    expect(readDisplayChoice()).toBeNull()
  })

  it('names displays for people', () => {
    expect(
      displayName(screen('DELL U2720Q', 0, { isPrimary: true, width: 3840, height: 2160 })),
    ).toBe('DELL U2720Q (3840 × 2160, primary)')
    expect(displayName(screen('', 1920))).toBe('Display at 1920, 0 (1920 × 1080)')
  })
})
