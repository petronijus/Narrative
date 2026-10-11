import { describe, expect, it } from 'vitest'
import { isPermissionAllowed } from './permissions.js'

const SERVER = 'https://narrative.example.com'

describe('permissions', () => {
  it.each(['clipboard-sanitized-write', 'fullscreen', 'window-management'])(
    'grants %s to the server',
    (permission) => {
      expect(isPermissionAllowed(permission, `${SERVER}/deck/abc`, SERVER)).toBe(true)
      expect(isPermissionAllowed(permission, SERVER, SERVER)).toBe(true)
    },
  )

  it.each([
    'clipboard-read',
    'media',
    'display-capture',
    'notifications',
    'geolocation',
    'midi',
    'openExternal',
    'persistent-storage',
  ])('denies %s', (permission) => {
    expect(isPermissionAllowed(permission, SERVER, SERVER)).toBe(false)
  })

  it('denies other origins and sessions without a server', () => {
    expect(isPermissionAllowed('fullscreen', 'https://evil.example', SERVER)).toBe(false)
    expect(isPermissionAllowed('fullscreen', 'not a url', SERVER)).toBe(false)
    expect(isPermissionAllowed('fullscreen', SERVER, null)).toBe(false)
  })
})
