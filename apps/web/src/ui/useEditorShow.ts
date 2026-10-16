/**
 * ui/useEditorShow.ts
 *
 * The editor's side of `editor.show` (agentic A1, plan §4.5): an agent
 * points this user's open editor at a slide and some objects. The editor
 * switches to the slide, selects the objects and flashes an outline around
 * them for a moment. UI state only — the document is never written.
 *
 * Order of operations, and why:
 *   1. The slide must exist in the live document; otherwise the message is
 *      stale (deleted since the agent looked) and is dropped.
 *   2. If the user is in a modal edit — typing in a text box, cropping,
 *      editing path points or a table cell — nothing moves under them.
 *      The request is parked and a notice offers to go there ("Show"); only
 *      that click leaves the edit mode (the same exits Escape / a canvas
 *      click use) and applies it. Yanking the caret out of a sentence
 *      because an agent spoke is the unsafe choice.
 *   3. Otherwise switch the slide, then select once the objects snapshot
 *      (rAF-batched, per active slide) contains the objects. Selecting
 *      earlier would race EditorLayout's stale-selection prune, which judges
 *      a selection against the first snapshot taken after it — possibly one
 *      of the slide being left. Ids that no longer exist are dropped.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { listSlides } from '@narrative/slide-model'
import type { EditorShowMessage } from '@narrative/commands'
import { useEditorShowMessages } from '../state/editorShow.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSelection } from '../state/SelectionContext.js'
import { useTextEdit } from '../state/TextEditContext.js'
import { useCropMode } from '../state/CropModeContext.js'
import { usePathPointsMode } from '../state/PathPointsModeContext.js'
import { useTableEdit } from '../state/TableEditContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useAwareness } from '../state/useAwareness.js'

/** How long the highlight outline stays up once it is drawn. */
export const SHOW_HIGHLIGHT_MS = 2_000
/**
 * How long a highlight may wait to be drawn at all. The overlay starts its
 * SHOW_HIGHLIGHT_MS once the objects are on the canvas — right after a
 * slide switch the reconciler can lag, and on a tab that is still loading
 * Pixi itself may not be up for a few seconds. Past this, drop it.
 */
const HIGHLIGHT_WAIT_MS = 10_000
/** Give up selecting if the objects snapshot has not caught up by then. */
const RESOLVE_TIMEOUT_MS = 3_000
/** A parked request the user ignores goes away on its own. */
const PENDING_TIMEOUT_MS = 20_000

export interface ShowHighlight {
  /** Changes on every show, so a repeated show restarts the animation. */
  token: number
  objectIds: string[]
  /** The agent peer's colour, when the agent is present in awareness. */
  color: string | null
}

export interface PendingShow {
  message: EditorShowMessage
  /** Who asked, e.g. "Claude (MCP)"; "An agent" when unknown. */
  requester: string
  /** 1-based position of the slide in the deck, for the notice. */
  slideNumber: number
}

export interface EditorShowState {
  highlight: ShowHighlight | null
  /** The overlay calls this when the highlight with `token` has run its course. */
  endHighlight: (token: number) => void
  pending: PendingShow | null
  /** Leave the current edit mode and apply the parked request. */
  acceptPending: () => void
  dismissPending: () => void
}

interface Target {
  token: number
  slideId: string
  objectIds: string[]
  color: string | null
  startedAt: number
}

export function useEditorShow(): EditorShowState {
  const { deckCtx } = useSlideDoc()
  const { activeSlideId, setActiveSlideId } = useActiveSlide()
  const { selectMany, clear } = useSelection()
  const { editingId: editingTextId, endEdit: endTextEdit } = useTextEdit()
  const { cropImageId, exitCrop } = useCropMode()
  const { pathPointsId, exitPathPoints } = usePathPointsMode()
  const { active: activeTableCell, endEdit: endTableCellEdit } = useTableEdit()
  const { objects } = useSlideObjects()
  const { remotePeers } = useAwareness()

  const [target, setTarget] = useState<Target | null>(null)
  const [highlight, setHighlight] = useState<ShowHighlight | null>(null)
  const [pending, setPending] = useState<PendingShow | null>(null)
  const tokenRef = useRef(0)

  const inModalEdit =
    editingTextId !== null ||
    cropImageId !== null ||
    pathPointsId !== null ||
    activeTableCell?.editing === true

  const agentPeerOf = useCallback(
    (runId: string | undefined) =>
      runId === undefined ? undefined : remotePeers.find((p) => p.state.agent?.runId === runId),
    [remotePeers],
  )

  const apply = useCallback(
    (message: EditorShowMessage) => {
      tokenRef.current += 1
      setTarget({
        token: tokenRef.current,
        slideId: message.slideId,
        objectIds: message.objectIds,
        color: agentPeerOf(message.runId)?.state.user.color ?? null,
        startedAt: Date.now(),
      })
      setActiveSlideId(message.slideId)
    },
    [agentPeerOf, setActiveSlideId],
  )

  useEditorShowMessages((message) => {
    const slideIndex = listSlides(deckCtx).findIndex((s) => s.id === message.slideId)
    if (slideIndex === -1) return
    if (inModalEdit) {
      setPending({
        message,
        requester: agentPeerOf(message.runId)?.state.user.name ?? 'An agent',
        slideNumber: slideIndex + 1,
      })
      return
    }
    setPending(null)
    apply(message)
  })

  // 3. Resolve the selection once this slide's objects snapshot has them.
  //    This effect is the synchronisation point with that snapshot (it
  //    arrives from a Yjs subscription, rAF-batched), hence state updates
  //    from inside it.
  //    A target a newer `editor.show` replaced is left alone: two shows a
  //    few ms apart reach this effect only after the second one's apply()
  //    queued its own target, and resolving the first here would clear it.
  useEffect(() => {
    if (target === null || target.token !== tokenRef.current) return
    if (activeSlideId !== target.slideId) return
    const slide = listSlides(deckCtx).find((s) => s.id === target.slideId)
    // The slide vanished mid-switch: nothing to select.
    const wanted =
      slide === undefined
        ? []
        : target.objectIds.filter((id) => slide.objects.some((o) => o.id === id))
    const inSnapshot = new Set(objects.map((o) => o.id))
    if (slide !== undefined && !wanted.every((id) => inSnapshot.has(id))) return
    if (wanted.length > 0) selectMany(wanted)
    else if (slide !== undefined) clear()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above: resolves against the snapshot
    setTarget((current) => (current?.token === target.token ? null : current))
    setHighlight(
      wanted.length > 0 ? { token: target.token, objectIds: wanted, color: target.color } : null,
    )
  }, [target, activeSlideId, objects, deckCtx, selectMany, clear])

  // Drop a target that never resolves (the slide switch was refused, or the
  // snapshot never caught up) instead of selecting at some surprising later
  // moment.
  useEffect(() => {
    if (target === null) return
    const remaining = RESOLVE_TIMEOUT_MS - (Date.now() - target.startedAt)
    const t = setTimeout(
      () => setTarget((current) => (current?.token === target.token ? null : current)),
      Math.max(0, remaining),
    )
    return () => clearTimeout(t)
  }, [target])

  // Safety cap only: the overlay ends the highlight SHOW_HIGHLIGHT_MS after
  // drawing it; this covers objects that never get drawn.
  useEffect(() => {
    if (highlight === null) return
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_WAIT_MS + SHOW_HIGHLIGHT_MS)
    return () => clearTimeout(t)
  }, [highlight])

  const endHighlight = useCallback((token: number) => {
    setHighlight((current) => (current?.token === token ? null : current))
  }, [])

  useEffect(() => {
    if (pending === null) return
    const t = setTimeout(() => setPending(null), PENDING_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [pending])

  const acceptPending = useCallback(() => {
    if (pending === null) return
    if (editingTextId !== null) endTextEdit()
    if (cropImageId !== null) exitCrop()
    if (pathPointsId !== null) exitPathPoints()
    if (activeTableCell?.editing === true) endTableCellEdit()
    setPending(null)
    // Re-check: the slide may have been deleted while the notice was up.
    if (listSlides(deckCtx).some((s) => s.id === pending.message.slideId)) apply(pending.message)
  }, [
    pending,
    editingTextId,
    endTextEdit,
    cropImageId,
    exitCrop,
    pathPointsId,
    exitPathPoints,
    activeTableCell,
    endTableCellEdit,
    deckCtx,
    apply,
  ])

  const dismissPending = useCallback(() => setPending(null), [])

  return { highlight, endHighlight, pending, acceptPending, dismissPending }
}
