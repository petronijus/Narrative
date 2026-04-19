/**
 * SelectionContext.test.tsx
 *
 * Testy pro ephemeral selection state — M7 multi-select API.
 */

import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SelectionProvider, useSelection } from './SelectionContext'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function SelectionReadout() {
  const { selectedId, selectedIds } = useSelection()
  return (
    <div>
      <div data-testid="selected">{selectedId ?? 'none'}</div>
      <div data-testid="count">{selectedIds.size}</div>
      <div data-testid="ids">{[...selectedIds].sort().join(',')}</div>
    </div>
  )
}

function SelectionControls() {
  const { selectOne, selectMany, toggle, clear, setSelectedId, clearSelection } = useSelection()
  return (
    <>
      <button onClick={() => selectOne('obj-1')}>select obj-1</button>
      <button onClick={() => selectOne('obj-2')}>select obj-2</button>
      <button onClick={() => selectMany(['obj-1', 'obj-2'])}>selectMany 1+2</button>
      <button onClick={() => toggle('obj-1')}>toggle obj-1</button>
      <button onClick={() => toggle('obj-2')}>toggle obj-2</button>
      <button onClick={() => clear()}>clear</button>
      {/* Backward-compat */}
      <button onClick={() => setSelectedId('obj-1')}>setSelectedId obj-1</button>
      <button onClick={() => clearSelection()}>clearSelection</button>
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SelectionContext — basic', () => {
  it('starts with no selection', () => {
    render(<TestApp />)
    expect(screen.getByTestId('selected').textContent).toBe('none')
    expect(screen.getByTestId('count').textContent).toBe('0')
  })

  it('selectOne sets single selection', () => {
    render(<TestApp />)
    act(() => {
      screen.getByText('select obj-1').click()
    })
    expect(screen.getByTestId('selected').textContent).toBe('obj-1')
    expect(screen.getByTestId('count').textContent).toBe('1')
  })

  it('clear resets to empty', () => {
    render(<TestApp />)
    act(() => screen.getByText('select obj-1').click())
    act(() => screen.getByText('clear').click())
    expect(screen.getByTestId('selected').textContent).toBe('none')
    expect(screen.getByTestId('count').textContent).toBe('0')
  })

  it('throws outside provider', () => {
    const originalError = console.error
    console.error = () => {}
    expect(() => render(<SelectionReadout />)).toThrow(
      'useSelection must be used within SelectionProvider',
    )
    console.error = originalError
  })
})

describe('SelectionContext — multi-select', () => {
  it('selectMany sets multiple IDs', () => {
    render(<TestApp />)
    act(() => screen.getByText('selectMany 1+2').click())
    expect(screen.getByTestId('count').textContent).toBe('2')
    expect(screen.getByTestId('ids').textContent).toBe('obj-1,obj-2')
  })

  it('selectedId is null when >1 selected', () => {
    render(<TestApp />)
    act(() => screen.getByText('selectMany 1+2').click())
    expect(screen.getByTestId('selected').textContent).toBe('none')
  })

  it('selectOne replaces multi-select', () => {
    render(<TestApp />)
    act(() => screen.getByText('selectMany 1+2').click())
    act(() => screen.getByText('select obj-2').click())
    expect(screen.getByTestId('count').textContent).toBe('1')
    expect(screen.getByTestId('selected').textContent).toBe('obj-2')
  })
})

describe('SelectionContext — toggle', () => {
  it('toggle adds object when not selected', () => {
    render(<TestApp />)
    act(() => screen.getByText('toggle obj-1').click())
    expect(screen.getByTestId('ids').textContent).toBe('obj-1')
    expect(screen.getByTestId('count').textContent).toBe('1')
  })

  it('toggle removes object when already selected', () => {
    render(<TestApp />)
    act(() => screen.getByText('toggle obj-1').click())
    act(() => screen.getByText('toggle obj-1').click())
    expect(screen.getByTestId('count').textContent).toBe('0')
  })

  it('toggle adds to existing multi-select', () => {
    render(<TestApp />)
    act(() => screen.getByText('select obj-1').click())
    act(() => screen.getByText('toggle obj-2').click())
    expect(screen.getByTestId('count').textContent).toBe('2')
    expect(screen.getByTestId('ids').textContent).toBe('obj-1,obj-2')
  })

  it('toggle removes one from multi-select', () => {
    render(<TestApp />)
    act(() => screen.getByText('selectMany 1+2').click())
    act(() => screen.getByText('toggle obj-1').click())
    expect(screen.getByTestId('count').textContent).toBe('1')
    expect(screen.getByTestId('selected').textContent).toBe('obj-2')
  })
})

describe('SelectionContext — backward compat', () => {
  it('setSelectedId alias works', () => {
    render(<TestApp />)
    act(() => screen.getByText('setSelectedId obj-1').click())
    expect(screen.getByTestId('selected').textContent).toBe('obj-1')
  })

  it('clearSelection alias works', () => {
    render(<TestApp />)
    act(() => screen.getByText('select obj-1').click())
    act(() => screen.getByText('clearSelection').click())
    expect(screen.getByTestId('selected').textContent).toBe('none')
  })
})
