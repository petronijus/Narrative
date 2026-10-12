/**
 * `StylePackService` — defined here, implemented by
 * apps/server/src/services/stylePacks.ts (agentic A4.3): a folder's style
 * pack, read and changed in its folder document. Every change is validated
 * there (`parseStylePack`: the shape and `validateStylePack`), whoever
 * calls — the commands, the Folder Settings page, the bootstrap.
 */

import type { StylePack } from '@narrative/shared'

/**
 * What a change replaced. For an update, a merge patch that puts it back
 * (the parts it touched as they were, `null` where absent). For a set or a
 * delete, the whole pack before — `null` when there was none.
 */
export interface StylePackChange {
  previous: Record<string, unknown> | null
}

/** What compiling a pack made of it (A4.4). */
export interface StylePackCompile {
  colors: { created: number; updated: number }
  textStyles: { created: number; updated: number }
  components: { created: number; updated: number }
  /** Faces the pack names that the folder does not hold (upload them). */
  missingFonts: string[]
}

export interface StylePackService {
  /** The folder's pack, or null. Members read it, and guests of its decks. */
  get(args: { userId: string; folderId: string }): Promise<StylePack | null>
  /** Replace the folder's pack with a valid one. Folder editors. */
  set(args: { userId: string; folderId: string; pack: unknown }): Promise<StylePackChange>
  /**
   * Change the folder's pack by a JSON merge patch (`layouts` and
   * `components` also by id); the result must be valid. Folder editors.
   */
  update(args: {
    userId: string
    folderId: string
    patch: Record<string, unknown>
  }): Promise<StylePackChange>
  /** Remove the folder's pack (what it made — tokens, masters — stays). Folder editors. */
  delete(args: { userId: string; folderId: string }): Promise<StylePackChange>
  /** Make the pack the folder's tokens and component masters (A4.4). Folder editors. */
  compile(args: { userId: string; folderId: string }): Promise<StylePackCompile>
}
