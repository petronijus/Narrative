/**
 * commands/src/testing/fixtureTokens.ts — the fixture deck's folder tokens:
 * a brand palette and the text styles every new folder is seeded with that
 * commands look up by name (the page-number style), with a colour linked to
 * a colour token so resolution through a style is exercised too; an unused
 * colour, a default style from before the `builtin` flag and a shadow style
 * give the token commands' examples something to work on.
 */

import type { FolderTokensSnapshot } from '@narrative/slide-model'
import type { FontFaceWeight } from '../text/fontWeights.js'

export const FIXTURE_COLOR_TOKEN_ID = 'brandBlue'
export const FIXTURE_PAGE_NUMBER_STYLE_ID = 'footnotes'

export function createFixtureFolderTokens(): FolderTokensSnapshot {
  return {
    colors: {
      [FIXTURE_COLOR_TOKEN_ID]: {
        id: FIXTURE_COLOR_TOKEN_ID,
        name: 'Brand blue',
        value: '#2040c0',
      },
      ink: { id: 'ink', name: 'Ink', value: '#222222' },
      // Used by nothing (token.delete's example).
      retired: { id: 'retired', name: 'Retired red', value: '#c03030' },
    },
    textStyles: {
      title: { id: 'title', name: 'Title', family: 'Inter', weight: 700, size: 72, builtin: true },
      [FIXTURE_PAGE_NUMBER_STYLE_ID]: {
        id: FIXTURE_PAGE_NUMBER_STYLE_ID,
        name: 'Footnotes and pages',
        family: 'Inter',
        weight: 400,
        size: 14,
        lineHeight: 1.2,
        letterSpacing: 0.5,
        color: { $token: 'colors.ink' },
        textTransform: 'uppercase',
        builtin: true,
      },
      // Seeded before the `builtin` flag existed (token.seedDefaults brings it up to date).
      body: { id: 'body', name: 'Body', family: 'Inter', weight: 400, size: 24 },
    },
    effectStyles: {
      soft: {
        id: 'soft',
        name: 'Soft shadow',
        kind: 'shadow',
        params: { color: '#000000', blur: 24, offsetX: 0, offsetY: 8, opacity: 0.2 },
      },
    },
  }
}

/** The fixture folder's uploaded fonts: one family with a light and a semibold cut. */
export const FIXTURE_FONT_FAMILY = 'Brand Sans'

export function createFixtureFolderFonts(): FontFaceWeight[] {
  return [
    { family: FIXTURE_FONT_FAMILY, weight: 300 },
    { family: FIXTURE_FONT_FAMILY, weight: 600 },
  ]
}
