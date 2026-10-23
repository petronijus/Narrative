// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { EDITOR_SHOW_MESSAGE_TYPE, type EditorShowMessage } from '@narrative/commands'
import { createEditorShowBus, parseEditorShowMessage } from './editorShow'

const json = (value: unknown): string => JSON.stringify(value)

describe('parseEditorShowMessage', () => {
  it('parses the message the server sends', () => {
    expect(
      parseEditorShowMessage(
        json({ type: EDITOR_SHOW_MESSAGE_TYPE, slideId: 's2', objectIds: ['a', 'b'], runId: 'r1' }),
      ),
    ).toEqual({ type: EDITOR_SHOW_MESSAGE_TYPE, slideId: 's2', objectIds: ['a', 'b'], runId: 'r1' })
  })

  it('treats a missing objectIds as "just the slide" and omits a missing runId', () => {
    const message = parseEditorShowMessage(json({ type: EDITOR_SHOW_MESSAGE_TYPE, slideId: 's1' }))
    expect(message).toEqual({ type: EDITOR_SHOW_MESSAGE_TYPE, slideId: 's1', objectIds: [] })
    expect(message).not.toHaveProperty('runId')
  })

  it('drops non-id entries and duplicates from objectIds', () => {
    const message = parseEditorShowMessage(
      json({
        type: EDITOR_SHOW_MESSAGE_TYPE,
        slideId: 's1',
        objectIds: ['a', 1, '', null, 'a', 'b'],
      }),
    )
    expect(message?.objectIds).toEqual(['a', 'b'])
  })

  it('ignores a malformed runId instead of rejecting the message', () => {
    const message = parseEditorShowMessage(
      json({ type: EDITOR_SHOW_MESSAGE_TYPE, slideId: 's1', objectIds: [], runId: 42 }),
    )
    expect(message).not.toBeNull()
    expect(message).not.toHaveProperty('runId')
  })

  it.each([
    ['not JSON', '{nope'],
    ['a JSON array', json([EDITOR_SHOW_MESSAGE_TYPE])],
    ['JSON null', 'null'],
    ['another message type', json({ type: 'narrative.other', slideId: 's1', objectIds: [] })],
    ['no slideId', json({ type: EDITOR_SHOW_MESSAGE_TYPE, objectIds: [] })],
    ['an empty slideId', json({ type: EDITOR_SHOW_MESSAGE_TYPE, slideId: '', objectIds: [] })],
    [
      'objectIds that is not a list',
      json({ type: EDITOR_SHOW_MESSAGE_TYPE, slideId: 's', objectIds: 'a' }),
    ],
  ])('returns null for %s', (_label, payload) => {
    expect(parseEditorShowMessage(payload)).toBeNull()
  })

  it('returns null for a non-string payload', () => {
    expect(parseEditorShowMessage(undefined)).toBeNull()
    expect(parseEditorShowMessage({ type: EDITOR_SHOW_MESSAGE_TYPE, slideId: 's1' })).toBeNull()
  })
})

describe('createEditorShowBus', () => {
  it('delivers to current subscribers only', () => {
    const bus = createEditorShowBus()
    const a = vi.fn()
    const b = vi.fn()
    const offA = bus.subscribe(a)
    bus.subscribe(b)
    const message: EditorShowMessage = {
      type: EDITOR_SHOW_MESSAGE_TYPE,
      slideId: 's1',
      objectIds: [],
    }
    bus.emit(message)
    offA()
    bus.emit(message)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })
})
