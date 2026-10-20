/**
 * slide-model/src/builtinObjectTypes.ts — the object types every document
 * knows, as data: the registry (`registry.ts`) starts with them.
 *
 * They used to be registered by top-level calls in the package's barrel
 * (`index.ts`), so the barrel had side effects and every importer kept the
 * whole package — the app's login page took Yjs and the slide model for one
 * CSS helper (docs/plans/performance.md → L1, 2026-10-18). As data the
 * package is side-effect free (`"sideEffects": false` in package.json).
 *
 * Read the table defaults only inside `defaultProps`: `tableMutations.ts`
 * reaches the registry through `mutations.ts`, so at this module's
 * evaluation they may not be initialised yet.
 */

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
  SlideObject,
} from '@narrative/shared'
import type { ObjectTypeDef } from './registry.js'
import { DEFAULT_TABLE_DEFAULTS, DEFAULT_TABLE_COLS, DEFAULT_TABLE_ROWS } from './tableMutations.js'

/** One type's definition, checked against its object type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the list holds every variant
const def = <T extends SlideObject>(d: ObjectTypeDef<T>): ObjectTypeDef<any> => d

export const BUILTIN_OBJECT_TYPES: readonly ObjectTypeDef[] = [
  def<RectangleObject>({
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
  }),
  def<EllipseObject>({
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
  }),
  def<TriangleObject>({
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
  }),
  def<PolygonObject>({
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
  }),
  def<LineObject>({
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
  }),
  def<ArrowObject>({
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
  }),
  def<PathObject>({
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
  }),
  def<TextObject>({
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
  }),
  /**
   * Image object type.
   * NOTE: callers MUST provide assetId via createObjectOfType overrides after a successful upload.
   * Creating an image object without assetId yields a broken placeholder — intentional for M11.
   * Editor-ui calls createObjectOfType('image', { assetId, width, height }) on upload completion.
   */
  def<ImageObject>({
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
  }),
  /**
   * Video object type.
   * NOTE: callers MUST provide assetId via createObjectOfType overrides after upload.
   * Creating a video object without assetId yields a broken placeholder — upload and transcode pending.
   * Media agent phase 2 sets kind='video', transcode_status='pending' on finalize.
   * Editor-ui calls createObjectOfType('video', { assetId }) once the upload completes.
   * The renderer must check transcodeStatus via /api/media/:id/video-info before playback.
   */
  def<VideoObject>({
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
  }),
  /**
   * Table object type (M29). Default rows/cols/styling sourced from
   * `tableMutations.ts` so `addTable` and `createObjectOfType('table')`
   * produce structurally identical tables. Toolbar uses click-to-place →
   * `createObjectOfType('table', { x, y, width, height })`; drag-to-size
   * fills the same overrides with the dragged bbox.
   */
  def<TableObject>({
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
  }),
]
