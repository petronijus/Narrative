/**
 * scripts/builderConfig.test.ts
 *
 * The packaging config keeps the promises the shell's security rests on
 * (ADR 0014): the Electron it packages is the one pinned and tested, the
 * fuses are set, the app ships only the bundles, and the update feed is
 * the one the shell verifies.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const config = require('../electron-builder.config.cjs')
const pkg = require('../package.json')
const servers = require('../servers.json')

describe('electron-builder config', () => {
  it('packages the pinned Electron', () => {
    expect(config.electronVersion).toBe(pkg.devDependencies.electron)
  })

  it('names the app Narrative, which also names its data directory', () => {
    // Without productName in package.json Electron takes the package name,
    // and the app kept its data in ~/.config/@narrative/desktop.
    expect(pkg.productName).toBe('Narrative')
    expect(config.productName).toBe(pkg.productName)
  })

  it('flips every fuse the shell relies on', () => {
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
      enableCookieEncryption: true,
    })
  })

  it('ships the bundles and nothing from node_modules', () => {
    expect(config.files).toEqual(['dist/**', '!dist/**/*.map', 'package.json'])
    expect(pkg.dependencies).toBeUndefined()
  })

  it('publishes to the feed the shell checks, and registers only the release scheme', () => {
    expect(config.publish.url).toBe(servers.updateFeed)
    expect(config.protocols).toEqual([{ name: 'Narrative', schemes: ['narrative'] }])
  })

  it('signs and notarizes macOS builds', () => {
    expect(config.mac.hardenedRuntime).toBe(true)
    expect(config.mac.notarize).toBe(true)
    expect(config.mac.identity).toBeUndefined()
  })
})
