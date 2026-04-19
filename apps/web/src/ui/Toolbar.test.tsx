/**
 * Toolbar.test.tsx
 *
 * - Klik na tlačítko přepíná tool.
 * - Keyboard shortcut (V/R/O/T) přepíná tool.
 */

import { describe, it, expect } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { Toolbar } from './Toolbar'
import { ToolProvider, useTool } from '../state/ToolContext'
import type { ActiveTool } from '../state/ToolContext'

function ToolReadout() {
  const { activeTool } = useTool()
  return <div data-testid="active-tool">{activeTool}</div>
}

function TestApp() {
  return (
    <ToolProvider>
      <Toolbar />
      <ToolReadout />
    </ToolProvider>
  )
}

describe('Toolbar', () => {
  it('renders all tool buttons', () => {
    render(<TestApp />)
    expect(screen.getByRole('button', { name: /select/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /rectangle/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ellipse/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /text/i })).toBeInTheDocument()
  })

  it('default tool is select', () => {
    render(<TestApp />)
    expect(screen.getByTestId('active-tool').textContent).toBe('select')
    expect(screen.getByRole('button', { name: /select/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking Rectangle switches to rectangle tool', () => {
    render(<TestApp />)
    act(() => {
      screen.getByRole('button', { name: /rectangle/i }).click()
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('rectangle')
    expect(screen.getByRole('button', { name: /rectangle/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: /select/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking Ellipse switches to ellipse tool', () => {
    render(<TestApp />)
    act(() => {
      screen.getByRole('button', { name: /ellipse/i }).click()
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('ellipse')
  })

  it('clicking Text switches to text tool', () => {
    render(<TestApp />)
    act(() => {
      screen.getByRole('button', { name: /text/i }).click()
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('text')
  })

  it('keyboard shortcut R switches to rectangle', () => {
    render(<TestApp />)
    act(() => {
      fireEvent.keyDown(window, { key: 'r' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('rectangle')
  })

  it('keyboard shortcut O switches to ellipse', () => {
    render(<TestApp />)
    act(() => {
      fireEvent.keyDown(window, { key: 'o' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('ellipse')
  })

  it('keyboard shortcut T switches to text', () => {
    render(<TestApp />)
    act(() => {
      fireEvent.keyDown(window, { key: 't' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('text')
  })

  it('keyboard shortcut V switches back to select', () => {
    render(<TestApp />)
    // Nejdříve přepneme na rectangle
    act(() => {
      fireEvent.keyDown(window, { key: 'r' })
    })
    // Pak zpět na select
    act(() => {
      fireEvent.keyDown(window, { key: 'v' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('select')
  })

  it('keyboard shortcuts are ignored when input is focused', () => {
    render(
      <ToolProvider>
        <Toolbar />
        <ToolReadout />
        <input data-testid="text-input" />
      </ToolProvider>,
    )

    // Focus input
    const input = screen.getByTestId('text-input')
    act(() => {
      input.focus()
    })

    // Stiskneme 'r' ale fokus je na inputu — tool se nemění
    act(() => {
      fireEvent.keyDown(input, { key: 'r' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('select')
  })

  it('uppercase keyboard shortcuts also work', () => {
    render(<TestApp />)
    act(() => {
      fireEvent.keyDown(window, { key: 'R' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('rectangle')
  })
})

describe('ToolContext', () => {
  it('throws outside provider', () => {
    const originalError = console.error
    console.error = () => {}
    expect(() => render(<ToolReadout />)).toThrow('useTool must be used within ToolProvider')
    console.error = originalError
  })

  it('setActiveTool changes the active tool', () => {
    function Setter({ tool }: { tool: ActiveTool }) {
      const { setActiveTool } = useTool()
      return <button onClick={() => setActiveTool(tool)}>set {tool}</button>
    }

    render(
      <ToolProvider>
        <Setter tool="ellipse" />
        <ToolReadout />
      </ToolProvider>,
    )

    act(() => {
      screen.getByText('set ellipse').click()
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('ellipse')
  })
})
