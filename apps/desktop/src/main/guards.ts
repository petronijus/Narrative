/**
 * main/guards.ts
 *
 * The navigation and window-opening rules every webContents of the shell
 * gets (docs/plans/desktop-d0-spec.md §3.3), installed from
 * `web-contents-created`: the server's pages stay in the app, web and mail
 * links open in the system browser, nothing else loads, no `<webview>` and
 * no popup the page creates itself. The one popup the editor needs, the
 * presenter view, the shell opens as its own window without any bridge.
 */

import { BrowserWindow, shell, type WebContents } from 'electron'
import type { Logger } from './log.js'
import { classifyNavigation, isExternalUrl, isPresenterPopup } from './navigationPolicy.js'

export interface GuardContext {
  /** The origin of the server the shell has loaded; null before it has one. */
  serverOrigin(): string | null
  /** Open the presenter view in a window of `partition`. */
  openPresenter(url: string, partition: string): void
  log: Logger
}

/** The partition a webContents was created in (its session's storage id). */
export type PartitionOf = (wc: WebContents) => string | null

function openExternal(url: string, log: Logger): void {
  if (!isExternalUrl(url)) return
  shell.openExternal(new URL(url).toString()).catch((err: unknown) => {
    log.warn('openExternal failed', { err })
  })
}

export function applyWebContentsGuards(
  wc: WebContents,
  ctx: GuardContext,
  partitionOf: PartitionOf,
): void {
  wc.on('will-frame-navigate', (event) => {
    const verdict = classifyNavigation(event.url, ctx.serverOrigin())
    if (verdict === 'allow') return
    event.preventDefault()
    if (verdict === 'external' && event.isMainFrame) openExternal(event.url, ctx.log)
    else if (verdict === 'block') ctx.log.warn('navigation blocked', { url: event.url })
  })

  wc.on('will-redirect', (event) => {
    if (classifyNavigation(event.url, ctx.serverOrigin()) === 'allow') return
    event.preventDefault()
    ctx.log.warn('redirect blocked', { url: event.url })
  })

  wc.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  wc.setWindowOpenHandler(({ url }) => {
    const origin = ctx.serverOrigin()
    if (isPresenterPopup(url, origin)) {
      const partition = partitionOf(wc)
      if (partition !== null) ctx.openPresenter(url, partition)
    } else if (classifyNavigation(url, origin) === 'external') {
      openExternal(url, ctx.log)
    } else {
      ctx.log.warn('window.open blocked', { url })
    }
    return { action: 'deny' }
  })
}

/** Presenter windows the shell has opened (closed with their owner). */
export function createPresenterWindow(
  url: string,
  partition: string,
  opts: { devTools: boolean },
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#030712',
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      devTools: opts.devTools,
    },
  })
  win.once('ready-to-show', () => win.show())
  void win.loadURL(url)
  return win
}
