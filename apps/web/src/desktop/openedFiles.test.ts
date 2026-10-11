import { afterEach, describe, expect, it } from 'vitest'
import {
  enqueueOpenedFile,
  resetOpenedFilesForTests,
  takeOpenedFile,
  consumeOpenedFile,
} from './openedFiles'

const file = (id: string) => ({ id, name: `${id}.pptx`, size: 10 })

afterEach(() => resetOpenedFilesForTests())

describe('opened files on the page', () => {
  it('hands files out oldest first, one at a time', () => {
    enqueueOpenedFile(file('a'))
    enqueueOpenedFile(file('b'))
    expect(takeOpenedFile()?.id).toBe('a')
    expect(takeOpenedFile()?.id).toBe('b')
    expect(takeOpenedFile()).toBeNull()
  })

  it('ignores the shell announcing a file again until it is consumed', () => {
    enqueueOpenedFile(file('a'))
    enqueueOpenedFile(file('a'))
    expect(takeOpenedFile()?.id).toBe('a')
    // Re-subscribed while it is being read: a repeat.
    enqueueOpenedFile(file('a'))
    expect(takeOpenedFile()).toBeNull()
    consumeOpenedFile('a')
    // A new announcement after the consume is a new opening.
    enqueueOpenedFile(file('a'))
    expect(takeOpenedFile()?.id).toBe('a')
  })
})
