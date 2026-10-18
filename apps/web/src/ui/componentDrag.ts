/**
 * ui/componentDrag.ts — the drag-and-drop payload of a component dragged
 * out of the component picker onto the canvas.
 *
 * Its own module: the canvas drop target (UploadDropZone) needs the MIME
 * type at first paint, the picker drawer is loaded on its first open
 * (ui/lazyEditorParts.tsx).
 */

/**
 * Custom MIME type used by the drawer's drag-out and the canvas drop-target.
 * Distinct from `text/*` so the existing image / text-paste handlers don't
 * accidentally match component drags.
 */
export const COMPONENT_DRAG_MIME = 'application/x-narrative-component'

export interface ComponentDragPayload {
  componentId: string
}
