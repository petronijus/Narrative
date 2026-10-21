/**
 * @narrative/slide-model — public API
 *
 * Single import point for all state/Yjs operations.
 * Renderer and editor-ui must not import Y.Doc directly —
 * everything goes through this API (see ADR-0003).
 */

// Registry
export { registerObjectType, getObjectTypeDef, listRegisteredTypes } from './registry.js'
export type { ObjectTypeDef } from './registry.js'

// Y.Doc factory (M9: multi-slide schema)
export { createSlideDoc, hydrateSlideDoc } from './yDoc.js'
export type { SlideDocHandles } from './yDoc.js'

// Mutations — objects
export {
  LOCAL_ORIGIN,
  addObject,
  addObjects,
  removeObject,
  updateObject,
  createObjectOfType,
  duplicateObjects,
  copyObjectsTo,
  translateObjects,
  bulkUpdateObjects,
  moveObjectsLayer,
  moveObjectToIndex,
  alignObjects,
  distributeObjects,
  groupObjects,
  ungroupObjects,
  getGroupMembers,
  spliceRichText,
  replaceObject,
} from './mutations.js'
export type {
  ObjectsMutationContext,
  /** @deprecated Use ObjectsMutationContext */
  MutationContext,
  BulkUpdate,
  ObjectTranslation,
  LayerMove,
  AlignAxis,
  DistributeAxis,
} from './mutations.js'

// Transaction origins for non-human writers (agentic layer A0)
export { agentOrigin, releaseAgentOrigin, isAgentOrigin } from './origins.js'
export type { AgentOrigin } from './origins.js'

// Mutations — animations (M6)
export {
  addAnimation,
  removeAnimation,
  updateAnimation,
  retargetAnimation,
  reorderAnimations,
} from './animationMutations.js'
export type {
  AnimationsMutationContext,
  /** @deprecated Use AnimationsMutationContext */
  AnimationMutationContext,
} from './animationMutations.js'

// Deck-level mutation context (M9)
export type { SlideMutationContext, DeckMutationContext } from './slideMutationContext.js'

// Slide CRUD + scoped context accessors (M9)
export {
  addSlide,
  duplicateSlide,
  removeSlide,
  moveSlide,
  moveSlidesBlock,
  updateSlideTransition,
  updateSlideBackground,
  setSlideName,
  setSlideSkipped,
  setSlideIndent,
  setSlideCollapsed,
  setSlideLayout,
  readSlideLayout,
  setSlideBrief,
  setSlideSpecKey,
  readSlideBrief,
  readSlideMeta,
  listSlides,
  getSlideObjectsCtx,
  getSlideAnimationsCtx,
  getSlideNotesFragment,
} from './slides.js'
export type { SlideMeta } from './slides.js'

// Slide-level primitives for the command layer (agentic layer A0)
export { clearSlideTransitionDirection, getSlideNotesText } from './slideMeta.js'
export {
  NOTES_LINK_DEFAULTS,
  getSlideNotesDoc,
  isNotesText,
  notesFromFragment,
  setSlideNotes,
} from './notes.js'
export type { NotesDoc, NotesElement, NotesMarks, NotesNode, NotesText } from './notes.js'

// P11: deck-level rulers + guides
export {
  getDeckGuidesCtx,
  listDeckGuides,
  addGuide,
  updateGuide,
  removeGuide,
  subscribeToDeckGuides,
} from './deckGuides.js'
export type { DeckGuidesContext } from './deckGuides.js'

// Bindings — objects
export { yMapToPlainObject, plainObjectToYMap, collectPendingCellTextInserts } from './bindings.js'
export type { PendingCellTextInsert } from './bindings.js'

// M29 table mutations
export {
  addTable,
  buildTable,
  insertTableRow,
  insertTableCol,
  deleteTableRow,
  deleteTableCol,
  getTableCellYMap,
  setTableCellStyle,
  setTableDefaultsPatch,
  setTableColWidth,
  setTableRowHeight,
  mergeTableCells,
  splitTableCell,
  setRangeCellStyle,
  setRangeBorderPreset,
  setTableBorderSegment,
  edgesForPreset,
  segmentsForPreset,
  getTableMergeInfo,
  DEFAULT_TABLE_DEFAULTS,
  DEFAULT_TABLE_ROWS,
  DEFAULT_TABLE_COLS,
} from './tableMutations.js'
export type {
  AddTableOpts,
  CellStylePatch,
  TableBorderPreset,
  TableCellEdge,
} from './tableMutations.js'

// Rich-text helpers (P15+) — Y.Text ↔ delta ↔ HTML
export {
  createTextValue,
  getPlainString,
  richAttrsAtIndex,
  applyFormat,
  clearFormat,
  toDelta,
  toHtml,
  sanitizeFontFamily,
  PARAGRAPH_SEP,
  getParagraphs,
  getParagraphDeltas,
  updateParagraphsInRange,
  applyParagraphPatch,
  toggleListKind,
  indentParagraphs,
  splitParagraphAt,
  readParagraphAttrsForRange,
  computeMarkers,
  formatListNumber,
  defaultBulletGlyph,
  buildListedHtml,
  paragraphFontSizePx,
  paragraphFrameSizePx,
  effectiveParagraphAttrs,
  plainListValue,
  blockAttrsToInsertAttrs,
} from './richText.js'
export type {
  RichAttrs,
  RichDeltaOp,
  HtmlDefaults,
  ParagraphInfo,
  ParagraphDelta,
  ParagraphPatch,
  ListedHtmlOptions,
  ListLevelDefaults,
  ListLevelLook,
} from './richText.js'
export { CSS_GENERIC_FAMILIES, fontFamilyNames, quoteCssFamilyName } from './cssFontFamily.js'

// Bindings — animations (M6)
export {
  yMapToAnimationStep,
  animationStepToYMap,
  animationStepToYMapInDoc,
} from './animationBindings.js'

// Undo
export {
  beginUndoGesture,
  createUndoManager,
  endUndoGesture,
  UNDO_CAPTURE_TIMEOUT_MS,
  undoScope,
} from './undo.js'

// Component helpers (M16 P5)
export {
  promoteToComponent,
  getComponentDocName,
  pruneAnimationsToScope,
  richTextOpsOf,
  RICH_TEXT_OPS_KEY,
} from './components.js'
export type { PromoteToComponentPlan, RichTextOp, RichTextOps } from './components.js'

// Component stamp helper (refactor: components-as-stamps)
export {
  stampComponent,
  insertObjectsWithRichText,
  writeComponentMaster,
  readMasterOrigin,
  replaceMasterObjects,
  COMPONENT_MASTER_SLIDE_ID,
} from './stampComponent.js'

// Component restamp and provenance (A4.1)
export { restampComponent, slotNameOf } from './restampComponent.js'
export type { RestampedStamp, RestampSlideResult } from './restampComponent.js'
export { freshStampInstances, withStampInstance } from './mutations.js'

// Shape-as-image-mask mutation (moved out of apps/web — mutations live here)
export {
  applyShapeMask,
  isMaskableShape,
  buildMaskFromShape,
  computeMaskedImagePatch,
} from './shapeMask.js'
export type { MaskableShape } from './shapeMask.js'

// Style pack in the folder document (A4.3)
export {
  readStylePack,
  hasStylePack,
  setStylePack,
  deleteStylePack,
  patchStylePack,
  mergeStylePackPatch,
} from './folderPack.js'

// Deck meta (A4.2d)
export {
  readDeckMeta,
  readDeckSpec,
  setDeckMeta,
  setDeckSpec,
  subscribeDeckMeta,
} from './deckMeta.js'
export type { DeckMetaPatch } from './deckMeta.js'

// Design tokens (M16 P2)
export { rewriteTokenRefs, type TokenRefRewrite } from './tokenRefs.js'
export {
  isTokenRef,
  resolveTokenValue,
  colorTokenValue,
  isContextualColor,
  parseHexColor,
} from './tokens.js'
export type {
  TokenRef,
  TokenOrigin,
  TokenResolveContext,
  ColorTokenSnapshot,
  TextStyleTokenSnapshot,
  TextStyleLevel,
  EffectStyleTokenSnapshot,
  FolderTokensSnapshot,
} from './tokens.js'

// Folder token document (A2.12)
export {
  TOKEN_CATEGORIES,
  addFolderToken,
  deleteFolderToken,
  hasNoTokens,
  migrateFolderTokens,
  readFolderTokens,
  seedDefaultTokens,
  updateFolderToken,
  type TokenCategory,
} from './folderDoc.js'
export { DEFAULT_COLORS, DEFAULT_TEXT_STYLES, MAX_COLORS } from './defaultTokens.js'
export type { DefaultColor, DefaultTextStyle } from './defaultTokens.js'

// Token usage scanner (M16 P4)
export { scanDeckDoc, scanComponentDoc, scanFolderDoc } from './scanTokenUsages.js'
export type {
  UsageEntry,
  DeckUsageEntry,
  ComponentUsageEntry,
  TextStyleUsageEntry,
} from './scanTokenUsages.js'

// Awareness helpers (M8)
export { generatePeerId, toPeerInfo, peerColorFromId } from './awareness.js'

// Observer — slides (M9)
export {
  subscribeToSlides,
  subscribeToSlideObjects,
  subscribeToSlideObjectsWithFlush,
  subscribeToSlideAnimations,
  subscribeToDeckSlideEvents,
} from './slideObserve.js'
export type { SlideSummary, ObjectChangeSet } from './slideObserve.js'

// Shared, structurally shared read model of a deck (performance.md → E1)
export { getDeckStore, createDeckStore } from './deckStore.js'
export type { DeckStore } from './deckStore.js'
