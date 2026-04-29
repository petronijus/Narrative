/**
 * ui/Inspector.tsx
 *
 * Inspector panel pro editaci properties vybraného objektu.
 *
 * Čte selectedId z SelectionContext, objekt z useSlideObjects.
 * Mutace přes updateObject(ctx, id, patch).
 *
 * Sekce:
 * - Position: X, Y
 * - Size: Width, Height
 * - Transform: Rotation (degrees), Opacity
 * - Appearance: Fill (rect/ellipse)
 * - Text: Text, Font size, Font weight, Color, Align
 *
 * No-selection state (M9):
 * - Shows slide-level inspector: transition kind / duration / direction.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  ChevronDown,
  Link2,
  Link2Off,
  Lock,
  Unlock,
  type LucideIcon,
} from 'lucide-react'
import { ColorInput } from './ColorInput.js'
import { FontFamilySelect } from './FontFamilySelect.js'
import { FontWeightSelect } from './FontWeightSelect.js'
import {
  applyInlineFormatIfSelected,
  readActiveSelectionAttrs,
  getActiveTextSelection,
  subscribeActiveTextSelection,
  refocusActiveTextEdit,
  isEntireContentSelected,
  clearActiveSelectionAttrs,
  clearAllInlineRunAttrs,
} from './textEditSelection.js'
import { useSelection } from '../state/SelectionContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useAnimations } from '../state/useAnimations.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSlides } from '../state/useSlides.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { useMediaUpload } from '../state/useMediaUpload.js'
import { useVideoInfo } from '../state/useVideoInfo.js'
import { useCropMode } from '../state/CropModeContext.js'
import { applyShapeMask, isMaskableShape } from '../state/applyShapeMask.js'
import {
  updateObject,
  addAnimation,
  removeAnimation,
  updateAnimation,
  updateSlideTransition,
  updateSlideBackground,
  alignObjects,
  distributeObjects,
  moveObjectsLayer,
  moveObjectToIndex,
  groupObjects,
  ungroupObjects,
} from '@narrative/slide-model'
import type {
  AnimationsMutationContext,
  AlignAxis,
  DistributeAxis,
  LayerMove,
} from '@narrative/slide-model'
import type {
  SlideObject,
  RectangleObject,
  EllipseObject,
  TriangleObject,
  PolygonObject,
  LineObject,
  ArrowObject,
  PathObject,
  CornerRadius,
  ShadowStyle,
  FillStyle,
  FillGradientStop,
  ImageFillStyle,
  ImageObject,
  TextObject,
  VideoObject,
  SlideObjectPatch,
  AnimationStep,
  AnimationTrigger,
  SlideTransition,
  SlideTransitionKind,
  SlidePushDirection,
  SlideBackground,
  ObjectHyperlink,
} from '@narrative/shared'
import { DEFAULT_BACKGROUND } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Číslo (hex) → #rrggbb string pro <input type="color"> */
function numberToHex(value: number): string {
  return '#' + value.toString(16).padStart(6, '0')
}

/** #rrggbb string → číslo pro Y.Doc */
function hexToNumber(hex: string): number {
  return parseInt(hex.slice(1), 16)
}

/** Radiány → stupně pro UI */
function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

/** Stupně → radiány pro Y.Doc */
function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

// ---------------------------------------------------------------------------
// Sdílené input komponenty
// ---------------------------------------------------------------------------

interface NumberFieldProps {
  id: string
  label: string
  value: number
  step?: number
  disabled?: boolean
  onChange: (value: number) => void
}

interface AlignButtonGroupProps<V extends string> {
  value: V
  onChange: (value: V) => void
  ariaLabel: string
  options: ReadonlyArray<{
    value: V
    label: string
    Icon: LucideIcon
  }>
}

function AlignButtonGroup<V extends string>({
  value,
  onChange,
  ariaLabel,
  options,
}: AlignButtonGroupProps<V>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex flex-1 items-stretch overflow-hidden rounded border border-input field-surface"
    >
      {options.map(({ value: v, label, Icon }, idx) => {
        const active = v === value
        return (
          <button
            key={v}
            type="button"
            aria-label={label}
            aria-pressed={active}
            title={label}
            onClick={() => onChange(v)}
            className={[
              'flex flex-1 items-center justify-center px-2 py-1 transition-colors',
              idx > 0 ? 'border-l border-input' : '',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            ].join(' ')}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}

function NumberField({ id, label, value, step = 1, disabled = false, onChange }: NumberFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-16 flex-shrink-0 text-xs text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="number"
        step={step}
        disabled={disabled}
        value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const parsed = parseFloat(e.target.value)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
        className={[
          'w-full rounded-md border border-input field-surface px-2 py-0.5',
          'text-right text-xs text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
        ].join(' ')}
      />
    </div>
  )
}

interface SectionProps {
  title: string
  children: React.ReactNode
  /** Persisted collapse state key. If omitted, section is always expanded. */
  storageKey?: string
  /** Initial collapsed state (ignored if `storageKey` has a stored value). */
  defaultCollapsed?: boolean
}

function Section({ title, children, storageKey, defaultCollapsed = false }: SectionProps) {
  const fullKey = storageKey === undefined ? null : `narrative:inspector:collapsed:${storageKey}`
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (fullKey === null) return false
    try {
      const raw = sessionStorage.getItem(fullKey)
      if (raw === '1') return true
      if (raw === '0') return false
    } catch {
      /* storage unavailable */
    }
    return defaultCollapsed
  })

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    if (fullKey !== null) {
      try {
        sessionStorage.setItem(fullKey, next ? '1' : '0')
      } catch {
        /* storage unavailable */
      }
    }
  }

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ${
            collapsed ? '-rotate-90' : 'rotate-0'
          }`}
          aria-hidden="true"
        />
      </button>
      <div className="collapsible" data-collapsed={collapsed ? 'true' : 'false'}>
        <div className="collapsible-body">
          <div className="flex flex-col gap-1.5 px-3 pb-2">{children}</div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hlavní komponenta
// ---------------------------------------------------------------------------

export function Inspector() {
  const { selectedIds, selectedId } = useSelection()
  const { objects, objectsCtx: mutationCtx } = useSlideObjects()
  const { animations, animationsCtx: animMutationCtx } = useAnimations()
  const { role } = useDeckRole()
  const isViewer = role === 'viewer'

  // Multi-select inspector — align / distribute / layer order.
  if (selectedIds.size > 1) {
    return <MultiSelectInspector selectedIds={[...selectedIds]} />
  }

  if (selectedId === null) {
    return <SlideInspector />
  }

  const obj = objects.find((o) => o.id === selectedId)

  if (obj === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-muted-foreground/50">Object not found</p>
      </div>
    )
  }

  function patch<T extends SlideObject>(p: SlideObjectPatch<T>) {
    // M10: viewer role — no mutations
    if (isViewer) return
    if (obj === undefined || mutationCtx === null) return
    updateObject(mutationCtx, obj.id, p)
  }

  const rotationDeg = radToDeg(obj.rotation)

  return (
    <div className="scrollbar-narrative flex flex-col overflow-y-auto">
      {/* M10: viewer mode notice */}
      {isViewer && (
        <div className="border-b border-border bg-muted/50 px-3 py-1.5">
          <p className="text-[10px] text-muted-foreground/80">View only</p>
        </div>
      )}
      {/* P5a: Identity — authored name + lock toggle. Name feeds Magic Move
          pair key and the layer label. Lock disables transform handles +
          click-picking but keeps the Inspector functional so the flag can
          be toggled back off. A padlock badge is rendered over the object
          in the canvas so the state is visible without opening this panel. */}
      <Section title="Identity" storageKey="identity">
        <div className="flex items-center gap-2">
          <label
            htmlFor={`inspector-name-${obj.id}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Name
          </label>
          <input
            id={`inspector-name-${obj.id}`}
            type="text"
            value={obj.name ?? ''}
            placeholder={obj.type}
            disabled={isViewer}
            onChange={(e) => {
              const v = e.target.value.trim()
              patch({ name: v.length === 0 ? undefined : v } as SlideObjectPatch<SlideObject>)
            }}
            className="w-full rounded border border-border bg-input px-2 py-0.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
          />
          <button
            type="button"
            onClick={() =>
              patch({
                locked: obj.locked === true ? undefined : true,
              } as SlideObjectPatch<SlideObject>)
            }
            disabled={isViewer}
            aria-pressed={obj.locked === true}
            aria-label={obj.locked === true ? 'Unlock object' : 'Lock object'}
            title={obj.locked === true ? 'Unlock' : 'Lock — no dragging / resizing'}
            className={[
              'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border',
              obj.locked === true
                ? 'border-primary bg-primary/15 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
              'disabled:opacity-40',
            ].join(' ')}
          >
            {obj.locked === true ? (
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Unlock className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </Section>

      {/* Position */}
      <Section title="Position" storageKey="position">
        <NumberField
          id={`inspector-x-${obj.id}`}
          label="X"
          value={obj.x}
          onChange={(v) => patch({ x: v })}
        />
        <NumberField
          id={`inspector-y-${obj.id}`}
          label="Y"
          value={obj.y}
          onChange={(v) => patch({ y: v })}
        />
      </Section>

      {/* Size — width / height plus an aspect-lock toggle. When ON,
          corner-handle resizes preserve the W:H ratio and Shift
          temporarily releases it; when OFF, Shift temporarily locks
          it. The chain icon mirrors Figma / Sketch / Keynote. */}
      <Section title="Size" storageKey="size">
        <div className="relative">
          <NumberField
            id={`inspector-w-${obj.id}`}
            label="Width"
            value={obj.width}
            onChange={(v) => {
              if (obj.aspectLocked === true && obj.width > 0) {
                const ratio = obj.height / obj.width
                patch({ width: v, height: Math.max(1, Math.round(v * ratio)) })
              } else {
                patch({ width: v })
              }
            }}
          />
          <NumberField
            id={`inspector-h-${obj.id}`}
            label="Height"
            value={obj.height}
            onChange={(v) => {
              if (obj.aspectLocked === true && obj.height > 0) {
                const ratio = obj.width / obj.height
                patch({ height: v, width: Math.max(1, Math.round(v * ratio)) })
              } else {
                patch({ height: v })
              }
            }}
          />
          <button
            type="button"
            onClick={() =>
              patch({
                aspectLocked: obj.aspectLocked === true ? undefined : true,
              } as SlideObjectPatch<SlideObject>)
            }
            disabled={isViewer}
            aria-pressed={obj.aspectLocked === true}
            aria-label={
              obj.aspectLocked === true
                ? 'Unlock aspect ratio (Shift while dragging temporarily unlocks)'
                : 'Lock aspect ratio (Shift while dragging temporarily locks)'
            }
            title={
              obj.aspectLocked === true
                ? 'Aspect ratio: locked — Shift while dragging unlocks'
                : 'Aspect ratio: free — Shift while dragging locks'
            }
            className={[
              'absolute right-0 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              obj.aspectLocked === true
                ? 'bg-primary/15 text-primary hover:bg-primary/25'
                : 'text-muted-foreground/70 hover:bg-accent hover:text-foreground',
              isViewer ? 'pointer-events-none opacity-40' : '',
            ].join(' ')}
          >
            {obj.aspectLocked === true ? (
              <Link2 className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Link2Off className="h-3 w-3" aria-hidden="true" />
            )}
          </button>
        </div>
      </Section>

      {/* Transform */}
      <Section title="Transform" storageKey="transform">
        <NumberField
          id={`inspector-rot-${obj.id}`}
          label="Rotation"
          value={rotationDeg}
          step={0.1}
          onChange={(v) => patch({ rotation: degToRad(v) })}
        />
        <NumberField
          id={`inspector-opacity-${obj.id}`}
          label="Opacity"
          value={obj.opacity}
          step={0.01}
          onChange={(v) => patch({ opacity: Math.min(1, Math.max(0, v)) })}
        />
      </Section>

      {/* Appearance — every filled shape. P5b extended the schema with
          optional stroke + corner radius so the same section handles rect,
          ellipse, triangle and polygon. Corner radius is rectangle-only
          (ellipse/triangle/polygon don't have axis-aligned corners). */}
      {(obj.type === 'rectangle' ||
        obj.type === 'ellipse' ||
        obj.type === 'triangle' ||
        obj.type === 'polygon') && (
        <AppearanceSection
          obj={obj}
          patch={
            patch as (
              p: SlideObjectPatch<RectangleObject | EllipseObject | TriangleObject | PolygonObject>,
            ) => void
          }
        />
      )}

      {/* P5b: Line / Arrow / Path stroke controls. Schema already carried
          stroke + strokeWidth + dash — Inspector just surfaces them. */}
      {(obj.type === 'line' || obj.type === 'arrow' || obj.type === 'path') && (
        <LineStrokeSection
          obj={obj}
          patch={patch as (p: SlideObjectPatch<LineObject | ArrowObject | PathObject>) => void}
        />
      )}

      {/* Text properties */}
      {obj.type === 'text' && (
        <TextSection obj={obj} patch={patch as (p: SlideObjectPatch<TextObject>) => void} />
      )}

      {/* P8: Video properties — autoplay/loop/muted, volume, fit,
          poster frame override, aspect ratio lock, trim. */}
      {obj.type === 'video' && (
        <VideoSection obj={obj} patch={patch as (p: SlideObjectPatch<VideoObject>) => void} />
      )}

      {/* P11: Image crop — minimal viable UI (4 number fields + reset).
          Crop rect is in source-image pixel space. */}
      {obj.type === 'image' && (
        <ImageCropSection obj={obj} patch={patch as (p: SlideObjectPatch<ImageObject>) => void} />
      )}

      {/* P11: Link — hyperlink target on any object. Only visible for
          single selection (multi-select inspector skips it). */}
      <LinkSection obj={obj} patch={patch as (p: SlideObjectPatch<SlideObject>) => void} />

      {/* P5c: Shadow + Blur — every object type gets them through the
          BaseSlideObject mixin + filterEffects helper on the renderer side. */}
      <EffectsSection obj={obj} patch={patch as (p: SlideObjectPatch<SlideObject>) => void} />

      {/* P6: Layer order — always available for the selected object. */}
      {mutationCtx !== null && (
        <LayerOrderSection ids={[obj.id]} mutationCtx={mutationCtx} disabled={isViewer} />
      )}

      {/* Animations */}
      {animMutationCtx !== null && (
        <AnimationsSection
          objectId={obj.id}
          animations={animations}
          mutationCtx={animMutationCtx}
          totalAnimations={animations.length}
        />
      )}

      {/* P6: Layers panel — full ordered list of slide objects with
          drag-drop reorder. Shown at the bottom so it scrolls
          independently of the focused object's properties. */}
      {mutationCtx !== null && (
        <LayersPanel activeIds={[obj.id]} mutationCtx={mutationCtx} readOnly={isViewer} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SlideInspector — shown when no object is selected (M9)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Multi-select inspector — P6 object operations
// ---------------------------------------------------------------------------

/**
 * Detect a 1-image + 1-maskable-shape selection where the shape is
 * z-above the image (i.e. ordered after it in the slide's objects array).
 * Returns the matched pair or null if the selection doesn't qualify.
 */
function detectMaskCandidates(
  selectedIds: string[],
  objects: SlideObject[],
): { image: ImageObject; shape: SlideObject } | null {
  if (selectedIds.length !== 2) return null
  const a = objects.find((o) => o.id === selectedIds[0])
  const b = objects.find((o) => o.id === selectedIds[1])
  if (a === undefined || b === undefined) return null
  const aIdx = objects.indexOf(a)
  const bIdx = objects.indexOf(b)
  // The image is at the lower z-index (earlier in array), the shape at the higher.
  let image: ImageObject | null = null
  let shape: SlideObject | null = null
  if (a.type === 'image' && isMaskableShape(b) && bIdx > aIdx) {
    image = a
    shape = b
  } else if (b.type === 'image' && isMaskableShape(a) && aIdx > bIdx) {
    image = b
    shape = a
  }
  if (image === null || shape === null) return null
  return { image, shape }
}

function MultiSelectInspector({ selectedIds }: { selectedIds: string[] }) {
  const { objects, objectsCtx: mutationCtx } = useSlideObjects()
  const { role } = useDeckRole()
  const isViewer = role === 'viewer'
  if (mutationCtx === null) return null

  // Derive group state of the current selection so Group / Ungroup
  // buttons reflect what the next click would actually do:
  //   - Group disabled when every selected object already shares the
  //     same non-empty groupId (they're already grouped together) OR
  //     selection has fewer than 2 members.
  //   - Ungroup disabled when no selected object carries a groupId —
  //     there's nothing to ungroup.
  const selectedObjects = selectedIds
    .map((id) => objects.find((o) => o.id === id))
    .filter((o): o is NonNullable<typeof o> => o !== undefined)
  const groupIds = new Set(
    selectedObjects.map((o) => o.groupId).filter((g): g is string => g !== undefined && g !== ''),
  )
  const allSameGroup =
    selectedObjects.length >= 2 &&
    groupIds.size === 1 &&
    selectedObjects.every((o) => o.groupId !== undefined && o.groupId !== '')
  const anyHasGroup = groupIds.size > 0
  const groupLabel = allSameGroup ? 'Grouped' : 'Group'
  const groupTitle = allSameGroup
    ? 'Already grouped'
    : selectedObjects.length < 2
      ? 'Select 2+ objects to group'
      : 'Group (Cmd+G)'

  const runAlign = (axis: AlignAxis): void => {
    if (!isViewer) alignObjects(mutationCtx, selectedIds, axis)
  }
  const runDistribute = (axis: DistributeAxis): void => {
    if (!isViewer) distributeObjects(mutationCtx, selectedIds, axis)
  }
  const runGroup = (): void => {
    if (!isViewer) groupObjects(mutationCtx, selectedIds)
  }
  const runUngroup = (): void => {
    if (!isViewer) ungroupObjects(mutationCtx, selectedIds)
  }

  // Mask-with-shape: only when exactly 1 image + 1 maskable shape with
  // shape z-above image. The action consumes the shape and writes a
  // mask field on the image.
  const maskPair = detectMaskCandidates(selectedIds, objects)
  const runMaskWithShape = (): void => {
    if (isViewer || maskPair === null) return
    applyShapeMask(mutationCtx, maskPair.image.id, maskPair.shape.id)
  }

  return (
    <div className="scrollbar-narrative flex flex-col overflow-y-auto">
      <Section title={`${selectedIds.length} objects`} storageKey="multi-header">
        <p className="text-[10px] text-muted-foreground/70">
          Align, distribute + layer actions apply to every selected object.
        </p>
      </Section>
      <Section title="Align" storageKey="multi-align">
        <div className="grid grid-cols-6 gap-1">
          <MultiButton
            Icon={AlignHorizontalJustifyStart}
            title="Align left"
            onClick={() => runAlign('left')}
            disabled={isViewer}
          />
          <MultiButton
            Icon={AlignHorizontalJustifyCenter}
            title="Align horizontal center"
            onClick={() => runAlign('center-x')}
            disabled={isViewer}
          />
          <MultiButton
            Icon={AlignHorizontalJustifyEnd}
            title="Align right"
            onClick={() => runAlign('right')}
            disabled={isViewer}
          />
          <MultiButton
            Icon={AlignVerticalJustifyStart}
            title="Align top"
            onClick={() => runAlign('top')}
            disabled={isViewer}
          />
          <MultiButton
            Icon={AlignVerticalJustifyCenter}
            title="Align vertical middle"
            onClick={() => runAlign('center-y')}
            disabled={isViewer}
          />
          <MultiButton
            Icon={AlignVerticalJustifyEnd}
            title="Align bottom"
            onClick={() => runAlign('bottom')}
            disabled={isViewer}
          />
        </div>
      </Section>
      <Section title="Distribute" storageKey="multi-distribute">
        <div className="grid grid-cols-2 gap-1">
          <MultiButton
            label="Distribute H"
            title="Distribute horizontally"
            onClick={() => runDistribute('horizontal')}
            disabled={isViewer || selectedIds.length < 3}
          />
          <MultiButton
            label="Distribute V"
            title="Distribute vertically"
            onClick={() => runDistribute('vertical')}
            disabled={isViewer || selectedIds.length < 3}
          />
        </div>
      </Section>
      <LayerOrderSection ids={selectedIds} mutationCtx={mutationCtx} disabled={isViewer} />
      {maskPair !== null && (
        <Section title="Mask" storageKey="multi-mask">
          <button
            type="button"
            onClick={runMaskWithShape}
            disabled={isViewer}
            className="w-full rounded border border-border bg-input px-2 py-1 text-xs text-foreground hover:bg-input/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Mask with shape
          </button>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Use the {maskPair.shape.type} on top as a clipping mask for the image. The shape is
            consumed; the masked image keeps the same orange handles for resizing.
          </p>
        </Section>
      )}
      <Section title="Group" storageKey="multi-group">
        <div className="grid grid-cols-2 gap-1">
          <MultiButton
            label={groupLabel}
            title={groupTitle}
            onClick={runGroup}
            disabled={isViewer || selectedIds.length < 2 || allSameGroup}
          />
          <MultiButton
            label="Ungroup"
            title={anyHasGroup ? 'Ungroup (Shift+Cmd+G)' : 'Nothing to ungroup'}
            onClick={runUngroup}
            disabled={isViewer || !anyHasGroup}
          />
        </div>
        {allSameGroup && (
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            Already grouped. Use Ungroup to break up.
          </p>
        )}
      </Section>
      <LayersPanel activeIds={selectedIds} mutationCtx={mutationCtx} readOnly={isViewer} />
    </div>
  )
}

function MultiButton({
  label,
  Icon,
  title,
  onClick,
  disabled,
}: {
  label?: string
  Icon?: LucideIcon
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex items-center justify-center rounded border border-input field-surface px-1.5 py-1 text-[10px] text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {Icon !== undefined ? <Icon className="h-3.5 w-3.5" aria-hidden /> : label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Layer order section — shared between single-object and multi-select
// ---------------------------------------------------------------------------

function LayerOrderSection({
  ids,
  mutationCtx,
  disabled,
}: {
  ids: string[]
  mutationCtx: Parameters<typeof moveObjectsLayer>[0]
  disabled: boolean
}) {
  const run = (move: LayerMove): void => {
    if (!disabled) moveObjectsLayer(mutationCtx, ids, move)
  }
  return (
    <Section title="Layer order" storageKey="layer-order">
      <div className="grid grid-cols-2 gap-1">
        <MultiButton
          label="⤒ Front"
          title="Bring to front (Cmd+])"
          onClick={() => run('front')}
          disabled={disabled}
        />
        <MultiButton
          label="↑ Forward"
          title="Bring forward (])"
          onClick={() => run('forward')}
          disabled={disabled}
        />
        <MultiButton
          label="↓ Backward"
          title="Send backward ([)"
          onClick={() => run('backward')}
          disabled={disabled}
        />
        <MultiButton
          label="⤓ Back"
          title="Send to back (Cmd+[)"
          onClick={() => run('back')}
          disabled={disabled}
        />
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Layers panel — drag + drop reorder of every object on the active slide
// ---------------------------------------------------------------------------

/**
 * Short label for a layer row. Falls back to the object name (P5a), then
 * the type + short id suffix.
 */
function layerLabel(obj: SlideObject): string {
  if (obj.name !== undefined && obj.name !== '') return obj.name
  return `${obj.type}-${obj.id.slice(0, 4)}`
}

function LayersPanel({
  activeIds,
  mutationCtx,
  readOnly,
}: {
  activeIds: string[]
  mutationCtx: Parameters<typeof moveObjectToIndex>[0]
  readOnly: boolean
}) {
  const { objects } = useSlideObjects()
  const { selectOne, selectMany } = useSelection()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(
    null,
  )

  // Layer panel convention matches Figma / Illustrator: front of the
  // canvas (last in Y.Array) is rendered at the TOP of the list.
  const rows = [...objects].reverse()
  const activeSet = new Set(activeIds)

  const onDragStart = (id: string) => (e: React.DragEvent) => {
    if (readOnly) return
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
  const onDragOver = (id: string) => (e: React.DragEvent) => {
    if (readOnly || draggingId === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Top half of the row → "drop above this row"; bottom half → "drop
    // below". The previous version always showed the indicator at the
    // top edge of the hovered row, which lied to the user when they
    // tried to drop after the last row: the cue said "above" but the
    // mutation actually placed the item at the back. Splitting the row
    // in half fixes both ends and gives a real "drop at the bottom"
    // affordance.
    const rect = e.currentTarget.getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after'
    setDropTarget((prev) =>
      prev !== null && prev.id === id && prev.position === position ? prev : { id, position },
    )
  }
  const onDragEnd = () => {
    setDraggingId(null)
    setDropTarget(null)
  }
  const onDrop = (targetId: string) => (e: React.DragEvent) => {
    e.preventDefault()
    if (readOnly || draggingId === null) {
      onDragEnd()
      return
    }
    if (draggingId === targetId) {
      onDragEnd()
      return
    }
    const visualTargetIdx = rows.findIndex((o) => o.id === targetId)
    if (visualTargetIdx === -1) {
      onDragEnd()
      return
    }
    // rows is reversed: visual 0 = front = last in Y.Array.
    // 'before' = above target visually = same Y.Array slot the target
    // currently holds (target shifts down one).
    // 'after'  = below target visually = one slot lower in Y.Array,
    //            which clamps to 0 when dropping after the last row
    //            so "drag to the bottom of the panel" sends the item
    //            all the way to the back.
    const position = dropTarget?.id === targetId ? dropTarget.position : 'before'
    const yIndex =
      position === 'before'
        ? objects.length - 1 - visualTargetIdx
        : objects.length - 2 - visualTargetIdx
    moveObjectToIndex(mutationCtx, draggingId, yIndex)
    onDragEnd()
  }

  const onRowClick = (id: string) => (e: React.MouseEvent) => {
    if (e.shiftKey) {
      const next = new Set(activeIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      selectMany([...next])
    } else {
      selectOne(id)
    }
  }

  return (
    <Section title={`Layers (${objects.length})`} storageKey="layers-panel">
      {rows.length === 0 && (
        <p className="text-[10px] text-muted-foreground/70">No objects on this slide yet.</p>
      )}
      <ul className="flex flex-col gap-0.5" onDragEnd={onDragEnd}>
        {rows.map((o) => {
          const active = activeSet.has(o.id)
          const isDragging = draggingId === o.id
          const dropOnThis =
            dropTarget !== null &&
            dropTarget.id === o.id &&
            draggingId !== null &&
            draggingId !== o.id
          return (
            <li
              key={o.id}
              draggable={!readOnly}
              onDragStart={onDragStart(o.id)}
              onDragOver={onDragOver(o.id)}
              onDrop={onDrop(o.id)}
              onClick={onRowClick(o.id)}
              className={[
                'relative flex items-center gap-1.5 rounded border px-1.5 py-1 text-[11px]',
                'cursor-pointer select-none',
                active
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border text-foreground hover:bg-accent/40',
                isDragging ? 'opacity-40' : '',
                readOnly ? 'cursor-default' : '',
              ].join(' ')}
            >
              {dropOnThis && dropTarget!.position === 'before' && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-0.5 left-0 right-0 h-0.5 rounded-full bg-primary"
                />
              )}
              {dropOnThis && dropTarget!.position === 'after' && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -bottom-0.5 left-0 right-0 h-0.5 rounded-full bg-primary"
                />
              )}
              <span className="w-3 text-[9px] text-muted-foreground/60">⋮⋮</span>
              <span className="flex-1 truncate">{layerLabel(o)}</span>
              {o.locked === true && (
                <span className="text-muted-foreground/60" aria-hidden="true">
                  <Lock className="h-3 w-3" />
                </span>
              )}
              {o.groupId !== undefined && o.groupId !== '' && (
                <span
                  className="rounded bg-muted px-1 text-[9px] text-muted-foreground"
                  title={`Group ${o.groupId.slice(0, 4)}`}
                >
                  ∘
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/**
 * Slide-level inspector: shows transition settings for the active slide.
 * Replaces the "No selection" placeholder when selection is empty.
 */
function SlideInspector() {
  const { activeSlideId } = useActiveSlide()
  const { deckCtx } = useSlideDoc()
  const slides = useSlides()

  const slideIndex = slides.findIndex((s) => s.id === activeSlideId)
  const slide = slideIndex === -1 ? undefined : slides[slideIndex]
  const prevSlide = slideIndex > 0 ? slides[slideIndex - 1] : undefined

  // Magic Move morphs objects that share ids across the previous slide and
  // the active slide. Preview the count here so the user knows whether the
  // transition will actually do anything before entering present mode.
  const magicMatchedCount =
    slide !== undefined && prevSlide !== undefined
      ? slide.objects.filter((o) => prevSlide.objects.some((p) => p.id === o.id)).length
      : 0

  if (slide === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-muted-foreground/50">No selection</p>
      </div>
    )
  }

  const { transition } = slide

  function patchTransition(p: Partial<SlideTransition>) {
    if (activeSlideId === null) return
    updateSlideTransition(deckCtx, activeSlideId, p)
  }

  const kindOptions: { value: SlideTransitionKind; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'fade', label: 'Fade' },
    { value: 'push', label: 'Push' },
    { value: 'cube', label: 'Cube' },
    { value: 'magic', label: 'Magic Move' },
  ]

  const directionOptions: { value: SlidePushDirection; label: string }[] = [
    { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' },
    { value: 'up', label: 'Up' },
    { value: 'down', label: 'Down' },
  ]

  // Native <select> styled to match our inputs. Chevron icon is drawn by a
  // dedicated CSS class (`.select-chevron`) because Tailwind's `bg-*`
  // shorthands share a group — combining `field-surface` (color) with an
  // inline `bg-[url()]` (image) makes `tailwind-merge` collapse one of
  // them. Declaring both in raw CSS side-steps that.
  const SELECT_CLASS = [
    'select-chevron',
    'flex-1 appearance-none rounded-md border border-input field-surface px-2 py-1 pr-7',
    'text-xs text-foreground cursor-pointer',
    'hover:border-border-strong',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-ring',
    'disabled:opacity-40 disabled:cursor-not-allowed',
  ].join(' ')

  return (
    <div className="scrollbar-narrative flex flex-col overflow-y-auto">
      {/* Slide ID reference */}
      <div className="border-b border-border px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          Slide
        </p>
        <p
          className="mt-1 truncate font-mono text-[10px] text-muted-foreground/50"
          title={slide.id}
        >
          {slide.id}
        </p>
      </div>

      {/* Transition settings */}
      <Section title="Transition" storageKey="transition">
        {/* Kind */}
        <div className="flex items-center gap-2">
          <label
            htmlFor={`transition-kind-${slide.id}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Kind
          </label>
          <select
            id={`transition-kind-${slide.id}`}
            value={transition.kind}
            onChange={(e) => patchTransition({ kind: e.target.value as SlideTransitionKind })}
            className={SELECT_CLASS}
          >
            {kindOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Duration */}
        <div className="flex items-center gap-2">
          <label
            htmlFor={`transition-duration-${slide.id}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Duration
          </label>
          <input
            id={`transition-duration-${slide.id}`}
            type="number"
            min={0}
            step={50}
            value={transition.durationMs}
            disabled={transition.kind === 'none'}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const parsed = parseInt(e.target.value, 10)
              if (Number.isFinite(parsed) && parsed >= 0) {
                patchTransition({ durationMs: parsed })
              }
            }}
            className={[
              'w-full rounded border border-input field-surface px-2 py-0.5',
              'text-right text-xs text-foreground',
              'focus:border-ring focus:outline-none',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            ].join(' ')}
          />
          <span className="flex-shrink-0 text-[10px] text-muted-foreground/50">ms</span>
        </div>

        {/* Magic Move — hint + matched-pair preview */}
        {transition.kind === 'magic' && (
          <div
            className={[
              'rounded border px-2 py-1.5 text-[11px] leading-snug',
              prevSlide === undefined
                ? 'border-amber-700/60 bg-amber-900/20 text-amber-300'
                : magicMatchedCount === 0
                  ? 'border-amber-700/60 bg-amber-900/20 text-amber-300'
                  : 'border-input bg-muted/50 text-muted-foreground',
            ].join(' ')}
          >
            {prevSlide === undefined ? (
              <>Magic Move needs a previous slide to morph from.</>
            ) : magicMatchedCount === 0 ? (
              <>
                No matched objects between this slide and the previous one. Duplicate the previous
                slide to share object ids, then tweak positions here.
              </>
            ) : (
              <>
                {magicMatchedCount} matched {magicMatchedCount === 1 ? 'object' : 'objects'} will
                morph. Other objects crossfade.
              </>
            )}
          </div>
        )}

        {/* Direction — only for push */}
        {transition.kind === 'push' && (
          <div className="flex items-center gap-2">
            <label
              htmlFor={`transition-dir-${slide.id}`}
              className="w-16 flex-shrink-0 text-xs text-muted-foreground"
            >
              Direction
            </label>
            <select
              id={`transition-dir-${slide.id}`}
              value={transition.direction ?? 'left'}
              onChange={(e) => patchTransition({ direction: e.target.value as SlidePushDirection })}
              className={SELECT_CLASS}
            >
              {directionOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </Section>

      {/* Background */}
      <BackgroundSection
        slideId={slide.id}
        background={slide.background}
        selectClass={SELECT_CLASS}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Background section (per-slide)
// ---------------------------------------------------------------------------

interface BackgroundSectionProps {
  slideId: string
  background: SlideBackground | undefined
  selectClass: string
}

function BackgroundSection({ slideId, background, selectClass }: BackgroundSectionProps) {
  const { deckCtx } = useSlideDoc()
  const current = background ?? DEFAULT_BACKGROUND
  const kind = current.kind

  function setKind(nextKind: SlideBackground['kind']): void {
    if (nextKind === kind) return
    // Minimal-shape preset per kind. Users then edit the specifics.
    const next: SlideBackground = (() => {
      switch (nextKind) {
        case 'color':
          return { kind: 'color', color: 0xffffff, alpha: 1 }
        case 'linearGradient':
          return {
            kind: 'linearGradient',
            angleDeg: 180,
            stops: [
              { offset: 0, color: 0xffffff, alpha: 1 },
              { offset: 1, color: 0x111111, alpha: 1 },
            ],
          }
        case 'radialGradient':
          return {
            kind: 'radialGradient',
            centerX: 0.5,
            centerY: 0.5,
            radius: 0.6,
            stops: [
              { offset: 0, color: 0xffffff, alpha: 1 },
              { offset: 1, color: 0x111111, alpha: 1 },
            ],
          }
        case 'image':
          return { kind: 'image', assetId: '', fit: 'cover', dim: 0 }
      }
    })()
    updateSlideBackground(deckCtx, slideId, next)
  }

  function setSolidColor(color: number): void {
    updateSlideBackground(deckCtx, slideId, { kind: 'color', color, alpha: 1 })
  }

  function patchGradientStop(idx: 0 | 1, color: number): void {
    if (current.kind !== 'linearGradient' && current.kind !== 'radialGradient') return
    const stops = current.stops.slice()
    const stop = stops[idx]
    if (stop === undefined) return
    stops[idx] = { ...stop, color }
    updateSlideBackground(deckCtx, slideId, { ...current, stops })
  }

  function setAngle(angleDeg: number): void {
    if (current.kind !== 'linearGradient') return
    updateSlideBackground(deckCtx, slideId, { ...current, angleDeg })
  }

  return (
    <Section title="Background" storageKey="background">
      {/* Type */}
      <div className="flex items-center gap-2">
        <label
          htmlFor={`bg-kind-${slideId}`}
          className="w-16 flex-shrink-0 text-xs text-muted-foreground"
        >
          Type
        </label>
        <select
          id={`bg-kind-${slideId}`}
          value={kind}
          onChange={(e) => setKind(e.target.value as SlideBackground['kind'])}
          className={selectClass}
        >
          <option value="color">Solid color</option>
          <option value="linearGradient">Linear gradient</option>
          <option value="radialGradient">Radial gradient</option>
          <option value="image">Image</option>
        </select>
      </div>

      {/* Per-kind controls */}
      {current.kind === 'color' && (
        <div className="flex items-center gap-2">
          <label
            htmlFor={`bg-color-${slideId}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Color
          </label>
          <ColorInput
            value={numberToHex(current.color)}
            onChange={(hex) => setSolidColor(hexToNumber(hex))}
            ariaLabel="Background color"
            showHex
          />
        </div>
      )}

      {(current.kind === 'linearGradient' || current.kind === 'radialGradient') && (
        <>
          <div className="flex items-center gap-2">
            <label className="w-16 flex-shrink-0 text-xs text-muted-foreground">Start</label>
            <ColorInput
              value={numberToHex(current.stops[0]?.color ?? 0xffffff)}
              onChange={(hex) => patchGradientStop(0, hexToNumber(hex))}
              ariaLabel="Gradient start color"
              showHex={false}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="w-16 flex-shrink-0 text-xs text-muted-foreground">End</label>
            <ColorInput
              value={numberToHex(current.stops[1]?.color ?? 0x111111)}
              onChange={(hex) => patchGradientStop(1, hexToNumber(hex))}
              ariaLabel="Gradient end color"
              showHex={false}
            />
          </div>
          {current.kind === 'linearGradient' && (
            <NumberField
              id={`bg-angle-${slideId}`}
              label="Angle"
              value={current.angleDeg}
              step={1}
              onChange={(v) => setAngle(((v % 360) + 360) % 360)}
            />
          )}
        </>
      )}

      {current.kind === 'image' && (
        <p className="text-[11px] italic text-muted-foreground/60">
          Drag an image onto the slide, then come back to pick it as background. (Asset-picker UI
          lands in the next polish pass.)
        </p>
      )}

      {/* Reset */}
      <button
        type="button"
        onClick={() => updateSlideBackground(deckCtx, slideId, null)}
        className="mt-1 self-start rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        Reset to default
      </button>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Appearance section — fill + stroke + (rectangle-only) corner radius
// ---------------------------------------------------------------------------

type FilledShape = RectangleObject | EllipseObject | TriangleObject | PolygonObject

interface AppearanceSectionProps {
  obj: FilledShape
  patch: (p: SlideObjectPatch<FilledShape>) => void
}

function AppearanceSection({ obj, patch }: AppearanceSectionProps) {
  const hasStroke = obj.stroke !== undefined
  const strokeHex = numberToHex(obj.stroke ?? 0x000000)
  const strokeWidth = obj.strokeWidth ?? 1

  return (
    <Section title="Appearance" storageKey="appearance">
      <FillPicker obj={obj} patch={patch} />

      {/* Stroke — toggle + (when enabled) colour + width + dashed. Toggling
          off sends `stroke: undefined` which the renderer treats as "no
          stroke". */}
      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Stroke</span>
        <div className="flex flex-1 items-center gap-1.5">
          <input
            type="checkbox"
            aria-label="Enable stroke"
            checked={hasStroke}
            onChange={(e) => {
              if (e.target.checked) {
                patch({ stroke: 0x000000, strokeWidth: 1 } as SlideObjectPatch<FilledShape>)
              } else {
                // Explicit undefined tells updateObject to clear the field.
                patch({
                  stroke: undefined,
                  strokeWidth: undefined,
                } as unknown as SlideObjectPatch<FilledShape>)
              }
            }}
            className="h-3.5 w-3.5"
          />
          {hasStroke && (
            <>
              <ColorInput
                value={strokeHex}
                onChange={(hex) =>
                  patch({ stroke: hexToNumber(hex) } as SlideObjectPatch<FilledShape>)
                }
                ariaLabel="Stroke color"
                showHex={false}
                alpha={obj.strokeAlpha ?? 1}
                onAlphaChange={(a) => patch({ strokeAlpha: a } as SlideObjectPatch<FilledShape>)}
              />
              <input
                type="number"
                aria-label="Stroke width"
                min={0}
                step={0.5}
                value={strokeWidth}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value)
                  if (Number.isFinite(v)) {
                    patch({ strokeWidth: Math.max(0, v) } as SlideObjectPatch<FilledShape>)
                  }
                }}
                className={[
                  'w-16 rounded border border-input field-surface px-2 py-0.5',
                  'text-xs text-foreground focus:border-ring focus:outline-none',
                ].join(' ')}
              />
            </>
          )}
        </div>
      </div>

      {hasStroke && (
        <div className="flex items-center gap-2">
          <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Dashed</span>
          <input
            type="checkbox"
            aria-label="Dashed stroke"
            checked={obj.strokeDash === true}
            onChange={(e) =>
              patch({
                strokeDash: e.target.checked ? true : undefined,
              } as unknown as SlideObjectPatch<FilledShape>)
            }
            className="h-3.5 w-3.5"
          />
        </div>
      )}

      {/* Corner radius — rectangle only. Uniform slider + per-corner expand. */}
      {obj.type === 'rectangle' && (
        <CornerRadiusRow
          obj={obj}
          patch={patch as (p: SlideObjectPatch<RectangleObject>) => void}
        />
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Corner radius row — rectangle only
// ---------------------------------------------------------------------------

function CornerRadiusRow({
  obj,
  patch,
}: {
  obj: RectangleObject
  patch: (p: SlideObjectPatch<RectangleObject>) => void
}) {
  const [perCorner, setPerCorner] = useState(
    typeof obj.cornerRadius === 'object' && obj.cornerRadius !== null,
  )

  const maxR = Math.min(obj.width, obj.height) / 2
  const current: { tl: number; tr: number; br: number; bl: number } =
    typeof obj.cornerRadius === 'object' && obj.cornerRadius !== null
      ? obj.cornerRadius
      : {
          tl: (obj.cornerRadius as number | undefined) ?? 0,
          tr: (obj.cornerRadius as number | undefined) ?? 0,
          br: (obj.cornerRadius as number | undefined) ?? 0,
          bl: (obj.cornerRadius as number | undefined) ?? 0,
        }

  const setUniform = (v: number): void => {
    const clamped = Math.max(0, Math.min(maxR, v))
    // 0 ⇒ clear the field entirely so sharp-cornered rects keep their
    // default legacy shape in the Y.Doc.
    patch({
      cornerRadius: clamped === 0 ? undefined : clamped,
    } as unknown as SlideObjectPatch<RectangleObject>)
  }
  const setCorner = (which: 'tl' | 'tr' | 'br' | 'bl', v: number): void => {
    const clamped = Math.max(0, Math.min(maxR, v))
    const next: CornerRadius = { ...current, [which]: clamped }
    patch({ cornerRadius: next })
  }

  const uniformVal =
    typeof obj.cornerRadius === 'number'
      ? obj.cornerRadius
      : obj.cornerRadius === undefined
        ? 0
        : // per-corner currently active but user toggled back to uniform —
          // seed from tl so the slider has a reasonable starting point.
          current.tl

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Corners</span>
        <div className="flex flex-1 items-center gap-1.5">
          {!perCorner && (
            <>
              <input
                type="range"
                aria-label="Corner radius"
                min={0}
                max={Math.max(1, Math.round(maxR))}
                step={1}
                value={uniformVal}
                onChange={(e) => setUniform(Number.parseFloat(e.target.value))}
                className="flex-1 accent-primary"
              />
              <input
                type="number"
                aria-label="Corner radius value"
                min={0}
                max={Math.round(maxR)}
                value={Math.round(uniformVal)}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value)
                  if (Number.isFinite(v)) setUniform(v)
                }}
                className={[
                  'w-14 rounded border border-input field-surface px-2 py-0.5',
                  'text-xs text-foreground focus:border-ring focus:outline-none',
                ].join(' ')}
              />
            </>
          )}
          <button
            type="button"
            onClick={() => {
              if (perCorner) {
                // Collapse to uniform — use the tl value.
                setUniform(current.tl)
              }
              setPerCorner((v) => !v)
            }}
            aria-pressed={perCorner}
            title={perCorner ? 'Collapse to single radius' : 'Edit each corner separately'}
            className={[
              'rounded border px-1.5 py-0.5 text-[10px]',
              perCorner
                ? 'border-primary bg-primary/15 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {perCorner ? '4x' : '1x'}
          </button>
        </div>
      </div>

      {perCorner && (
        <div className="ml-[4.5rem] grid grid-cols-2 gap-1.5">
          {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
            <div key={c} className="flex items-center gap-1">
              <span className="w-5 text-[10px] uppercase text-muted-foreground">{c}</span>
              <input
                type="number"
                aria-label={`${c} corner radius`}
                min={0}
                max={Math.round(maxR)}
                value={Math.round(current[c])}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value)
                  if (Number.isFinite(v)) setCorner(c, v)
                }}
                className={[
                  'flex-1 rounded border border-input field-surface px-2 py-0.5',
                  'text-xs text-foreground focus:border-ring focus:outline-none',
                ].join(' ')}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Fill picker — solid / linear gradient / radial gradient
// ---------------------------------------------------------------------------

type FillMode = 'solid' | 'linearGradient' | 'radialGradient' | 'image'

function fillModeOf(style: FillStyle | undefined): FillMode {
  if (style === undefined) return 'solid'
  return style.kind
}

function FillPicker({
  obj,
  patch,
}: {
  obj: FilledShape
  patch: (p: SlideObjectPatch<FilledShape>) => void
}) {
  const mode = fillModeOf(obj.fillStyle)
  const solidHex = numberToHex(obj.fill)

  const setMode = (next: FillMode): void => {
    if (next === mode) return
    if (next === 'solid') {
      patch({ fillStyle: undefined } as unknown as SlideObjectPatch<FilledShape>)
      return
    }
    if (next === 'image') {
      // Empty assetId ⇒ placeholder until the user picks an upload.
      patch({
        fillStyle: { kind: 'image', assetId: '', fit: 'cover' },
      } as SlideObjectPatch<FilledShape>)
      return
    }
    // Seed a two-stop gradient from the current solid colour + its darker
    // counterpart so the object doesn't visually flash to white/black.
    const startColor = obj.fill
    const endColor = 0x000000
    const stops: FillGradientStop[] = [
      { color: startColor, offset: 0 },
      { color: endColor, offset: 1 },
    ]
    if (next === 'linearGradient') {
      patch({
        fillStyle: { kind: 'linearGradient', stops, angleDeg: 0 },
      } as SlideObjectPatch<FilledShape>)
    } else {
      patch({ fillStyle: { kind: 'radialGradient', stops } } as SlideObjectPatch<FilledShape>)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Fill</span>
        <select
          aria-label="Fill type"
          value={mode}
          onChange={(e) => setMode(e.target.value as FillMode)}
          className="rounded border border-input field-surface px-1 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
        >
          <option value="solid">Solid</option>
          <option value="linearGradient">Linear gradient</option>
          <option value="radialGradient">Radial gradient</option>
          <option value="image">Image</option>
        </select>
      </div>

      {mode === 'solid' && (
        <div className="ml-[4.5rem]">
          <ColorInput
            value={solidHex}
            onChange={(hex) => patch({ fill: hexToNumber(hex) })}
            ariaLabel="Fill color"
            showHex
            alpha={obj.fillAlpha ?? 1}
            onAlphaChange={(a) => patch({ fillAlpha: a } as SlideObjectPatch<FilledShape>)}
          />
        </div>
      )}

      {(mode === 'linearGradient' || mode === 'radialGradient') && obj.fillStyle !== undefined && (
        <GradientEditor
          fillStyle={obj.fillStyle}
          onChange={(next) => patch({ fillStyle: next } as SlideObjectPatch<FilledShape>)}
        />
      )}

      {mode === 'image' && obj.fillStyle?.kind === 'image' && (
        <ImageFillEditor
          fillStyle={obj.fillStyle}
          onChange={(next) => patch({ fillStyle: next } as SlideObjectPatch<FilledShape>)}
        />
      )}
    </div>
  )
}

function GradientEditor({
  fillStyle,
  onChange,
}: {
  fillStyle: FillStyle
  onChange: (next: FillStyle) => void
}) {
  if (fillStyle.kind === 'image') return null
  const stops = fillStyle.stops
  const stop0 = stops[0] ?? { color: 0xffffff, offset: 0 }
  const stop1 = stops[stops.length - 1] ?? { color: 0x000000, offset: 1 }

  const setStop = (idx: 0 | 1, color: number): void => {
    const nextStops = [...stops]
    if (idx === 0) nextStops[0] = { ...stop0, color }
    else nextStops[nextStops.length - 1] = { ...stop1, color }
    onChange({ ...fillStyle, stops: nextStops } as FillStyle)
  }

  const setStopAlpha = (idx: 0 | 1, alpha: number): void => {
    const nextStops = [...stops]
    if (idx === 0) nextStops[0] = { ...stop0, alpha }
    else nextStops[nextStops.length - 1] = { ...stop1, alpha }
    onChange({ ...fillStyle, stops: nextStops } as FillStyle)
  }

  return (
    <div className="ml-[4.5rem] flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="w-12 text-[10px] uppercase text-muted-foreground">Start</span>
        <ColorInput
          value={numberToHex(stop0.color)}
          onChange={(hex) => setStop(0, hexToNumber(hex))}
          ariaLabel="Gradient start color"
          showHex={false}
          alpha={stop0.alpha ?? 1}
          onAlphaChange={(a) => setStopAlpha(0, a)}
        />
        <span className="w-12 text-[10px] uppercase text-muted-foreground">End</span>
        <ColorInput
          value={numberToHex(stop1.color)}
          onChange={(hex) => setStop(1, hexToNumber(hex))}
          ariaLabel="Gradient end color"
          showHex={false}
          alpha={stop1.alpha ?? 1}
          onAlphaChange={(a) => setStopAlpha(1, a)}
        />
      </div>
      {fillStyle.kind === 'linearGradient' && (
        <div className="flex items-center gap-1.5">
          <span className="w-12 text-[10px] uppercase text-muted-foreground">Angle</span>
          <input
            type="range"
            aria-label="Gradient angle"
            min={0}
            max={360}
            value={fillStyle.angleDeg}
            onChange={(e) =>
              onChange({ ...fillStyle, angleDeg: Number.parseFloat(e.target.value) })
            }
            className="flex-1 accent-primary"
          />
          <span className="w-10 text-right text-[10px] tabular-nums text-muted-foreground">
            {Math.round(fillStyle.angleDeg)}°
          </span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Image fill editor — picks an asset via the same upload input used by the
// toolbar's Insert Image button, plus a fit (cover / contain) toggle.
// ---------------------------------------------------------------------------

function ImageFillEditor({
  fillStyle,
  onChange,
}: {
  fillStyle: ImageFillStyle
  onChange: (next: ImageFillStyle) => void
}) {
  const { startUpload } = useMediaUpload()
  const fileInputId = `inspector-fill-image-${fillStyle.assetId || 'empty'}`

  const onFile = (file: File): void => {
    startUpload(file, {
      onDone: (entry) => {
        if (entry.assetId === undefined || entry.assetId === '') return
        onChange({ ...fillStyle, assetId: entry.assetId })
      },
    })
  }

  return (
    <div className="ml-[4.5rem] flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <label
          htmlFor={fileInputId}
          className="flex-1 cursor-pointer rounded border border-input field-surface px-2 py-1 text-center text-[10px] text-muted-foreground hover:text-foreground"
        >
          {fillStyle.assetId === '' ? 'Choose image…' : 'Replace image'}
        </label>
        <input
          id={fileInputId}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f !== undefined) onFile(f)
            e.currentTarget.value = ''
          }}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-12 text-[10px] uppercase text-muted-foreground">Fit</span>
        <select
          aria-label="Image fill fit"
          value={fillStyle.fit ?? 'cover'}
          onChange={(e) => onChange({ ...fillStyle, fit: e.target.value as 'cover' | 'contain' })}
          className="flex-1 rounded border border-input field-surface px-1 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
        >
          <option value="cover">Cover</option>
          <option value="contain">Contain</option>
        </select>
      </div>
      {fillStyle.assetId === '' && (
        <p className="text-[10px] text-muted-foreground/70">Upload an image to fill the shape.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Line / Arrow / Path stroke section
// ---------------------------------------------------------------------------

function LineStrokeSection({
  obj,
  patch,
}: {
  obj: LineObject | ArrowObject | PathObject
  patch: (p: SlideObjectPatch<LineObject | ArrowObject | PathObject>) => void
}) {
  const strokeHex = numberToHex(obj.stroke)
  const dashOn = obj.dash === true

  return (
    <Section title="Stroke" storageKey="stroke">
      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Color</span>
        <div className="flex flex-1 items-center gap-1.5">
          <ColorInput
            value={strokeHex}
            onChange={(hex) => patch({ stroke: hexToNumber(hex) } as SlideObjectPatch<typeof obj>)}
            ariaLabel="Stroke color"
            showHex
            alpha={obj.strokeAlpha ?? 1}
            onAlphaChange={(a) => patch({ strokeAlpha: a } as SlideObjectPatch<typeof obj>)}
          />
        </div>
      </div>

      <NumberField
        id={`inspector-sw-${obj.id}`}
        label="Width"
        value={obj.strokeWidth}
        step={0.5}
        onChange={(v) => patch({ strokeWidth: Math.max(0, v) } as SlideObjectPatch<typeof obj>)}
      />

      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Dashed</span>
        <input
          type="checkbox"
          aria-label="Dashed stroke"
          checked={dashOn}
          onChange={(e) =>
            patch({ dash: e.target.checked ? true : undefined } as unknown as SlideObjectPatch<
              typeof obj
            >)
          }
          className="h-3.5 w-3.5"
        />
      </div>

      {(obj.type === 'line' || obj.type === 'arrow') && (
        <>
          <CapPicker
            label="Start cap"
            value={obj.startCap ?? 'none'}
            onChange={(v) =>
              patch({ startCap: v === 'none' ? undefined : v } as unknown as SlideObjectPatch<
                typeof obj
              >)
            }
          />
          <CapPicker
            label="End cap"
            value={obj.endCap ?? (obj.type === 'arrow' ? 'arrow' : 'none')}
            onChange={(v) =>
              patch({ endCap: v === 'none' ? undefined : v } as unknown as SlideObjectPatch<
                typeof obj
              >)
            }
          />
        </>
      )}
    </Section>
  )
}

function CapPicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: 'none' | 'round' | 'square' | 'arrow'
  onChange: (v: 'none' | 'round' | 'square' | 'arrow') => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as 'none' | 'round' | 'square' | 'arrow')}
        className="flex-1 rounded border border-input field-surface px-1 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
      >
        <option value="none">None</option>
        <option value="round">Round</option>
        <option value="square">Square</option>
        <option value="arrow">Arrow</option>
      </select>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Effects section — drop shadow + blur (P5c)
// ---------------------------------------------------------------------------

const DEFAULT_SHADOW: ShadowStyle = {
  color: 0x000000,
  blur: 8,
  offsetX: 4,
  offsetY: 4,
  opacity: 0.5,
}

function EffectsSection({
  obj,
  patch,
}: {
  obj: SlideObject
  patch: (p: SlideObjectPatch<SlideObject>) => void
}) {
  const hasShadow = obj.shadow !== undefined
  const blur = obj.blur ?? 0

  return (
    <Section title="Effects" storageKey="effects">
      {/* Shadow */}
      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Shadow</span>
        <input
          type="checkbox"
          aria-label="Enable shadow"
          checked={hasShadow}
          onChange={(e) =>
            patch({
              shadow: e.target.checked ? DEFAULT_SHADOW : undefined,
            } as unknown as SlideObjectPatch<SlideObject>)
          }
          className="h-3.5 w-3.5"
        />
      </div>

      {hasShadow && obj.shadow !== undefined && (
        <ShadowControls
          shadow={obj.shadow}
          onChange={(next) => patch({ shadow: next } as SlideObjectPatch<SlideObject>)}
        />
      )}

      {/* Blur */}
      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Blur</span>
        <input
          type="range"
          aria-label="Blur radius"
          min={0}
          max={40}
          step={1}
          value={blur}
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value)
            patch({ blur: v === 0 ? undefined : v } as unknown as SlideObjectPatch<SlideObject>)
          }}
          className="flex-1 accent-primary"
        />
        <span className="w-10 text-right text-[10px] tabular-nums text-muted-foreground">
          {Math.round(blur)}
        </span>
      </div>
    </Section>
  )
}

function ShadowControls({
  shadow,
  onChange,
}: {
  shadow: ShadowStyle
  onChange: (next: ShadowStyle) => void
}) {
  return (
    <div className="ml-[4.5rem] flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="w-12 flex-shrink-0 text-[10px] uppercase text-muted-foreground">
          Color
        </span>
        <ColorInput
          value={numberToHex(shadow.color)}
          onChange={(hex) => onChange({ ...shadow, color: hexToNumber(hex) })}
          ariaLabel="Shadow color"
          showHex={false}
          alpha={shadow.opacity}
          onAlphaChange={(a) => onChange({ ...shadow, opacity: a })}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-12 text-[10px] uppercase text-muted-foreground">Blur</span>
        <input
          type="range"
          min={0}
          max={40}
          step={1}
          value={shadow.blur}
          onChange={(e) => onChange({ ...shadow, blur: Number.parseFloat(e.target.value) })}
          className="flex-1 accent-primary"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-12 text-[10px] uppercase text-muted-foreground">Offset</span>
        <input
          type="number"
          aria-label="Shadow offset X"
          value={shadow.offsetX}
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange({ ...shadow, offsetX: v })
          }}
          className="w-14 rounded border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
        />
        <input
          type="number"
          aria-label="Shadow offset Y"
          value={shadow.offsetY}
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange({ ...shadow, offsetY: v })
          }}
          className="w-14 rounded border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text section
// ---------------------------------------------------------------------------

interface TextSectionProps {
  obj: TextObject
  patch: (p: SlideObjectPatch<TextObject>) => void
}

function TextSection({ obj, patch }: TextSectionProps) {
  const colorHex = numberToHex(obj.color)
  const { role } = useDeckRole()
  const isViewer = role === 'viewer'

  // Re-render whenever the active text-edit selection changes so the
  // Bold / Italic / Underline buttons can highlight based on the run
  // under the caret instead of just the box-wide field.
  const activeSel = useSyncExternalStore(subscribeActiveTextSelection, getActiveTextSelection)
  const selAttrs =
    activeSel !== null && activeSel.objectId === obj.id ? readActiveSelectionAttrs(obj.id) : null
  const boxBold =
    obj.fontWeight === 'bold' || (typeof obj.fontWeight === 'number' && obj.fontWeight >= 600)
  const boxItalic = obj.italic === true
  const boxUnderline = obj.underline === true
  const effectiveBold = selAttrs?.fontWeight !== undefined ? selAttrs.fontWeight >= 600 : boxBold
  const effectiveItalic = selAttrs?.italic !== undefined ? selAttrs.italic : boxItalic
  const effectiveUnderline = selAttrs?.underline !== undefined ? selAttrs.underline : boxUnderline

  return (
    <>
      {/* P15: removed "Text content" textarea — double-click on the
          text on canvas to edit inline; the side-panel textarea was
          redundant and easy to accidentally type into. */}

      <Section title="Typography" storageKey="typography">
        <div data-text-edit-keep-focus>
          <NumberField
            id={`inspector-fontsize-${obj.id}`}
            label="Size"
            value={
              selAttrs?.fontSize !== undefined && selAttrs.fontSize > 0
                ? selAttrs.fontSize
                : obj.fontSize
            }
            onChange={(v) => {
              const next = Math.max(1, v)
              const sel = getActiveTextSelection()
              if (sel !== null && sel.objectId === obj.id) {
                if (isEntireContentSelected(obj.id)) {
                  clearActiveSelectionAttrs(obj.id, ['fontSize'])
                  patch({ fontSize: next })
                  refocusActiveTextEdit(obj.id)
                  return
                }
                const applied = applyInlineFormatIfSelected(obj.id, { fontSize: next })
                if (!applied) patch({ fontSize: next })
                refocusActiveTextEdit(obj.id)
                return
              }
              clearAllInlineRunAttrs(obj.text, ['fontSize'])
              patch({ fontSize: next })
            }}
          />
        </div>

        {/* Font family — a curated set of web-safe + system stacks. User
            can still type a custom value because we use a combo pattern. */}
        <div className="flex items-center gap-2">
          <label
            htmlFor={`inspector-fontfamily-${obj.id}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Family
          </label>
          <FontFamilySelect obj={obj} patch={patch} disabled={isViewer} />
        </div>

        <FontWeightSelect obj={obj} patch={patch} />

        {/* Bold + Italic + Underline toggles + List style row.
            Each toggle first attempts an inline format on the active
            text-edit selection (so a highlighted word is bolded /
            italicised on its own); only when there is no selection do
            we fall back to patching the box-wide field. */}
        <div className="flex items-center gap-2" data-text-edit-keep-focus>
          <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Style</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const next = (effectiveBold ? 400 : 700) as 400 | 700
                if (selAttrs !== null) {
                  if (isEntireContentSelected(obj.id)) {
                    clearActiveSelectionAttrs(obj.id, ['fontWeight'])
                    patch({ fontWeight: next } as unknown as SlideObjectPatch<TextObject>)
                    return
                  }
                  applyInlineFormatIfSelected(obj.id, { fontWeight: next })
                  return
                }
                clearAllInlineRunAttrs(obj.text, ['fontWeight'])
                patch({ fontWeight: next } as unknown as SlideObjectPatch<TextObject>)
              }}
              aria-pressed={effectiveBold}
              className={[
                'rounded border px-2 py-0.5 text-[11px] font-bold',
                effectiveBold
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              ].join(' ')}
              title="Bold"
            >
              B
            </button>
            <button
              type="button"
              // preventDefault on mouseDown keeps the editing textarea
              // focused (and its selection alive) while the user clicks
              // a style toggle in the inspector. Without this, the
              // textarea blurs on mousedown, which exits edit mode and
              // wipes the selection before the click even fires.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const nextItalic = !effectiveItalic
                if (selAttrs !== null) {
                  if (isEntireContentSelected(obj.id)) {
                    clearActiveSelectionAttrs(obj.id, ['italic'])
                    patch({
                      italic: nextItalic ? true : undefined,
                    } as unknown as SlideObjectPatch<TextObject>)
                    return
                  }
                  applyInlineFormatIfSelected(obj.id, { italic: nextItalic })
                  return
                }
                clearAllInlineRunAttrs(obj.text, ['italic'])
                patch({
                  italic: nextItalic ? true : undefined,
                } as unknown as SlideObjectPatch<TextObject>)
              }}
              aria-pressed={effectiveItalic}
              className={[
                'rounded border px-2 py-0.5 text-[11px] italic',
                effectiveItalic
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              ].join(' ')}
              title="Italic"
            >
              I
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const nextUnderline = !effectiveUnderline
                if (selAttrs !== null) {
                  if (isEntireContentSelected(obj.id)) {
                    clearActiveSelectionAttrs(obj.id, ['underline'])
                    patch({
                      underline: nextUnderline ? true : undefined,
                    } as unknown as SlideObjectPatch<TextObject>)
                    return
                  }
                  applyInlineFormatIfSelected(obj.id, { underline: nextUnderline })
                  return
                }
                clearAllInlineRunAttrs(obj.text, ['underline'])
                patch({
                  underline: nextUnderline ? true : undefined,
                } as unknown as SlideObjectPatch<TextObject>)
              }}
              aria-pressed={effectiveUnderline}
              className={[
                'rounded border px-2 py-0.5 text-[11px] underline',
                effectiveUnderline
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              ].join(' ')}
              title="Underline"
            >
              U
            </button>
            <select
              value={obj.listStyle ?? ''}
              onChange={(e) =>
                patch({
                  listStyle:
                    e.target.value === '' ? undefined : (e.target.value as 'bullet' | 'numbered'),
                } as unknown as SlideObjectPatch<TextObject>)
              }
              className="flex-1 rounded border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
              title="List style"
            >
              <option value="">No list</option>
              <option value="bullet">• Bullet</option>
              <option value="numbered">1. Numbered</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Align</span>
          <AlignButtonGroup
            value={obj.align}
            onChange={(v) => patch({ align: v })}
            ariaLabel="Horizontal alignment"
            options={[
              { value: 'left', label: 'Left', Icon: AlignLeft },
              { value: 'center', label: 'Center', Icon: AlignCenter },
              { value: 'right', label: 'Right', Icon: AlignRight },
            ]}
          />
        </div>

        {/* Vertical alignment (new in P7). Default top. */}
        <div className="flex items-center gap-2">
          <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">V-align</span>
          <AlignButtonGroup
            value={obj.vAlign ?? 'top'}
            onChange={(v) => patch({ vAlign: v } as SlideObjectPatch<TextObject>)}
            ariaLabel="Vertical alignment"
            options={[
              { value: 'top', label: 'Top', Icon: AlignVerticalJustifyStart },
              { value: 'middle', label: 'Middle', Icon: AlignVerticalJustifyCenter },
              { value: 'bottom', label: 'Bottom', Icon: AlignVerticalJustifyEnd },
            ]}
          />
        </div>

        <NumberField
          id={`inspector-lineheight-${obj.id}`}
          label="Line-h"
          value={obj.lineHeight ?? 1.2}
          step={0.1}
          onChange={(v) => patch({ lineHeight: Math.max(0.1, v) } as SlideObjectPatch<TextObject>)}
        />
        <NumberField
          id={`inspector-letterspacing-${obj.id}`}
          label="Letter"
          value={obj.letterSpacing ?? 0}
          step={0.5}
          onChange={(v) => patch({ letterSpacing: v } as SlideObjectPatch<TextObject>)}
        />

        <div className="flex items-center gap-2">
          <label
            htmlFor={`inspector-color-${obj.id}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Color
          </label>
          <div className="flex flex-1 items-center gap-1.5">
            <ColorInput
              value={colorHex}
              onChange={(hex) => patch({ color: hexToNumber(hex) })}
              ariaLabel="Text color"
              showHex
              alpha={obj.colorAlpha ?? 1}
              onAlphaChange={(a) => patch({ colorAlpha: a } as SlideObjectPatch<TextObject>)}
            />
          </div>
        </div>

        {/* Text stroke (outline on glyphs) — optional. */}
        <div className="flex items-center gap-2">
          <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Stroke</span>
          <div className="flex flex-1 items-center gap-1.5">
            <input
              type="checkbox"
              aria-label="Enable text stroke"
              checked={obj.stroke !== undefined}
              onChange={(e) => {
                if (e.target.checked) {
                  patch({ stroke: 0x000000, strokeWidth: 1 } as SlideObjectPatch<TextObject>)
                } else {
                  patch({
                    stroke: undefined,
                    strokeWidth: undefined,
                  } as unknown as SlideObjectPatch<TextObject>)
                }
              }}
              className="h-3.5 w-3.5"
            />
            {obj.stroke !== undefined && (
              <>
                <ColorInput
                  value={numberToHex(obj.stroke)}
                  onChange={(hex) =>
                    patch({ stroke: hexToNumber(hex) } as SlideObjectPatch<TextObject>)
                  }
                  ariaLabel="Text stroke color"
                  showHex={false}
                  alpha={obj.strokeAlpha ?? 1}
                  onAlphaChange={(a) => patch({ strokeAlpha: a } as SlideObjectPatch<TextObject>)}
                />
                <input
                  type="number"
                  aria-label="Text stroke width"
                  min={0}
                  step={0.5}
                  value={obj.strokeWidth ?? 1}
                  onChange={(e) => {
                    const v = Number.parseFloat(e.target.value)
                    if (Number.isFinite(v)) {
                      patch({ strokeWidth: Math.max(0, v) } as SlideObjectPatch<TextObject>)
                    }
                  }}
                  className="w-16 rounded border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
                />
              </>
            )}
          </div>
        </div>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// P8: Video properties section
// ---------------------------------------------------------------------------

/**
 * P8: poster-frame picker — number input + scrub slider + "Use current
 * frame" button that snapshots whatever time the editor's <video>
 * overlay is paused at. The overlay publishes its currentTime to a
 * window registry keyed by VideoObject id.
 */
function PosterFrameRow({
  obj,
  patch,
}: {
  obj: VideoObject
  patch: (p: SlideObjectPatch<VideoObject>) => void
}) {
  const { info } = useVideoInfo(obj.assetId !== '' ? obj.assetId : null)
  const duration = info?.durationSec ?? 0
  const hasDuration = duration > 0
  const value = obj.posterTime ?? 0

  const setPoster = (v: number): void => {
    const clamped = hasDuration ? Math.max(0, Math.min(duration, v)) : Math.max(0, v)
    patch({
      posterTime: clamped <= 0 ? undefined : clamped,
    } as unknown as SlideObjectPatch<VideoObject>)
  }

  const captureCurrent = (): void => {
    const reg = (
      window as unknown as {
        __narrative_video_currents?: Record<string, { currentTime: number }>
      }
    ).__narrative_video_currents
    const t = reg?.[obj.id]?.currentTime
    if (typeof t === 'number' && t > 0) setPoster(t)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label
          htmlFor={`inspector-video-poster-${obj.id}`}
          className="w-16 flex-shrink-0 text-xs text-muted-foreground"
        >
          Poster
        </label>
        <input
          id={`inspector-video-poster-${obj.id}`}
          type="number"
          step={0.1}
          min={0}
          {...(hasDuration ? { max: duration } : {})}
          value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value)
            if (Number.isFinite(parsed)) setPoster(parsed)
          }}
          className={[
            'w-20 rounded-md border border-input field-surface px-2 py-0.5',
            'text-right text-xs text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          ].join(' ')}
        />
        <span className="text-[10px] text-muted-foreground/70">
          {hasDuration ? `/ ${duration.toFixed(1)}s` : 's'}
        </span>
      </div>
      {hasDuration && (
        <div className="ml-[4.5rem] flex items-center gap-1.5">
          <input
            type="range"
            aria-label="Scrub poster frame"
            min={0}
            max={duration}
            step={Math.max(0.05, duration / 200)}
            value={value}
            onChange={(e) => setPoster(Number.parseFloat(e.target.value))}
            className="flex-1 accent-primary"
          />
        </div>
      )}
      <div className="ml-[4.5rem] flex items-center gap-1.5">
        <button
          type="button"
          onClick={captureCurrent}
          title="Pause the video at the frame you want, then click to capture its time as the poster."
          className="rounded border border-border field-surface px-2 py-0.5 text-[10px] text-foreground hover:bg-accent"
        >
          Use current frame
        </button>
        {value > 0 && (
          <button
            type="button"
            onClick={() =>
              patch({ posterTime: undefined } as unknown as SlideObjectPatch<VideoObject>)
            }
            title="Reset poster to the auto-generated thumbnail at t=0"
            className="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  )
}

function VideoSection({
  obj,
  patch,
}: {
  obj: VideoObject
  patch: (p: SlideObjectPatch<VideoObject>) => void
}) {
  const muted = obj.muted ?? true
  const volume = obj.volume ?? 1
  const fit = obj.fit ?? 'contain'

  return (
    <Section title="Video" storageKey="video">
      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Playback</span>
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={obj.autoplay ?? false}
              onChange={(e) =>
                patch({ autoplay: e.target.checked } as SlideObjectPatch<VideoObject>)
              }
            />
            Autoplay
          </label>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={obj.loop ?? false}
              onChange={(e) => patch({ loop: e.target.checked } as SlideObjectPatch<VideoObject>)}
            />
            Loop
          </label>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={muted}
              onChange={(e) => patch({ muted: e.target.checked } as SlideObjectPatch<VideoObject>)}
            />
            Muted
          </label>
          <label
            className="flex items-center gap-1 text-[10px] text-muted-foreground"
            title="Show native play / scrub / volume controls. Off = clean preview, click-to-toggle still works."
          >
            <input
              type="checkbox"
              checked={obj.showControls === true}
              onChange={(e) =>
                patch({
                  showControls: e.target.checked ? true : undefined,
                } as unknown as SlideObjectPatch<VideoObject>)
              }
            />
            Controls
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label
          htmlFor={`inspector-video-vol-${obj.id}`}
          className="w-16 flex-shrink-0 text-xs text-muted-foreground"
        >
          Volume
        </label>
        <input
          id={`inspector-video-vol-${obj.id}`}
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) =>
            patch({ volume: Number.parseFloat(e.target.value) } as SlideObjectPatch<VideoObject>)
          }
          disabled={muted}
          className="flex-1 accent-primary disabled:opacity-40"
        />
        <span className="w-10 text-right text-[10px] tabular-nums text-muted-foreground">
          {Math.round(volume * 100)}%
        </span>
      </div>

      <div className="flex items-center gap-2">
        <label
          htmlFor={`inspector-video-fit-${obj.id}`}
          className="w-16 flex-shrink-0 text-xs text-muted-foreground"
        >
          Fit
        </label>
        <select
          id={`inspector-video-fit-${obj.id}`}
          value={fit}
          onChange={(e) =>
            patch({ fit: e.target.value as 'cover' | 'contain' } as SlideObjectPatch<VideoObject>)
          }
          className="flex-1 rounded border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
        >
          <option value="contain">Contain</option>
          <option value="cover">Cover</option>
        </select>
      </div>

      {/* P15: aspect-lock moved to the Size section as a chain icon
          shared by every object type. The previous video-only "Lock
          to native ratio" checkbox lived here; it's now redundant. */}

      <PosterFrameRow obj={obj} patch={patch} />
      <NumberField
        id={`inspector-video-trim-start-${obj.id}`}
        label="Trim ⏵"
        value={obj.trimStart ?? 0}
        step={0.1}
        onChange={(v) =>
          patch({
            trimStart: v <= 0 ? undefined : v,
          } as unknown as SlideObjectPatch<VideoObject>)
        }
      />
      <NumberField
        id={`inspector-video-trim-end-${obj.id}`}
        label="Trim ⏵|"
        value={obj.trimEnd ?? 0}
        step={0.1}
        onChange={(v) =>
          patch({
            trimEnd: v <= 0 ? undefined : v,
          } as unknown as SlideObjectPatch<VideoObject>)
        }
      />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Animations section
// ---------------------------------------------------------------------------

interface AnimationsSectionProps {
  objectId: string
  animations: AnimationStep[]
  mutationCtx: AnimationsMutationContext
  /** Total animation count on slide — for computing default trigger for new animation. */
  totalAnimations: number
}

/**
 * Label pro animaci zobrazený v listu.
 * Příklady: "fadeIn", "slideIn (up)", "slideIn (left)"
 */
function animationLabel(step: AnimationStep): string {
  const dir = step.params?.['direction'] as string | undefined
  return dir !== undefined ? `${step.preset} (${dir})` : step.preset
}

/**
 * Defaultní trigger pro novou animaci:
 * - První animace na slide → onEnter (spustí se automaticky po zobrazení slide)
 * - Další → afterPrevious (spustí se po dokončení předchozí)
 */
function defaultTrigger(totalAnimations: number): AnimationTrigger {
  return totalAnimations === 0 ? 'onEnter' : 'afterPrevious'
}

const ADD_BUTTON_CLASS = [
  'rounded border border-input px-2 py-0.5 text-xs text-foreground/90',
  'hover:border-blue-500 hover:text-blue-400 transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
].join(' ')

/**
 * Per-animation row inside the inspector. Mirrors the AnimationTimeline
 * controls (trigger / duration / delay / easing) so authors can edit a
 * single animation without opening the timeline panel. Trigger options
 * intentionally exclude `onEnter` — the first non-onClick step in the
 * sequence runs onEnter implicitly (see compileSteps), so exposing it
 * here would be redundant.
 */
function AnimationItem({
  step,
  onRemove,
  mutationCtx,
}: {
  step: AnimationStep
  onRemove: (stepId: string) => void
  mutationCtx: AnimationsMutationContext
}) {
  function patch(p: Partial<AnimationStep>): void {
    updateAnimation(mutationCtx, step.id, p)
  }
  return (
    <li className="flex flex-col gap-1 rounded field-surface px-2 py-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-foreground">{animationLabel(step)}</span>
        <button
          type="button"
          onClick={() => onRemove(step.id)}
          aria-label={`Remove ${animationLabel(step)} animation`}
          className={[
            'ml-2 rounded p-0.5 text-muted-foreground/50 transition-colors',
            'hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500',
          ].join(' ')}
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground/80">
          Trigger
          <select
            value={step.trigger}
            aria-label="Trigger"
            className="rounded border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
            onChange={(e) => patch({ trigger: e.target.value as AnimationTrigger })}
          >
            <option value="withPrevious">withPrevious</option>
            <option value="afterPrevious">afterPrevious</option>
            <option value="onClick">onClick</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground/80">
          Easing
          <select
            value={step.easing ?? 'power2.out'}
            aria-label="Easing"
            className="rounded border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
            onChange={(e) => patch({ easing: e.target.value })}
          >
            <option value="none">none</option>
            <option value="power1.out">power1 out</option>
            <option value="power2.out">power2 out</option>
            <option value="power2.inOut">power2 in/out</option>
            <option value="power3.inOut">power3 in/out</option>
            <option value="sine.inOut">sine in/out</option>
            <option value="back.out">back out</option>
            <option value="bounce.out">bounce out</option>
            <option value="elastic.out">elastic out</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground/80">
          Duration (s)
          <input
            type="number"
            min={0}
            step={0.05}
            value={step.duration ?? 0}
            aria-label="Duration in seconds"
            className="rounded border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (!Number.isNaN(v) && v >= 0) patch({ duration: v })
            }}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground/80">
          Delay (s)
          <input
            type="number"
            min={0}
            step={0.05}
            value={step.delay ?? 0}
            aria-label="Delay in seconds"
            className="rounded border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (!Number.isNaN(v) && v >= 0) patch({ delay: v })
            }}
          />
        </label>
      </div>
    </li>
  )
}

function AnimationsSection({
  objectId,
  animations,
  mutationCtx,
  totalAnimations,
}: AnimationsSectionProps) {
  // Animace patřící tomuto objektu
  const objectAnimations = animations.filter((a) => a.objectId === objectId)

  function handleAddAnimation(preset: AnimationStep['preset'], params?: Record<string, unknown>) {
    addAnimation(mutationCtx, {
      objectId,
      preset,
      trigger: defaultTrigger(totalAnimations),
      duration: 0.6,
      delay: 0,
      easing: 'power2.out',
      ...(params !== undefined ? { params } : {}),
    })
  }

  function handleRemove(stepId: string) {
    removeAnimation(mutationCtx, stepId)
  }

  return (
    <Section title="Animations" storageKey="animations">
      {/* Add dropdown — quick fadeIn button + full preset menu.
          Presets with direction variants (slideIn / slideOut) encode the
          direction in the value after a colon; onChange parses and forwards
          as params. */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={ADD_BUTTON_CLASS}
          onClick={() => handleAddAnimation('fadeIn')}
          aria-label="Add fadeIn animation"
        >
          + fadeIn
        </button>
        <select
          value=""
          aria-label="Add animation preset"
          className="flex-1 rounded border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
          onChange={(e) => {
            const val = e.target.value
            if (val === '') return
            const [preset, direction] = val.split(':') as [
              AnimationStep['preset'],
              string | undefined,
            ]
            if (direction !== undefined) {
              handleAddAnimation(preset, { direction })
            } else {
              handleAddAnimation(preset)
            }
            // Reset so the same preset can be chosen again.
            e.target.value = ''
          }}
        >
          <option value="">+ More presets…</option>
          <optgroup label="Enter">
            <option value="dissolveIn">dissolveIn</option>
            <option value="scaleIn">scaleIn</option>
            <option value="zoomIn">zoomIn</option>
            <option value="rotateIn">rotateIn</option>
            <option value="bounceIn">bounceIn</option>
            <option value="flipIn">flipIn</option>
            <option value="popIn">popIn</option>
            <option value="wipeIn">wipeIn</option>
            <option value="slideIn:up">slideIn up</option>
            <option value="slideIn:down">slideIn down</option>
            <option value="slideIn:left">slideIn left</option>
            <option value="slideIn:right">slideIn right</option>
          </optgroup>
          <optgroup label="Exit">
            <option value="fadeOut">fadeOut</option>
            <option value="scaleOut">scaleOut</option>
            <option value="slideOut:up">slideOut up</option>
            <option value="slideOut:down">slideOut down</option>
            <option value="slideOut:left">slideOut left</option>
            <option value="slideOut:right">slideOut right</option>
          </optgroup>
        </select>
      </div>

      {/* Existing animations list */}
      {objectAnimations.length === 0 ? (
        <p className="text-[10px] text-muted-foreground/50 italic">No animations</p>
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label="Object animations">
          {objectAnimations.map((step) => (
            <AnimationItem
              key={step.id}
              step={step}
              onRemove={handleRemove}
              mutationCtx={mutationCtx}
            />
          ))}
        </ul>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// P11: Link (hyperlink) section — visible for any single-selected object.
// Listens for 'narrative:focus-link-inspector' so the object context menu's
// "Hyperlink…" item can scroll + focus this section without prop drilling.
// ---------------------------------------------------------------------------

interface LinkSectionProps {
  obj: SlideObject
  patch: (p: SlideObjectPatch<SlideObject>) => void
}

function LinkSection({ obj, patch }: LinkSectionProps) {
  const slides = useSlides()
  const containerRef = useRef<HTMLDivElement>(null)
  const typeSelectRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    function focusHandler() {
      const root = containerRef.current
      if (root === null) return
      // Scroll the panel into view first; the type picker autofocus
      // afterwards positions the cursor on the right control.
      root.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      // Focus the picker on the next frame so the scroll animation
      // doesn't fight the focus ring placement.
      window.setTimeout(() => {
        typeSelectRef.current?.focus()
      }, 0)
    }
    window.addEventListener('narrative:focus-link-inspector', focusHandler as EventListener)
    return () => {
      window.removeEventListener('narrative:focus-link-inspector', focusHandler as EventListener)
    }
  }, [])

  const link = obj.hyperlink
  const kind: 'none' | 'slide' | 'url' = link?.kind ?? 'none'

  function setKind(next: 'none' | 'slide' | 'url') {
    if (next === 'none') {
      patch({ hyperlink: undefined } as unknown as SlideObjectPatch<SlideObject>)
      return
    }
    if (next === 'slide') {
      const firstOther = slides.find((s) => s.id !== undefined)?.id ?? ''
      const nextLink: ObjectHyperlink = { kind: 'slide', slideId: firstOther }
      patch({ hyperlink: nextLink } as SlideObjectPatch<SlideObject>)
      return
    }
    const nextLink: ObjectHyperlink = { kind: 'url', href: '', target: '_blank' }
    patch({ hyperlink: nextLink } as SlideObjectPatch<SlideObject>)
  }

  return (
    <div ref={containerRef}>
      <Section title="Link" storageKey="link">
        <div className="flex items-center gap-2">
          <label
            htmlFor={`inspector-link-type-${obj.id}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Type
          </label>
          <select
            ref={typeSelectRef}
            id={`inspector-link-type-${obj.id}`}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'none' | 'slide' | 'url')}
            className="w-full rounded border border-border bg-input px-2 py-0.5 text-xs text-foreground focus:border-primary focus:outline-none"
          >
            <option value="none">None</option>
            <option value="slide">Slide</option>
            <option value="url">URL</option>
          </select>
        </div>

        {link?.kind === 'slide' && (
          <div className="flex items-center gap-2">
            <label
              htmlFor={`inspector-link-slide-${obj.id}`}
              className="w-16 flex-shrink-0 text-xs text-muted-foreground"
            >
              Target
            </label>
            <select
              id={`inspector-link-slide-${obj.id}`}
              value={link.slideId}
              onChange={(e) => {
                patch({
                  hyperlink: { kind: 'slide', slideId: e.target.value },
                } as SlideObjectPatch<SlideObject>)
              }}
              className="w-full rounded border border-border bg-input px-2 py-0.5 text-xs text-foreground focus:border-primary focus:outline-none"
            >
              {slides.map((s, i) => (
                <option key={s.id} value={s.id}>
                  {s.name && s.name.length > 0 ? s.name : `Slide ${i + 1}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {link?.kind === 'url' && (
          <>
            <div className="flex items-center gap-2">
              <label
                htmlFor={`inspector-link-href-${obj.id}`}
                className="w-16 flex-shrink-0 text-xs text-muted-foreground"
              >
                URL
              </label>
              <input
                id={`inspector-link-href-${obj.id}`}
                type="url"
                value={link.href}
                placeholder="https://example.com"
                onChange={(e) => {
                  const target = link.target
                  patch({
                    hyperlink: {
                      kind: 'url',
                      href: e.target.value,
                      ...(target !== undefined ? { target } : {}),
                    },
                  } as SlideObjectPatch<SlideObject>)
                }}
                className="w-full rounded border border-border bg-input px-2 py-0.5 text-xs text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              <label
                htmlFor={`inspector-link-target-${obj.id}`}
                className="w-16 flex-shrink-0 text-xs text-muted-foreground"
              >
                Open in
              </label>
              <select
                id={`inspector-link-target-${obj.id}`}
                value={link.target ?? '_blank'}
                onChange={(e) => {
                  patch({
                    hyperlink: {
                      kind: 'url',
                      href: link.href,
                      target: e.target.value as '_self' | '_blank',
                    },
                  } as SlideObjectPatch<SlideObject>)
                }}
                className="w-full rounded border border-border bg-input px-2 py-0.5 text-xs text-foreground focus:border-primary focus:outline-none"
              >
                <option value="_blank">New tab</option>
                <option value="_self">Same tab</option>
              </select>
            </div>
          </>
        )}
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// P11 (Keynote-style image crop): the actual crop UX is a modal overlay
// (CropOverlay) entered via double-click on the image. The Inspector
// section just exposes two buttons: enter crop mode, or reset.
// ---------------------------------------------------------------------------

interface ImageCropSectionProps {
  obj: ImageObject
  patch: (p: SlideObjectPatch<ImageObject>) => void
}

function ImageCropSection({ obj, patch }: ImageCropSectionProps) {
  const { enterCrop } = useCropMode()
  const cropped = obj.imageRect !== undefined
  const masked = obj.mask !== undefined
  return (
    <Section title="Crop" storageKey="imageCrop">
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => enterCrop(obj.id)}
          className="rounded border border-border bg-input px-2 py-1 text-xs text-foreground hover:bg-input/70"
        >
          Crop image…
        </button>
        <button
          type="button"
          disabled={!cropped}
          onClick={() =>
            patch({ imageRect: undefined } as unknown as SlideObjectPatch<ImageObject>)
          }
          className="rounded border border-border bg-input px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset crop
        </button>
        {masked && (
          <button
            type="button"
            onClick={() => patch({ mask: undefined } as unknown as SlideObjectPatch<ImageObject>)}
            className="rounded border border-border bg-input px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Remove shape mask
          </button>
        )}
        <p className="text-[11px] text-muted-foreground">
          Double-click the image on the canvas to enter crop mode. Drag the picture to reposition,
          drag a frame edge to resize the visible window.
        </p>
      </div>
    </Section>
  )
}
