/**
 * `TokenService` — defined here, implemented by apps/server/src/services/tokens.ts.
 * See ../services.ts for the pattern: GET /folders/:id/tokens/:category/:tokenId/usages
 * and the `token.usages` command call the same method.
 */

import type { FolderTokensSnapshot } from '@narrative/slide-model'

export type TokenCategory = 'colors' | 'textStyles' | 'effectStyles'
/** The categories that are created and changed (nothing applies an effect style yet). */
export type EditableTokenCategory = 'colors' | 'textStyles'

export type TokenUsage =
  | {
      kind: 'deck'
      deckId: string
      deckTitle: string
      slideIndex: number
      objectId?: string | undefined
      field: string
    }
  | {
      kind: 'component'
      componentId: string
      componentName: string
      objectId?: string | undefined
      field: string
    }
  | { kind: 'textStyle'; styleId: string; styleName: string; field: 'color' }

/** What changing a token reached: the linked text re-styled in the folder's decks and component masters. */
export interface TokenPropagation {
  /** Decks with at least one object changed. */
  decks: number
  /** Component masters with at least one object changed. */
  components: number
  /** Text boxes and tables changed, in all of them. */
  objects: number
  /** Documents that could not be updated (logged); they catch up on the next change. */
  failed: string[]
}

export interface TokenService {
  /**
   * Every reference to one folder token across the folder's decks, its
   * component masters and (for colours) its text styles. Read from the
   * stored documents; folder owner only.
   */
  usages(args: {
    userId: string
    folderId: string
    category: TokenCategory
    tokenId: string
  }): Promise<{ usages: TokenUsage[] }>
  /** The folder's tokens. Folder owner only. */
  list(args: { userId: string; folderId: string }): Promise<FolderTokensSnapshot>
  /**
   * Add a token to the folder document. `fields` are validated here
   * (`parseNewTokenFields`, `invalid_input` otherwise) — whoever calls.
   * Refuses a colour past the folder's cap. Folder owner only.
   */
  create(args: {
    userId: string
    folderId: string
    category: EditableTokenCategory
    fields: Record<string, unknown>
  }): Promise<{ tokenId: string }>
  /**
   * Change a token (`null` / `undefined` removes a field; validated here
   * with `parseTokenPatch`; an empty patch is `invalid_input`). When that
   * changes the token, bring everything
   * linked to it up to date in every deck and component master of the
   * folder: a text style reaches the text boxes and tables linked to it, a
   * colour reaches those linked to a text style whose colour it is.
   */
  update(args: {
    userId: string
    folderId: string
    category: EditableTokenCategory
    tokenId: string
    patch: Record<string, unknown>
  }): Promise<{ previous: Record<string, unknown>; propagated: TokenPropagation }>
  /**
   * Remove a token; returns it as it was. Refuses a builtin text style.
   * References to it stay (they no longer resolve).
   */
  delete(args: {
    userId: string
    folderId: string
    category: TokenCategory
    tokenId: string
  }): Promise<{ deleted: true; token: Record<string, unknown> }>
  /**
   * Give a folder without colours and text styles the default ones, and
   * bring an older seed up to date. Idempotent.
   */
  seedDefaults(args: {
    userId: string
    folderId: string
  }): Promise<{ seeded: boolean; migrated: boolean }>
}
