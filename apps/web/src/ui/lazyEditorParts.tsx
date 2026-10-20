/**
 * ui/lazyEditorParts.tsx — the editor's parts that are not on its first
 * paint, each a chunk of its own (docs/plans/performance.md → L2).
 *
 * The EditorLayout chunk was ~100 kB gz with no `lazy()` in it: every
 * dialog, the table inspector and the crop / path / table overlays came with
 * the first paint, though each shows only after a user action. They are
 * exported here under their own names and props, so a user changes only its
 * import line; `preloadEditorParts` loads them all once the editor drew the
 * deck and settled (pages/DeckEditor.tsx), so the first crop, table click or
 * dialog does not wait for the network.
 *
 * Kept eager on purpose: what the first paint shows (canvas, toolbar,
 * inspector, slides panel, timeline) and the text editors (TextEditOverlay,
 * TableCellEditor) — they take focus on the double-click that opens them,
 * and the keys typed right after must land in them.
 */

import { lazyDialog, lazyPart } from './lazyPart.js'
import { whenEditorSettled } from './editorReady.js'

// --- canvas overlays (EditorLayout) -----------------------------------------

export const CropOverlay = lazyPart(
  () => import('./CropOverlay.js'),
  (m) => m.CropOverlay,
)
export const PathPointsOverlay = lazyPart(
  () => import('./PathPointsOverlay.js'),
  (m) => m.PathPointsOverlay,
)
export const MoveToTargetOverlay = lazyPart(
  () => import('./MoveToTargetOverlay.js'),
  (m) => m.MoveToTargetOverlay,
)
export const TableChrome = lazyPart(
  () => import('./TableChrome.js'),
  (m) => m.TableChrome,
)
export const TableBorderSelectionOverlay = lazyPart(
  () => import('./TableBorderSelectionOverlay.js'),
  (m) => m.TableBorderSelectionOverlay,
)

// --- inspector ----------------------------------------------------------------

export const TableInspector = lazyPart(
  () => import('./TableInspector.js'),
  (m) => m.TableInspector,
)
export const SlideNumberPromptDialog = lazyDialog(
  () => import('./SlideNumberPromptDialog.js'),
  (m) => m.SlideNumberPromptDialog,
)
export const FolderFontUploadDialog = lazyPart(
  () => import('./FolderFontUploadDialog.js'),
  (m) => m.FolderFontUploadDialog,
)

// --- dialogs (toolbar, context menu, shortcuts) --------------------------------

export const ShortcutsCheatsheet = lazyDialog(
  () => import('./ShortcutsCheatsheet.js'),
  (m) => m.ShortcutsCheatsheet,
)
export const PromoteComponentDialog = lazyDialog(
  () => import('./PromoteComponentDialog.js'),
  (m) => m.PromoteComponentDialog,
)
export const ShareDialog = lazyPart(
  () => import('./ShareDialog.js'),
  (m) => m.ShareDialog,
)
export const ExportPptxDialog = lazyPart(
  () => import('./ExportPptxDialog.js'),
  (m) => m.ExportPptxDialog,
)
export const ComponentPickerDrawer = lazyDialog(
  () => import('./ComponentPickerDrawer.js'),
  (m) => m.ComponentPickerDrawer,
)

const EDITOR_PARTS = [
  CropOverlay,
  PathPointsOverlay,
  MoveToTargetOverlay,
  TableChrome,
  TableBorderSelectionOverlay,
  TableInspector,
  SlideNumberPromptDialog,
  FolderFontUploadDialog,
  ShortcutsCheatsheet,
  PromoteComponentDialog,
  ShareDialog,
  ExportPptxDialog,
  ComponentPickerDrawer,
]

/** Load every part above once the editor has settled (ui/editorReady.ts); returns the cancel. */
export function preloadEditorParts(): () => void {
  return whenEditorSettled(EDITOR_PARTS)
}
