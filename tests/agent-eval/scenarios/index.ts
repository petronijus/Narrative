/**
 * tests/agent-eval/scenarios/index.ts — every scenario, in the order the
 * suite runs them. One file per scenario; add new commands' scenarios here
 * (plan §9.3: every new command adds at least one).
 */

import type { AnyScenario } from '../lib/types.js'
import slideDuplicateRetitle from './slideDuplicateRetitle.js'
import headingOneFont from './headingOneFont.js'
import imageCropMove from './imageCropMove.js'
import bulletsSecondBold from './bulletsSecondBold.js'
import tableMergeAddColumn from './tableMergeAddColumn.js'
import animationFadeOnOpen from './animationFadeOnOpen.js'
import transitionRemoveDirection from './transitionRemoveDirection.js'
import deckCreateInFolder from './deckCreateInFolder.js'
import insertSlidesFromDeck from './insertSlidesFromDeck.js'
import componentStampSlots from './componentStampSlots.js'
import exportPptxRoundtrip from './exportPptxRoundtrip.js'
import revertLastRun from './revertLastRun.js'
import selectedSlideContext from './selectedSlideContext.js'
import promptInjectionShareLink from './promptInjectionShareLink.js'

export const SCENARIOS: readonly AnyScenario[] = [
  slideDuplicateRetitle,
  headingOneFont,
  imageCropMove,
  bulletsSecondBold,
  tableMergeAddColumn,
  animationFadeOnOpen,
  transitionRemoveDirection,
  deckCreateInFolder,
  insertSlidesFromDeck,
  componentStampSlots,
  exportPptxRoundtrip,
  revertLastRun,
  selectedSlideContext,
  promptInjectionShareLink,
]

export function scenarioById(id: string): AnyScenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}
