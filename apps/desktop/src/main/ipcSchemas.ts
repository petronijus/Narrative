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

/** `signIn`: where the app goes after signing in — a path of the server (the server checks it again). */
export const signInRequest = z
  .object({
    returnTo: z
      .string()
      .max(499)
      .refine(
        (v) => v.startsWith('/') && !v.startsWith('//') && !/[\x00-\x1f\x7f\\]/.test(v),
        'not a path of the app',
      ),
  })
  .strict()
