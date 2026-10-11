/**
 * main/redeemWindow.ts
 *
 * Redeem a sign-in ticket the way the server requires (routes/desktopAuth.ts
 * `isDesktopRedeemSource`): as a navigation this process starts itself —
 * `Sec-Fetch-Site: none` — carrying `X-Narrative-Desktop: 1`, in a hidden
 * window of the server's partition, so the session cookie of the server's
 * 303 lands in the jar the editor reads. Never a `<form>` from a local page
 * (that sends `cross-site` and `Origin: null`, which the server refuses), and
 * never the main window, which a link must not be able to navigate.
 */

import { BrowserWindow } from 'electron'
import {
  REDEEM_TIMEOUT_MS,
  classifyRedeemRedirect,
  type RedeemOutcome,
  type RedeemRequest,
} from './signIn.js'

export function redeemInHiddenWindow(
  req: RedeemRequest,
  partition: string,
): Promise<RedeemOutcome> {
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      javascript: false,
      devTools: false,
    },
  })
  const redeemUrl = req.url

  return new Promise<RedeemOutcome>((resolve) => {
    let done = false
    const finish = (outcome: RedeemOutcome): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish({ kind: 'failed', reason: 'timeout' }), REDEEM_TIMEOUT_MS)

    // The 303 is the answer: the cookie it sets is already stored when the
    // redirect is reported. Stop there; the main window loads the target.
    win.webContents.on('did-redirect-navigation', (event) => {
      if (!event.isMainFrame) return
      win.webContents.stop()
      finish(classifyRedeemRedirect(event.url, req.serverOrigin))
    })
    // Nothing but the redeem itself and its redirect may load here.
    win.webContents.on('will-frame-navigate', (event) => {
      if (event.url !== redeemUrl) event.preventDefault()
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // ERR_ABORTED (-3) follows our own stop() after the redirect.
      if (isMainFrame && code !== -3) finish({ kind: 'failed', reason: `network: ${description}` })
      void url
    })
    win.webContents.on('did-finish-load', () => {
      // A page instead of a redirect: the server did not answer as expected.
      finish({ kind: 'failed', reason: 'no_redirect' })
    })

    void win
      .loadURL(redeemUrl, {
        postData: [{ type: 'rawData', bytes: Buffer.from(req.body, 'utf8') }],
        extraHeaders: 'Content-Type: application/x-www-form-urlencoded\nX-Narrative-Desktop: 1',
      })
      .catch(() => {
        // Rejected after our stop(); the outcome is already set, or the
        // failure handlers set it.
      })
  })
}
