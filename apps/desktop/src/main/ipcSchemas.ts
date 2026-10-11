/**
 * main/ipcSchemas.ts
 *
 * The schema of every payload a page may send the main process
 * (docs/plans/desktop-d0-spec.md §3.3). Kept apart from ipc.ts so they can be
 * tested without Electron.
 */

import {
  DESKTOP_MENU_ACCELERATORS,
  DESKTOP_MENU_LABEL_MAX,
  DESKTOP_MENU_MAX_ITEMS,
  DESKTOP_OPEN_FILE_CHUNK,
} from '@narrative/shared'
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

const SECTION_IDS = ['file', 'edit', 'view', 'arrange', 'present'] as const
const NATIVE_EDITS = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const

const menuItem = z
  .object({
    action: z.string().regex(/^[a-z][A-Za-z]*(\.[A-Za-z]+)+$/),
    label: z.string().min(1).max(DESKTOP_MENU_LABEL_MAX),
    accelerator: z.string().optional(),
    nativeFallback: z.enum(NATIVE_EDITS).optional(),
    shell: z.literal('openPptx').optional(),
  })
  .strict()
  // A page may show only the keys of the shared table, for exactly that
  // action — never its own chords, nor the shell's (Quit, Reload).
  .refine(
    (item) =>
      item.accelerator === DESKTOP_MENU_ACCELERATORS[item.action]?.accelerator &&
      item.nativeFallback === DESKTOP_MENU_ACCELERATORS[item.action]?.nativeFallback,
    'key or native fallback not in the shared table',
  )

/** `setMenu`: the editor's sections (an empty list resets to the shell's own menu). */
export const setMenuRequest = z
  .array(
    z
      .object({
        id: z.enum(SECTION_IDS),
        label: z.string().min(1).max(DESKTOP_MENU_LABEL_MAX),
        items: z.array(z.union([z.literal('separator'), menuItem])).max(DESKTOP_MENU_MAX_ITEMS),
      })
      .strict(),
  )
  .max(SECTION_IDS.length)
  .refine(
    (sections) => new Set(sections.map((s) => s.id)).size === sections.length,
    'repeated section',
  )

export type MenuSections = z.infer<typeof setMenuRequest>

/** `menuActionResult`: the page's answer to a menu click. */
export const menuActionResult = z
  .object({ seq: z.number().int().nonnegative(), handled: z.boolean() })
  .strict()

const fileId = z.string().uuid()

/** `openFileRead`: a chunk of a waiting file. */
export const openFileReadRequest = z
  .object({
    id: fileId,
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(DESKTOP_OPEN_FILE_CHUNK),
  })
  .strict()

/** `openFileConsumed`: the page is done with a file. */
export const openFileConsumedRequest = z.object({ id: fileId }).strict()
