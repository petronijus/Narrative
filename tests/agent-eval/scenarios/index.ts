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
import componentPromoteHeadline from './componentPromoteHeadline.js'
import componentMasterPicture from './componentMasterPicture.js'
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
import objectsCopyToSlide from './objectsCopyToSlide.js'
import objectsFromOtherDeck from './objectsFromOtherDeck.js'
import objectsRecreateFromJson from './objectsRecreateFromJson.js'
import localLogoUpload from './localLogoUpload.js'
import badgeGradient from './badgeGradient.js'
import cardSoftShadow from './cardSoftShadow.js'
import footerPageNumber from './footerPageNumber.js'
import agendaStepTiming from './agendaStepTiming.js'
import photoAnimationsHandOver from './photoAnimationsHandOver.js'
import tableResizeRecolour from './tableResizeRecolour.js'
import tableHeaderGradient from './tableHeaderGradient.js'
import productRenameEverywhere from './productRenameEverywhere.js'
import subtitlePlainRestyle from './subtitlePlainRestyle.js'
import yearFixSecondOccurrence from './yearFixSecondOccurrence.js'
import folderStylesApply from './folderStylesApply.js'
import titleStyleFolderwide from './titleStyleFolderwide.js'
import quoteStyleFromBox from './quoteStyleFromBox.js'

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
  componentPromoteHeadline,
  componentMasterPicture,
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
  objectsCopyToSlide,
  objectsFromOtherDeck,
  objectsRecreateFromJson,
  localLogoUpload,
  badgeGradient,
  cardSoftShadow,
  footerPageNumber,
  agendaStepTiming,
  photoAnimationsHandOver,
  tableResizeRecolour,
  tableHeaderGradient,
  productRenameEverywhere,
  subtitlePlainRestyle,
  yearFixSecondOccurrence,
  folderStylesApply,
  titleStyleFolderwide,
  quoteStyleFromBox,
]

export function scenarioById(id: string): AnyScenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}
