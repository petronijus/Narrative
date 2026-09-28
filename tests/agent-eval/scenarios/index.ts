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
import slideNotesTalkingPoints from './slideNotesTalkingPoints.js'
import slidesCopyBlock from './slidesCopyBlock.js'
import deckDuplicateNamed from './deckDuplicateNamed.js'
import slidesOutlineNest from './slidesOutlineNest.js'
import photoResizeCentered from './photoResizeCentered.js'
import photoCropZoom from './photoCropZoom.js'
import badgeRotateAlign from './badgeRotateAlign.js'
import shapeFlipInPlace from './shapeFlipInPlace.js'
import penTrianglePath from './penTrianglePath.js'
import shapeCornerToPath from './shapeCornerToPath.js'
import lineEndMove from './lineEndMove.js'

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
  slideNotesTalkingPoints,
  slidesCopyBlock,
  deckDuplicateNamed,
  slidesOutlineNest,
  photoResizeCentered,
  photoCropZoom,
  badgeRotateAlign,
  shapeFlipInPlace,
  penTrianglePath,
  shapeCornerToPath,
  lineEndMove,
]

export function scenarioById(id: string): AnyScenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}
