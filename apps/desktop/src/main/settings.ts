/**
 * main/settings.ts
 *
 * The shell's own settings in `<userData>/settings.json`
 * (docs/plans/desktop-d0-spec.md §3.8): which server (and the custom one
 * last used), the window size, and whether the plaintext-storage warning was
 * shown. Validated on every load;
 * an invalid file is set aside (renamed, never deleted) and the defaults
 * apply; a save goes through a temporary file and a rename, so a crash never
 * leaves half a file. Pure Node: no Electron here.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { normalizeCustomOrigin } from './servers.js'

const serverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('production') }).strict(),
  z.object({ kind: z.literal('development') }).strict(),
  z
    .object({
      kind: z.literal('custom'),
      origin: z.string().refine((o) => normalizeCustomOrigin(o) === o, 'not a custom origin'),
    })
    .strict(),
])

const settingsSchema = z
  .object({
    version: z.literal(1),
    server: serverSchema,
    window: z
      .object({
        width: z.number().int().min(640).max(16384),
        height: z.number().int().min(480).max(16384),
        maximized: z.boolean(),
      })
      .strict(),
    warnedPlaintextStorage: z.boolean(),
    /** The custom server last chosen, offered again under Server ▸. */
    lastCustomOrigin: z
      .string()
      .refine((o) => normalizeCustomOrigin(o) === o, 'not a custom origin')
      .nullable(),
  })
  .strict()

export type Settings = z.infer<typeof settingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  server: { kind: 'production' },
  window: { width: 1600, height: 1000, maximized: false },
  warnedPlaintextStorage: false,
  lastCustomOrigin: null,
}

export const SETTINGS_FILE = 'settings.json'

export interface LoadedSettings {
  settings: Settings
  /** Where an invalid file was set aside, if one was. */
  setAside: string | null
}

/** Read the settings in `dir`; `now` names a set-aside file. */
export function loadSettings(dir: string, now: number = Date.now()): LoadedSettings {
  const file = path.join(dir, SETTINGS_FILE)
  if (!existsSync(file)) return { settings: structuredClone(DEFAULT_SETTINGS), setAside: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    parsed = undefined
  }
  const result = settingsSchema.safeParse(parsed)
  if (result.success) return { settings: result.data, setAside: null }
  const setAside = path.join(dir, `settings.invalid-${now}.json`)
  renameSync(file, setAside)
  return { settings: structuredClone(DEFAULT_SETTINGS), setAside }
}

/** Write the settings to `dir`, atomically. */
export function saveSettings(dir: string, settings: Settings): void {
  const valid = settingsSchema.parse(settings)
  const file = path.join(dir, SETTINGS_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}
