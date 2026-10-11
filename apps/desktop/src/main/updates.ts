/**
 * main/updates.ts
 *
 * The app updates itself from the feed on the server (ADR 0014,
 * docs/plans/desktop-d0-spec.md §3.11): a check 10 s after start, then every
 * 6 hours, and from Check for Updates…. electron-updater downloads; nothing
 * installs until the download passed the signature gate (updateVerify.ts)
 * and the person chose Restart now. `autoInstallOnAppQuit` is off, so "Later"
 * installs nothing either; a download that failed the gate is deleted and
 * never offered. An unpackaged build never updates.
 */

import { rm } from 'node:fs/promises'
import { autoUpdater, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import type { Logger } from './log.js'
import { verifyDownloadedUpdate } from './updateVerify.js'

export const FIRST_CHECK_DELAY_MS = 10_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UpdateDeps {
  packaged: boolean
  currentVersion: string
  log: Logger
  feedBase: string
  publicKey: string
  fetchText(url: string): Promise<string | null>
  /** Ask whether to restart into `version` now. */
  offerRestart(version: string): Promise<boolean>
  /** Report the outcome of a check the person started. */
  report(message: string, detail?: string): void
}

export class Updates {
  private manual = false
  private lastFailure: string | null = null
  private started = false

  constructor(private readonly deps: UpdateDeps) {}

  start(): void {
    if (!this.deps.packaged || this.started) return
    this.started = true
    const { log } = this.deps
    autoUpdater.logger = {
      info: (m: unknown) => log.info('updater', { detail: String(m) }),
      warn: (m: unknown) => log.warn('updater', { detail: String(m) }),
      error: (m: unknown) => log.error('updater', { detail: String(m) }),
      debug: () => undefined,
    }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false

    autoUpdater.on('update-not-available', () => {
      if (this.consumeManual()) {
        const failure = this.lastFailure
        this.deps.report(
          `Narrative ${this.deps.currentVersion} is up to date.`,
          failure === null ? undefined : `The last update was not installed: ${failure}.`,
        )
      }
    })
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      log.info('update available', { version: info.version })
      if (this.consumeManual()) {
        this.deps.report(
          `Narrative ${info.version} is downloading.`,
          'You will be asked to restart once it is ready.',
        )
      }
    })
    autoUpdater.on('error', (err: Error) => {
      log.warn('update check failed', { err: err.message })
      if (this.consumeManual())
        this.deps.report('Narrative could not check for updates.', err.message)
    })
    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      void this.downloaded(event)
    })

    setTimeout(() => this.check(false), FIRST_CHECK_DELAY_MS).unref()
    setInterval(() => this.check(false), CHECK_INTERVAL_MS).unref()
  }

  /** A check; `manual` reports its outcome. */
  check(manual: boolean): void {
    if (!this.deps.packaged) {
      if (manual)
        this.deps.report('Updates come with the installed app.', 'This is a development build.')
      return
    }
    this.manual = this.manual || manual
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      this.deps.log.warn('update check failed', { err: String(err) })
    })
  }

  private consumeManual(): boolean {
    const was = this.manual
    this.manual = false
    return was
  }

  private async downloaded(event: UpdateDownloadedEvent): Promise<void> {
    const result = await verifyDownloadedUpdate(
      { downloadedFile: event.downloadedFile, version: event.version, files: event.files },
      {
        feedBase: this.deps.feedBase,
        publicKey: this.deps.publicKey,
        fetchText: this.deps.fetchText,
      },
    )
    if (!result.ok) {
      this.lastFailure = result.reason
      this.deps.log.error('update refused', { version: event.version, reason: result.reason })
      await rm(event.downloadedFile, { force: true }).catch(() => undefined)
      return
    }
    this.lastFailure = null
    this.deps.log.info('update verified', { version: event.version })
    if (await this.deps.offerRestart(event.version)) autoUpdater.quitAndInstall(true, true)
  }
}
