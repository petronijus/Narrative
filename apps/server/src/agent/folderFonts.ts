/**
 * agent/folderFonts.ts — the font faces a command's target sees
 * (`ctx.folderFonts`): the fonts uploaded to the folder the deck or
 * component master belongs to, as family and weight (and a variable face's
 * axis ranges).
 *
 * The server host loads them only for commands that declare
 * `readsFolderFonts` (or a batch containing one), after it has authorised
 * the actor on the target — e.g. `text.setBoxTypography`, which snaps a
 * box's weight to a cut its new family has, as the editor's font picker
 * does. Only family and weight leave this module; file names, storage keys
 * and uploaders stay here.
 */

import type { CommandTarget, FontFaceWeight } from '@narrative/commands'
import type { Database } from '../db/client.js'
import { listFolderFontAssets } from '../media/assets.js'
import { folderOf } from './folderTokens.js'

/** The target's folder font faces; null when it has no folder or the folder has no fonts. */
export type FolderFontsReader = (target: CommandTarget) => Promise<FontFaceWeight[] | null>

export interface FolderFontsSources {
  /** The folder the target belongs to, or null. */
  folderOf(target: CommandTarget): Promise<string | null>
  /** The folder's uploaded font faces. */
  listFonts(folderId: string): Promise<ReadonlyArray<FontFaceWeight>>
}

export function createFolderFontsReader(sources: FolderFontsSources): FolderFontsReader {
  return async (target) => {
    const folderId = await sources.folderOf(target)
    if (folderId === null) return null
    const faces = await sources.listFonts(folderId)
    return faces.length === 0
      ? null
      : faces.map((f) => ({
          family: f.family,
          weight: f.weight,
          ...(f.axes !== undefined ? { axes: f.axes } : {}),
        }))
  }
}

/** The production reader: the folder and its font assets from the database. */
export function createDbFolderFontsReader(db: Database): FolderFontsReader {
  return createFolderFontsReader({
    folderOf: (target) => folderOf(db, target),
    listFonts: async (folderId) =>
      (await listFolderFontAssets(db, folderId)).map((row) => ({
        family: row.fontFamily,
        weight: row.fontWeight,
        // A variable face covers its axes' ranges (A4.2c).
        ...(row.fontAxes !== null &&
        (row.fontAxes.wght !== undefined || row.fontAxes.wdth !== undefined)
          ? { axes: row.fontAxes }
          : {}),
      })),
  })
}
