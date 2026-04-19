/**
 * SelectionContext.test.tsx
 *
 * Testy pro ephemeral selection state.
 */

import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SelectionProvider, useSelection } from './SelectionContext'

function SelectionReadout() {
  const { selectedId } = useSelection()
  return <div data-testid="selected">{selectedId ?? 'none'}</div>
}

function SelectionControls() {
  const { setSelectedId, clearSelection } = useSelection()
  return (
    <>
      <button onClick={() => setSelectedId('obj-1')}>select obj-1</button>
      <button onClick={() => clearSelection()}>clear</button>
    </>
  )
}

function TestApp() {
  return (
    <SelectionProvider>
      <SelectionReadout />
      <SelectionControls />
    </SelectionProvider>
  )
}

describe('SelectionContext', () => {
  it('starts with no selection', () => {
    render(<TestApp />)
    expect(screen.getByTestId('selected').textContent).toBe('none')
  })

  it('setSelectedId updates selectedId', () => {
    render(<TestApp />)
    act(() => {
      screen.getByText('select obj-1').click()
    })
    expect(screen.getByTestId('selected').textContent).toBe('obj-1')
  })

  it('clearSelection resets to null', () => {
    render(<TestApp />)
    act(() => {
      screen.getByText('select obj-1').click()
    })
    act(() => {
      screen.getByText('clear').click()
    })
    expect(screen.getByTestId('selected').textContent).toBe('none')
  })

  it('throws outside provider', () => {
    // Potlačíme console.error pro tento test
    const originalError = console.error
    console.error = () => {}
    expect(() => render(<SelectionReadout />)).toThrow(
      'useSelection must be used within SelectionProvider',
    )
    console.error = originalError
  })
})
