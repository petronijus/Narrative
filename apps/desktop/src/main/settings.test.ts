import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SETTINGS_FILE, loadSettings, saveSettings } from './settings.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'narrative-settings-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('settings', () => {
  it('starts from the defaults: production', () => {
    const { settings, setAside } = loadSettings(dir)
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(settings.server).toEqual({ kind: 'production' })
    expect(setAside).toBeNull()
  })

  it('saves and loads a custom server', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      server: { kind: 'custom' as const, origin: 'https://narrative.example.com' },
    }
    saveSettings(dir, settings)
    expect(loadSettings(dir).settings).toEqual(settings)
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE])
  })

  it.each([
    ['broken JSON', '{"version":'],
    ['an unknown version', JSON.stringify({ ...DEFAULT_SETTINGS, version: 2 })],
    [
      'an unsafe custom origin',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        server: { kind: 'custom', origin: 'http://evil.example' },
      }),
    ],
    ['an unknown key', JSON.stringify({ ...DEFAULT_SETTINGS, extra: true })],
  ])('sets aside a file with %s and uses the defaults', (_label, content) => {
    writeFileSync(path.join(dir, SETTINGS_FILE), content)
    const { settings, setAside } = loadSettings(dir, 1234)
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(setAside).toBe(path.join(dir, 'settings.invalid-1234.json'))
    expect(readFileSync(setAside!, 'utf8')).toBe(content)
  })

  it('refuses to save invalid settings', () => {
    expect(() =>
      saveSettings(dir, { ...DEFAULT_SETTINGS, window: { width: 1, height: 1, maximized: false } }),
    ).toThrow()
  })
})
