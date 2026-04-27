/**
 * ui/handleVisuals.tsx
 *
 * Shared visual primitives for the editor's resize / rotation handles.
 * TransformHandles and CropOverlay both render 8 corner+edge boxes plus
 * an optional rotation circle. Until P11r they each had their own copy
 * of the styling (size, color, border-radius, inverse-zoom transform)
 * which drifted and produced subtly different chrome between the
 * default selection and the in-crop image-mode UI.
 *
 * This module owns the visual constants + a tiny `<Handle>` component.
 * Drag handlers stay where they are — both call sites still pass their
 * own `onPointerDown` because the math diverges (object x/y/w/h vs
 * imageRect x/y/w/h, and rotation around different centres).
 */

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

/** Size of resize / rotation handles in slide-space px. The component
 *  applies a 1/zoom counter-scale at render time so the on-screen size
 *  is constant regardless of artboard zoom. */
export const HANDLE_SIZE = 8

/** Distance of the rotation handle from the top edge in slide-space px,
 *  pre-counter-scale. Use with `mul = 1/zoom` to keep the on-screen gap
 *  constant. */
export const ROTATION_OFFSET = 24

export interface HandleProps {
  /** Slide-space position relative to the parent layer. */
  left: number
  top: number
  cursor: string
  shape?: 'square' | 'circle'
  /** Inverse zoom factor (1 / zoom). Counter-scales the handle so it
   *  stays at HANDLE_SIZE viewport-px regardless of the artboard's
   *  CSS scale. */
  inv: number
  ariaLabel: string
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove?: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp?: (e: ReactPointerEvent<HTMLDivElement>) => void
  /** Optional extra DOM attribute (used by tests / outside-click guard). */
  dataAttr?: { name: string; value: string }
}

export function Handle({
  left,
  top,
  cursor,
  shape = 'square',
  inv,
  ariaLabel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  dataAttr,
}: HandleProps) {
  const style: CSSProperties = {
    left,
    top,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    cursor,
    borderRadius: shape === 'circle' ? '50%' : 0,
    transform: `translate(-50%, -50%) scale(${inv})`,
    transformOrigin: 'center',
    touchAction: 'none',
    pointerEvents: 'auto',
  }
  const dataProps =
    dataAttr === undefined
      ? {}
      : ({ [`data-${dataAttr.name}`]: dataAttr.value } as Record<string, string>)
  return (
    <div
      role="button"
      aria-label={ariaLabel}
      tabIndex={-1}
      className="absolute box-border border-2 border-blue-400 bg-white"
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      {...dataProps}
    />
  )
}
