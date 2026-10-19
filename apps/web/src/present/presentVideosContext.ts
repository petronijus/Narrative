/**
 * present/presentVideosContext.ts — present mode hands its slides' video
 * previews the videos it buffered before the presentation started
 * (renderer/presentVideos.ts): EditorVideoPreview plays the pooled element
 * instead of loading one of its own, and says when its slide left the stage
 * (`released`), so the video goes back to its first frame.
 */

import { createContext, useContext } from 'react'
import type { PresentVideoPool } from '../renderer/presentVideos.js'

export interface PresentVideosValue {
  pool: PresentVideoPool
  /** The video's slide left the stage: pause it and put it back on its first frame. */
  released(objectId: string): void
}

export const PresentVideosContext = createContext<PresentVideosValue | null>(null)

/** The present-mode video pool, or null outside present mode. */
export function usePresentVideos(): PresentVideosValue | null {
  return useContext(PresentVideosContext)
}
