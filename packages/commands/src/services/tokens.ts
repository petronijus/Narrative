/**
 * `TokenService` — defined here, implemented by apps/server/src/services/tokens.ts.
 * See ../services.ts for the pattern: GET /folders/:id/tokens/:category/:tokenId/usages
 * and the `token.usages` command call the same method.
 */

export type TokenCategory = 'colors' | 'textStyles' | 'effectStyles'

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
}
