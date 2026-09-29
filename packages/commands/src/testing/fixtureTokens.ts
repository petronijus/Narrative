/**
 * commands/src/testing/fixtureTokens.ts — the fixture deck's folder tokens:
 * a brand palette and the text styles every new folder is seeded with that
 * commands look up by name (the page-number style), with a colour linked to
 * a colour token so resolution through a style is exercised too.
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
    },
    effectStyles: {},
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
