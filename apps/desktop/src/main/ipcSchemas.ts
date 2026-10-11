/**
 * main/ipcSchemas.ts
 *
 * The schema of every payload a page may send the main process
 * (docs/plans/desktop-d0-spec.md §3.3). Kept apart from ipc.ts so they can be
 * tested without Electron.
 */

import { z } from 'zod'

/** A channel that takes no payload. */
export const noPayload = z.undefined()
