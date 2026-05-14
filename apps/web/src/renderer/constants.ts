/**
 * renderer/constants.ts
 *
 * Renderer-local re-exports of the canonical canvas dimensions.
 * The actual values live in `@narrative/shared` (canvas.ts) so server-side
 * code (pptx import/export, AI generation, headless thumbnail render) reads
 * the same numbers — keeps the artboard size in one place, forever.
 *
 * Use these everywhere SLIDE_WIDTH / SLIDE_HEIGHT are needed inside the web
 * app. Importing directly from `@narrative/shared` works too; this file
 * stays as a stable name for the renderer's many existing imports.
 */

export { SLIDE_WIDTH, SLIDE_HEIGHT } from '@narrative/shared'
