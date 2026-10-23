// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  coversStateVector,
  decodeBase64,
  encodeStateVectorBase64,
  untilCoversStateVector,
} from './stateVector'

/** Two docs synced once; then `editor` moves on alone. */
function pair() {
  const editor = new Y.Doc()
  const page = new Y.Doc()
  editor.getArray('slides').push(['s1'])
  Y.applyUpdate(page, Y.encodeStateAsUpdate(editor))
  return { editor, page }
}

describe('stateVector', () => {
  it('a copy covers what it has seen, not an edit made after', () => {
    const { editor, page } = pair()
    expect(coversStateVector(page, Y.encodeStateVector(editor))).toBe(true)
    editor.getArray('slides').push(['s2'])
    expect(coversStateVector(page, Y.encodeStateVector(editor))).toBe(false)
    // An edit of the page's own does not make up for the missing one.
    page.getArray('slides').push(['p1'])
    expect(coversStateVector(page, Y.encodeStateVector(editor))).toBe(false)
  })

  it('waits for the edit to arrive, and gives up after the timeout', async () => {
    const { editor, page } = pair()
    editor.getArray('slides').push(['s2'])
    const wanted = decodeBase64(encodeStateVectorBase64(editor))
    const arrived = untilCoversStateVector(page, wanted, 1_000)
    Y.applyUpdate(page, Y.encodeStateAsUpdate(editor, Y.encodeStateVector(page)))
    await expect(arrived).resolves.toBeUndefined()

    editor.getArray('slides').push(['s3'])
    await expect(untilCoversStateVector(page, Y.encodeStateVector(editor), 20)).rejects.toThrow(
      /did not arrive/,
    )
  })
})
