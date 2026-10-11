/**
 * The desktop shell's security baseline, against a stub server (no dev
 * stack): sandboxed pages without Node, the bridge only in the main window,
 * navigation kept on the server, other links in the system browser, no
 * page-made popups but the presenter view, and only the editor's permissions.
 */

import { expect, test, STUB_PAGE } from './fixtures/desktop'

test.describe('desktop shell', () => {
  test('runs the page sandboxed, isolated and without Node', async ({
    stubServer,
    launchShell,
  }) => {
    const server = await stubServer()
    const { app, window } = await launchShell(server.origin)
    await expect(window.locator('h1')).toHaveText('stub')
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences()!
      return {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      }
    })
    expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(await app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox'))).toBe(false)
    expect(await window.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
      'undefined',
    )
  })

  test('offers version 1 of the bridge to the server page', async ({ stubServer, launchShell }) => {
    const server = await stubServer()
    const { window } = await launchShell(server.origin)
    const bridge = await window.evaluate(async () => {
      const b = window.narrativeDesktop!
      return { version: b.bridgeVersion, role: b.role, info: await b.info() }
    })
    expect(bridge.version).toBe(1)
    expect(bridge.role).toBe('main')
    expect(bridge.info.role).toBe('main')
  })

  test('names a non-production server in the window title', async ({ stubServer, launchShell }) => {
    const server = await stubServer()
    const { app, window } = await launchShell(server.origin)
    await expect(window.locator('h1')).toHaveText('stub')
    const host = new URL(server.origin).host
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle()))
      .toBe(`Stub Narrative — ${host}`)
  })

  test('keeps navigation on the server and sends web links to the system browser', async ({
    stubServer,
    launchShell,
  }) => {
    const server = await stubServer()
    const { window, opened } = await launchShell(server.origin)
    await expect(window.locator('h1')).toHaveText('stub')
    await window.click('#external')
    await window.evaluate(() => window.open('https://example.com/popup'))
    await window.evaluate(() => {
      location.href = 'file:///etc/passwd'
    })
    await expect.poll(opened).toEqual(['https://example.com/away', 'https://example.com/popup'])
    expect(window.url()).toBe(`${server.origin}/`)
  })

  test('opens the presenter view as its own window, without the bridge', async ({
    stubServer,
    launchShell,
  }) => {
    const server = await stubServer()
    const { app, window } = await launchShell(server.origin)
    await expect(window.locator('h1')).toHaveText('stub')
    const popup = app.waitForEvent('window')
    await window.evaluate(() =>
      window.open('/deck/abc123/present?presenter=1', 'presenter', 'noopener'),
    )
    const presenter = await popup
    await expect(presenter.locator('h1')).toHaveText('stub')
    expect(presenter.url()).toBe(`${server.origin}/deck/abc123/present?presenter=1`)
    expect(await presenter.evaluate(() => typeof window.narrativeDesktop)).toBe('undefined')
    // Any other popup the page makes is refused.
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    await window.evaluate(() => window.open('/somewhere-else'))
    await window.waitForTimeout(500)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
      windows,
    )
  })

  test('grants no permission the editor does not use', async ({ stubServer, launchShell }) => {
    const server = await stubServer()
    const { window } = await launchShell(server.origin)
    await expect(window.locator('h1')).toHaveText('stub')
    expect(await window.evaluate(() => Notification.requestPermission())).toBe('denied')
    const geolocation = await window.evaluate(() =>
      navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state),
    )
    expect(geolocation).toBe('denied')
  })

  test('serves the stub page this spec relies on', () => {
    expect(STUB_PAGE).toContain('<title>Stub Narrative</title>')
  })
})
