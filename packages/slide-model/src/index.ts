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
  listSlides,
  getSlideObjectsCtx,
  getSlideAnimationsCtx,
  getSlideNotesFragment,
} from './slides.js'

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
  readParagraphAttrsForRange,
  computeMarkers,
  formatListNumber,
  defaultBulletGlyph,
  buildListedHtml,
  paragraphFontSizePx,
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
} from './richText.js'

// Bindings — animations (M6)
export {
  yMapToAnimationStep,
  animationStepToYMap,
  animationStepToYMapInDoc,
} from './animationBindings.js'

// Undo
export { createUndoManager } from './undo.js'

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
export { stampComponent, insertObjectsWithRichText } from './stampComponent.js'

// Shape-as-image-mask mutation (moved out of apps/web — mutations live here)
export {
  applyShapeMask,
  isMaskableShape,
  buildMaskFromShape,
  computeMaskedImagePatch,
} from './shapeMask.js'
export type { MaskableShape } from './shapeMask.js'

// Design tokens (M16 P2)
export { isTokenRef, resolveTokenValue } from './tokens.js'
export type {
  TokenRef,
  ColorTokenSnapshot,
  TextStyleTokenSnapshot,
  EffectStyleTokenSnapshot,
  FolderTokensSnapshot,
} from './tokens.js'

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

// ---------------------------------------------------------------------------
// Builtin object type registrations
// ---------------------------------------------------------------------------
// Importing this module (index) guarantees builtin types are registered.

import { registerObjectType } from './registry.js'
import type {
  RectangleObject,
  EllipseObject,
  TriangleObject,
  PolygonObject,
  LineObject,
  ArrowObject,
  PathObject,
  TextObject,
  ImageObject,
  VideoObject,
  TableObject,
} from '@narrative/shared'
import { DEFAULT_TABLE_DEFAULTS, DEFAULT_TABLE_COLS, DEFAULT_TABLE_ROWS } from './tableMutations.js'

registerObjectType<RectangleObject>({
  type: 'rectangle',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 200,
    height: 150,
    fill: 0x4060e0,
    rotation: 0,
    opacity: 1,
  }),
})

registerObjectType<EllipseObject>({
  type: 'ellipse',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 180,
    height: 180,
    fill: 0xe06040,
    rotation: 0,
    opacity: 1,
  }),
})

registerObjectType<TriangleObject>({
  type: 'triangle',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 180,
    height: 160,
    fill: 0x40b060,
    rotation: 0,
    opacity: 1,
  }),
})

registerObjectType<PolygonObject>({
  type: 'polygon',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 180,
    height: 180,
    fill: 0xe0a040,
    rotation: 0,
    opacity: 1,
    sides: 5,
  }),
})

registerObjectType<LineObject>({
  type: 'line',
  defaultProps: () => ({
    x: 100,
    y: 200,
    width: 200,
    height: 0,
    rotation: 0,
    opacity: 1,
    stroke: 0x111111,
    strokeWidth: 3,
    p1: { x: 0, y: 0 },
    p2: { x: 200, y: 0 },
    startCap: 'none',
    endCap: 'none',
  }),
})

registerObjectType<ArrowObject>({
  type: 'arrow',
  defaultProps: () => ({
    x: 100,
    y: 200,
    width: 200,
    height: 0,
    rotation: 0,
    opacity: 1,
    stroke: 0x111111,
    strokeWidth: 3,
    p1: { x: 0, y: 0 },
    p2: { x: 200, y: 0 },
    startCap: 'none',
    endCap: 'arrow',
  }),
})

registerObjectType<PathObject>({
  type: 'path',
  defaultProps: () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    opacity: 1,
    stroke: 0x111111,
    strokeWidth: 3,
    anchors: [],
  }),
})

registerObjectType<TextObject>({
  type: 'text',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 240,
    height: 40,
    text: 'Text',
    fontSize: 24,
    fontWeight: 'normal',
    color: 0x000000,
    align: 'left',
    rotation: 0,
    opacity: 1,
  }),
})

/**
 * Image object type.
 * NOTE: callers MUST provide assetId via createObjectOfType overrides after a successful upload.
 * Creating an image object without assetId yields a broken placeholder — intentional for M11.
 * Editor-ui calls createObjectOfType('image', { assetId, width, height }) on upload completion.
 */
registerObjectType<ImageObject>({
  type: 'image',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 400,
    height: 300,
    rotation: 0,
    opacity: 1,
    assetId: '',
    variant: 'display',
    fit: 'cover',
  }),
})

/**
 * Video object type.
 * NOTE: callers MUST provide assetId via createObjectOfType overrides after upload.
 * Creating a video object without assetId yields a broken placeholder — upload and transcode pending.
 * Media agent phase 2 sets kind='video', transcode_status='pending' on finalize.
 * Editor-ui calls createObjectOfType('video', { assetId }) once the upload completes.
 * The renderer must check transcodeStatus via /api/media/:id/video-info before playback.
 */
registerObjectType<VideoObject>({
  type: 'video',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 640,
    height: 360,
    rotation: 0,
    opacity: 1,
    assetId: '',
    fit: 'contain',
    autoplay: false,
    loop: false,
    muted: true,
    aspectLocked: true,
  }),
})
/**
 * Table object type (M29). Default rows/cols/styling sourced from
 * `tableMutations.ts` so `addTable` and `createObjectOfType('table')`
 * produce structurally identical tables. Toolbar uses click-to-place →
 * `createObjectOfType('table', { x, y, width, height })`; drag-to-size
 * fills the same overrides with the dragged bbox.
 */
registerObjectType<TableObject>({
  type: 'table',
  defaultProps: () => {
    const w = 400
    const h = 200
    const colCount = DEFAULT_TABLE_COLS
    const rowCount = DEFAULT_TABLE_ROWS
    const colW = w / colCount
    const rowH = h / rowCount
    const colWidths: number[] = []
    for (let c = 0; c < colCount; c++) colWidths.push(colW)
    const rowHeights: number[] = []
    for (let r = 0; r < rowCount; r++) rowHeights.push(rowH)
    const rows: TableObject['rows'] = []
    for (let r = 0; r < rowCount; r++) {
      const row: TableObject['rows'][number] = []
      for (let c = 0; c < colCount; c++) row.push({ text: '' })
      rows.push(row)
    }
    return {
      x: 100,
      y: 100,
      width: w,
      height: h,
      rotation: 0,
      opacity: 1,
      colWidths,
      rowHeights,
      rows,
      defaults: { ...DEFAULT_TABLE_DEFAULTS },
    }
  },
})
