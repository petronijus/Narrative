/**
 * state/browserSlideExport.ts — "Export as PNG" in the editor, rendered in
 * this browser.
 *
 * The editor already has everything a slide needs — the renderer, the deck's
 * fonts and pictures in the browser cache, the session — so it renders the
 * PNG itself instead of asking the render worker (seconds of queue and page
 * load on the server). It does so in a hidden same-origin frame running the
 * render page (pages/DeckRender.tsx), the very page the worker screenshots:
 * the same pixels, without touching the editor's own canvas (its own window,
 * its own Pixi and renderer singletons, no presence in the deck).
 *
 * The frame stays open for the deck between exports and switches slides in
 * place, so a second export takes a fraction of a second; it closes after
 * `IDLE_MS` without one, and when the editor moves to another deck. Exports
 * run one at a time.
 */

import type * as Y from 'yjs'
import { encodeStateVectorBase64 } from '../lib/stateVector.js'

/** The frame closes this long after its last export. */
const IDLE_MS = 120_000
/** The page must report the slide ready within this (a cold frame loads the app). */
const READY_TIMEOUT_MS = 60_000
const POLL_MS = 50

/** The page refused the slide for a reason of its own (it is gone, access ended…). */
export class SlideRenderRefused extends Error {
  constructor(readonly reason: string) {
    super(`the slide cannot be rendered (${reason})`)
  }
}

type RenderWindow = Window & {
  __narrativeRender?:
    | { status: 'loading' }
    | { status: 'ready'; slideId: string }
    | { status: 'error'; reason: string; slideId?: string }
  __narrativeRenderShow?: (slide: string) => void
  __narrativeRenderCapture?: (opts?: { stateVector?: string }) => Promise<Blob>
}

interface Frame {
  deckId: string
  iframe: HTMLIFrameElement
  idleTimer: ReturnType<typeof setTimeout> | null
}

let frame: Frame | null = null
let queue: Promise<unknown> = Promise.resolve()

function openFrame(deckId: string, slideId: string): Frame {
  const iframe = document.createElement('iframe')
  iframe.title = 'Slide export'
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  iframe.inert = true
  // In the viewport at the slide's size (a frame scrolled out of view may be
  // throttled), invisible and out of the way.
  Object.assign(iframe.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '1920px',
    height: '1080px',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '-1',
  })
  iframe.src = `/deck/${encodeURIComponent(deckId)}/render?slide=${encodeURIComponent(slideId)}`
  document.body.appendChild(iframe)
  return { deckId, iframe, idleTimer: null }
}

/** Close the hidden frame now (the editor leaves the deck, or a frame went wrong). */
export function closeBrowserSlideExport(): void {
  if (frame === null) return
  if (frame.idleTimer !== null) clearTimeout(frame.idleTimer)
  frame.iframe.remove()
  frame = null
}

/** Until the frame's page reports `slideId` ready; a refusal of the page's own rejects at once. */
async function untilReady(target: Frame, slideId: string): Promise<RenderWindow> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const win = target.iframe.contentWindow as RenderWindow | null
    const status = win?.__narrativeRender
    if (win !== null && status !== undefined) {
      if (status.status === 'ready' && status.slideId === slideId) return win
      if (status.status === 'error') throw new SlideRenderRefused(status.reason)
    }
    if (Date.now() >= deadline) throw new Error('the slide did not finish loading in time')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

async function exportOne(args: { deckId: string; slideId: string; doc: Y.Doc }): Promise<Blob> {
  if (frame !== null && frame.deckId !== args.deckId) closeBrowserSlideExport()
  let target = frame
  if (target === null) {
    target = openFrame(args.deckId, args.slideId)
    frame = target
  } else {
    if (target.idleTimer !== null) clearTimeout(target.idleTimer)
    target.idleTimer = null
    const show = (target.iframe.contentWindow as RenderWindow | null)?.__narrativeRenderShow
    if (show === undefined) {
      // The page went away (navigated, crashed): start over.
      closeBrowserSlideExport()
      target = openFrame(args.deckId, args.slideId)
      frame = target
    } else {
      show(args.slideId)
    }
  }
  try {
    const win = await untilReady(target, args.slideId)
    const capture = win.__narrativeRenderCapture
    if (capture === undefined) throw new Error('the render page cannot capture')
    return await capture({ stateVector: encodeStateVectorBase64(args.doc) })
  } catch (err) {
    // A frame in an unknown state is not reused.
    if (frame === target) closeBrowserSlideExport()
    throw err
  } finally {
    if (frame === target) {
      target.idleTimer = setTimeout(closeBrowserSlideExport, IDLE_MS)
    }
  }
}

/**
 * The slide as a PNG (1920×1080) exactly as the editor shows it, rendered in
 * this browser. `doc` is the editor's deck document: the picture includes
 * every edit it holds at the moment of asking.
 */
export function exportSlidePngInBrowser(args: {
  deckId: string
  slideId: string
  doc: Y.Doc
}): Promise<Blob> {
  const run = queue.then(
    () => exportOne(args),
    () => exportOne(args),
  )
  queue = run.catch(() => undefined)
  return run
}
