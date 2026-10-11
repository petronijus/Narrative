import { describe, expect, it } from 'vitest'
import { menuActionResult, setMenuRequest, signInRequest } from './ipcSchemas.js'

const edit = {
  id: 'edit',
  label: 'Edit',
  items: [
    { action: 'history.undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z', nativeFallback: 'undo' },
    'separator',
    { action: 'object.delete', label: 'Delete', chord: 'Delete', nativeFallback: 'delete' },
  ],
}

describe('IPC payloads', () => {
  it('accepts the editor menu', () => {
    expect(setMenuRequest.safeParse([edit]).success).toBe(true)
    expect(setMenuRequest.safeParse([]).success).toBe(true)
  })

  it.each([
    [
      'a chord the table does not give that action',
      { action: 'object.delete', label: 'Delete', accelerator: 'Delete' },
    ],
    ['the shell’s own key', { action: 'object.copy', label: 'Quit', accelerator: 'CmdOrCtrl+Q' }],
    ['a missing fallback', { action: 'history.undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z' }],
    ['a malformed action', { action: 'Undo', label: 'Undo' }],
    ['a long label', { action: 'history.undo', label: 'x'.repeat(65) }],
    ['an unknown field', { action: 'object.delete', label: 'Delete', role: 'quit' }],
    ['a chord the table does not give', { action: 'object.copy', label: 'Copy', chord: 'Delete' }],
    [
      'the file dialog on another action',
      { action: 'view.zoomIn', label: 'Zoom In', chord: '=', shell: 'openPptx' },
    ],
  ])('refuses %s', (_label, item) => {
    expect(setMenuRequest.safeParse([{ ...edit, items: [item] }]).success).toBe(false)
  })

  it('refuses unknown and repeated sections', () => {
    expect(setMenuRequest.safeParse([{ ...edit, id: 'window' }]).success).toBe(false)
    expect(setMenuRequest.safeParse([edit, edit]).success).toBe(false)
  })

  it('checks the other payloads', () => {
    expect(menuActionResult.safeParse({ seq: 3, handled: true }).success).toBe(true)
    expect(menuActionResult.safeParse({ seq: -1, handled: true }).success).toBe(false)
    expect(signInRequest.safeParse({ returnTo: '/deck/abc' }).success).toBe(true)
    expect(signInRequest.safeParse({ returnTo: '//evil.example' }).success).toBe(false)
    expect(signInRequest.safeParse({ returnTo: 'https://evil.example' }).success).toBe(false)
  })
})
