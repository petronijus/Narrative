/**
 * main/ipc.ts
 *
 * The main-process side of the bridge (packages/shared/src/desktop.ts,
 * docs/plans/desktop-d0-spec.md §3.3). Every handler first checks who is
 * calling — the main frame of the shell's main window, showing a page of the
 * loaded server — and parses the payload with its schema; anything else is
 * refused and logged, never answered.
 */

import {
  app,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { DESKTOP_IPC, type DesktopInfo } from '@narrative/shared'
import type { z } from 'zod'
import { noPayload } from './ipcSchemas.js'
import type { Logger } from './log.js'

export interface IpcContext {
  /** The main window's webContents, if it exists. */
  mainContents(): WebContents | null
  serverOrigin(): string | null
  log: Logger
}

type AnyEvent = IpcMainEvent | IpcMainInvokeEvent

/** Whether `event` comes from the main frame of the main window, on the server's origin. */
export function isTrustedSender(event: AnyEvent, ctx: IpcContext): boolean {
  const frame = event.senderFrame
  const main = ctx.mainContents()
  const origin = ctx.serverOrigin()
  if (frame === null || main === null || origin === null) return false
  if (event.sender !== main || frame !== main.mainFrame) return false
  try {
    return new URL(frame.url).origin === origin
  } catch {
    return false
  }
}

export class IpcRegistry {
  constructor(private readonly ctx: IpcContext) {}

  /** An invoke channel: the handler's value is the answer. */
  handle<S extends z.ZodType, R>(
    channel: string,
    schema: S,
    handler: (payload: z.infer<S>, event: IpcMainInvokeEvent) => R | Promise<R>,
  ): void {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!isTrustedSender(event, this.ctx)) {
        this.ctx.log.warn('ipc refused: untrusted sender', { channel })
        throw new Error('refused')
      }
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        this.ctx.log.warn('ipc refused: invalid payload', { channel })
        throw new Error('refused')
      }
      return handler(parsed.data, event)
    })
  }

  /** A send channel: no answer. */
  on<S extends z.ZodType>(
    channel: string,
    schema: S,
    handler: (payload: z.infer<S>, event: IpcMainEvent) => void,
  ): void {
    ipcMain.on(channel, (event, raw: unknown) => {
      if (!isTrustedSender(event, this.ctx)) {
        this.ctx.log.warn('ipc refused: untrusted sender', { channel })
        return
      }
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        this.ctx.log.warn('ipc refused: invalid payload', { channel })
        return
      }
      handler(parsed.data, event)
    })
  }
}

function platform(): DesktopInfo['platform'] {
  const p = process.platform
  return p === 'darwin' || p === 'win32' ? p : 'linux'
}

/** The channels every build has; the feature modules register their own. */
export function registerCoreIpc(registry: IpcRegistry): void {
  registry.handle(DESKTOP_IPC.info, noPayload, (): DesktopInfo => ({
    appVersion: app.getVersion(),
    platform: platform(),
    role: 'main',
  }))
}
