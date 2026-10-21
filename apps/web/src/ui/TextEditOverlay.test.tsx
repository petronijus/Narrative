/**
 * ui/TextEditOverlay.test.tsx — the inline editor shows the body as the
 * document has it, whenever a change lands: between building its HTML and
 * subscribing (a peer's edit, the sync of a deck painted from its local
 * copy, ADR 0017), and when the object's Y.Text is replaced.
 */

import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import * as Y from 'yjs'
import type { TextObject } from '@narrative/shared'
import { TextEditProvider } from '../state/TextEditContext.js'
import { TextEditOverlay } from './TextEditOverlay.js'

vi.mock('../state/useCommand.js', () => ({
  useCommand: () => ({ run: vi.fn(), tryRun: vi.fn() }),
}))

/** A body in a document (a Y.Text reads its content once integrated). */
function bodyOf(doc: Y.Doc, key: string, text: string): Y.Text {
  const yText = new Y.Text(text)
  doc.getMap('bodies').set(key, yText)
  return yText
}

function textObject(text: Y.Text): TextObject {
  return {
    id: 'text-1',
    type: 'text',
    x: 0,
    y: 0,
    width: 240,
    height: 40,
    text,
    fontSize: 24,
    fontWeight: 'normal',
    color: 0x000000,
    align: 'left',
    rotation: 0,
    opacity: 1,
  } as TextObject
}

const TARGET = { slide: 'slide-1', object: 'text-1' }

function editorText(container: HTMLElement): string {
  return container.querySelector('[contenteditable="true"]')?.textContent ?? ''
}

describe('TextEditOverlay', () => {
  it('shows an edit that lands after it built its HTML and before its passive effects', () => {
    const doc = new Y.Doc()
    const yText = bodyOf(doc, 'a', 'Old')
    /** A layout effect after the overlay's: the commit's layout phase, before any passive effect. */
    function EditInLayoutPhase() {
      useLayoutEffect(() => {
        yText.insert(yText.length, ' and new')
      }, [])
      return null
    }
    const { container } = render(
      <TextEditProvider>
        <TextEditOverlay obj={textObject(yText)} target={TARGET} onEnd={() => undefined} />
        <EditInLayoutPhase />
      </TextEditProvider>,
    )
    expect(editorText(container)).toBe('Old and new')
  })

  it('shows the new body when the object’s Y.Text is replaced', () => {
    const doc = new Y.Doc()
    const before = bodyOf(doc, 'a', 'Old')
    const { container, rerender } = render(
      <TextEditProvider>
        <TextEditOverlay obj={textObject(before)} target={TARGET} onEnd={() => undefined} />
      </TextEditProvider>,
    )
    expect(editorText(container)).toBe('Old')

    const after = bodyOf(doc, 'b', 'Replaced')
    act(() => {
      rerender(
        <TextEditProvider>
          <TextEditOverlay obj={textObject(after)} target={TARGET} onEnd={() => undefined} />
        </TextEditProvider>,
      )
    })
    expect(editorText(container)).toBe('Replaced')
  })
})
