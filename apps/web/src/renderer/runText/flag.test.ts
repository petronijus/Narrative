import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetTextEngineForTests,
  DEFAULT_TEXT_ENGINE,
  TEXT_ENGINE_STORAGE_KEY,
  textEngine,
} from './flag.js'

const g = globalThis as { __narrative_textEngine?: unknown }

afterEach(() => {
  delete g.__narrative_textEngine
  localStorage.removeItem(TEXT_ENGINE_STORAGE_KEY)
  window.history.replaceState(null, '', '/')
  _resetTextEngineForTests()
})

describe('textEngine', () => {
  it('is the default when nothing chooses', () => {
    expect(textEngine()).toBe(DEFAULT_TEXT_ENGINE)
  })

  it('takes the global first, then the URL, then the stored choice', () => {
    localStorage.setItem(TEXT_ENGINE_STORAGE_KEY, 'runs')
    expect(textEngine()).toBe('runs')
    _resetTextEngineForTests()
    window.history.replaceState(null, '', '/?textEngine=html')
    expect(textEngine()).toBe('html')
    _resetTextEngineForTests()
    g.__narrative_textEngine = 'runs'
    expect(textEngine()).toBe('runs')
  })

  it('ignores unknown names', () => {
    g.__narrative_textEngine = 'sdf'
    localStorage.setItem(TEXT_ENGINE_STORAGE_KEY, 'bitmap')
    expect(textEngine()).toBe(DEFAULT_TEXT_ENGINE)
  })

  it('is decided once per page', () => {
    expect(textEngine()).toBe(DEFAULT_TEXT_ENGINE)
    g.__narrative_textEngine = DEFAULT_TEXT_ENGINE === 'html' ? 'runs' : 'html'
    expect(textEngine()).toBe(DEFAULT_TEXT_ENGINE)
  })
})
