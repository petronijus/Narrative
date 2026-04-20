# M11 Phase 3 — Drag-and-drop uploads + progress UI

**Agent:** editor-ui  
**Date:** 2026-04-20  
**Branch:** main  
**Status:** Complete

## Deliverables

### New files

| File                                          | Purpose                                        |
| --------------------------------------------- | ---------------------------------------------- |
| `apps/web/src/state/useMediaUpload.tsx`       | Core upload hook + context provider            |
| `apps/web/src/ui/UploadProgressCard.tsx`      | Per-upload progress card + UploadProgressStack |
| `apps/web/src/ui/UploadDropZone.tsx`          | Canvas drag-and-drop overlay                   |
| `apps/web/src/state/useMediaUpload.test.tsx`  | 11 tests for the hook lifecycle                |
| `apps/web/src/ui/UploadProgressCard.test.tsx` | 13 tests for the card + stack                  |
| `apps/web/src/ui/UploadDropZone.test.tsx`     | 7 tests for drag events + drop handling        |

### Modified files

| File                                       | Change                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `apps/web/package.json`                    | Added `tus-js-client ^4.3.1` + `nanoid ^5.0.7`                                                     |
| `apps/web/src/components/DeckShell.tsx`    | Wrapped children in `<MediaUploadProvider deckId={id}>`                                            |
| `apps/web/src/components/EditorLayout.tsx` | Mounted `<UploadDropZone>` inside canvas container; mounted `<UploadProgressStack>` at editor root |
| `apps/web/src/ui/Toolbar.tsx`              | Added "Insert image" button + file picker + keyboard shortcut `I`                                  |
| `apps/web/src/ui/Toolbar.test.tsx`         | Added mocks for useMediaUpload, useSlideObjects, @narrative/slide-model                            |

## Architecture

### useMediaUpload (MediaUploadContext)

Mounted in `DeckShell` — survives editor ↔ present navigation (upload state preserved). State is pure React (`useState` Map of `UploadEntry`). Two parallel Ref maps hold tus.Upload instances (for abort) and File references (for retry).

Upload flow:

1. Client-side MIME check (`image/*` only — immediate error for anything else)
2. `createImageBitmap(file)` probe for width/height (best-effort; server re-probes)
3. `new tus.Upload(file, { endpoint, metadata, headers })` — 5 MB chunks
4. `onAfterResponse` reads `X-Narrative-Asset-Id`, `X-Narrative-Width`, `X-Narrative-Height` headers from the final PATCH response
5. `onSuccess` → status='done', fires `onDone` callback
6. `onError` → status='error'
7. Cancel: `tus.Upload.abort(true)` + status='cancelled'
8. Retry: re-creates tus instance from stored File ref

### UploadDropZone

Absolute-positioned transparent overlay inside the canvas container div. Uses `dragDepth` counter to avoid flicker from enter/leave on child elements. On drop, filters non-image files silently and calls `startUpload(file, { onDone: addImageObject })` for each image. Drop coordinates are computed via `clientToCanvasCoords` (mirrors EditorLayout helper — when zoom/pan lands, both need updating).

For viewer role: renders as `pointer-events-none` with no event handlers.

### Toolbar — Insert Image

Hidden file picker (`<input type="file" accept="image/*" multiple>`) triggered by visible button or `I` shortcut. On file selection, calls `startUpload` with `onDone` that calls `createObjectOfType(ctx, 'image', ...)` placing the image at slide centre (960, 540 minus half image dimensions).

### UploadProgressStack

Fixed bottom-right, z-50. One `UploadProgressCard` per entry. Done cards auto-dismiss after 2 s via `setTimeout`. Only active cards block pointer events.

## UX Decisions

- **Drop zone scope**: entire canvas container (not just the slide rect). Simpler hit-testing; consistent with other tools.
- **Progress card placement**: fixed bottom-right, stacks upward. Not inside a portal — just `fixed` positioning at editor shell level.
- **Cancel semantics**: `tus.Upload.abort(true)` — permanently deletes the upload from the server to free storage. If retry is needed, a new upload starts from scratch.
- **Non-image drop**: silently filtered. No toast — the server would 415 anyway, and users dragging mixed selections are common.
- **Auto-dismiss timer**: 2 s for done state. Cancelled/error require manual dismiss (so user sees the outcome).

## Dependency on renderer

The renderer agent needs to implement `ImageObject` rendering (Canvas.tsx, imageRenderer). My side creates the `ImageObject` in Yjs with `{ assetId, width, height, x, y }` — the renderer reads `assetId` and calls `GET /api/media/:assetId/url?variant=display` to get a signed imgproxy URL.

No bootstrap code needed from editor-ui for the renderer's URL resolver — renderer agent installs it in their own Canvas.tsx.

## Tests

37 test files, 439 tests — all passing. Pre-existing TS error in `imageRenderer.ts` (renderer-agent file, `exactOptionalPropertyTypes` on `variant`) was present before this milestone and is out of scope.
