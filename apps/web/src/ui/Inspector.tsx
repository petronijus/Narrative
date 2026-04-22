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

import { useState, type ChangeEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { useSelection } from '../state/SelectionContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useAnimations } from '../state/useAnimations.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSlides } from '../state/useSlides.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import {
  updateObject,
  addAnimation,
  removeAnimation,
  updateSlideTransition,
} from '@narrative/slide-model'
import type { AnimationsMutationContext } from '@narrative/slide-model'
import type {
  SlideObject,
  RectangleObject,
  EllipseObject,
  TextObject,
  SlideObjectPatch,
  AnimationStep,
  AnimationTrigger,
  SlideTransition,
  SlideTransitionKind,
  SlidePushDirection,
} from '@narrative/shared'

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
          'w-full rounded-md border border-input bg-background px-2 py-0.5',
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

  // Multi-select placeholder
  if (selectedIds.size > 1) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-center">
        <p className="text-xs text-muted-foreground/80">
          Multi-select — {selectedIds.size} objects selected.
          <br />
          Inspector not supported yet.
        </p>
      </div>
    )
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

      {/* Size */}
      <Section title="Size" storageKey="size">
        <NumberField
          id={`inspector-w-${obj.id}`}
          label="Width"
          value={obj.width}
          onChange={(v) => patch({ width: v })}
        />
        <NumberField
          id={`inspector-h-${obj.id}`}
          label="Height"
          value={obj.height}
          onChange={(v) => patch({ height: v })}
        />
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

      {/* Appearance — Rectangle + Ellipse */}
      {(obj.type === 'rectangle' || obj.type === 'ellipse') && (
        <AppearanceSection
          obj={obj}
          patch={patch as (p: SlideObjectPatch<RectangleObject | EllipseObject>) => void}
        />
      )}

      {/* Text properties */}
      {obj.type === 'text' && (
        <TextSection obj={obj} patch={patch as (p: SlideObjectPatch<TextObject>) => void} />
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// SlideInspector — shown when no object is selected (M9)
// ---------------------------------------------------------------------------

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
  // shorthands share a group — combining `bg-surface-2` (color) with an
  // inline `bg-[url()]` (image) makes `tailwind-merge` collapse one of
  // them. Declaring both in raw CSS side-steps that.
  const SELECT_CLASS = [
    'select-chevron',
    'flex-1 appearance-none rounded-md border border-input bg-surface-2 px-2 py-1 pr-7',
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
              'w-full rounded border border-input bg-surface-2 px-2 py-0.5',
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Appearance section (rectangle + ellipse)
// ---------------------------------------------------------------------------

interface AppearanceSectionProps {
  obj: RectangleObject | EllipseObject
  patch: (p: SlideObjectPatch<RectangleObject | EllipseObject>) => void
}

function AppearanceSection({ obj, patch }: AppearanceSectionProps) {
  const hexValue = numberToHex(obj.fill)

  return (
    <Section title="Appearance" storageKey="appearance">
      <div className="flex items-center gap-2">
        <label
          htmlFor={`inspector-fill-${obj.id}`}
          className="w-16 flex-shrink-0 text-xs text-muted-foreground"
        >
          Fill
        </label>
        <div className="flex flex-1 items-center gap-1.5">
          <input
            id={`inspector-fill-${obj.id}`}
            type="color"
            value={hexValue}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              patch({ fill: hexToNumber(e.target.value) })
            }}
            className="h-6 w-8 cursor-pointer rounded border border-input bg-transparent p-0.5"
          />
          <input
            type="text"
            aria-label="Fill color hex"
            value={hexValue.toUpperCase()}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const raw = e.target.value.trim()
              const hex = raw.startsWith('#') ? raw : `#${raw}`
              if (/^#[0-9a-f]{6}$/i.test(hex)) {
                patch({ fill: hexToNumber(hex) })
              }
            }}
            className={[
              'flex-1 rounded border border-input bg-surface-2 px-2 py-0.5',
              'font-mono text-xs text-foreground',
              'focus:border-ring focus:outline-none',
            ].join(' ')}
          />
        </div>
      </div>
    </Section>
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

  return (
    <>
      <Section title="Text" storageKey="text">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`inspector-text-${obj.id}`} className="text-xs text-muted-foreground">
            Content
          </label>
          <textarea
            id={`inspector-text-${obj.id}`}
            value={obj.text}
            rows={3}
            onChange={(e) => patch({ text: e.target.value })}
            onKeyDown={(e) => {
              // Escape blurs (drops focus). Ctrl+Enter same — ergonomic.
              if ((e.ctrlKey && e.key === 'Enter') || e.key === 'Escape') {
                e.currentTarget.blur()
              }
            }}
            className={[
              'w-full resize-none rounded border border-input bg-surface-2 px-2 py-1',
              'text-xs text-foreground',
              'focus:border-ring focus:outline-none',
            ].join(' ')}
          />
        </div>
      </Section>

      <Section title="Typography" storageKey="typography">
        <NumberField
          id={`inspector-fontsize-${obj.id}`}
          label="Size"
          value={obj.fontSize}
          onChange={(v) => patch({ fontSize: Math.max(1, v) })}
        />

        <div className="flex items-center gap-2">
          <label
            htmlFor={`inspector-fontweight-${obj.id}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Weight
          </label>
          <select
            id={`inspector-fontweight-${obj.id}`}
            value={obj.fontWeight}
            onChange={(e) => patch({ fontWeight: e.target.value as 'normal' | 'bold' })}
            className={[
              'flex-1 rounded border border-input bg-surface-2 px-2 py-0.5',
              'text-xs text-foreground',
              'focus:border-ring focus:outline-none',
            ].join(' ')}
          >
            <option value="normal">Normal</option>
            <option value="bold">Bold</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor={`inspector-align-${obj.id}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Align
          </label>
          <select
            id={`inspector-align-${obj.id}`}
            value={obj.align}
            onChange={(e) => patch({ align: e.target.value as 'left' | 'center' | 'right' })}
            className={[
              'flex-1 rounded border border-input bg-surface-2 px-2 py-0.5',
              'text-xs text-foreground',
              'focus:border-ring focus:outline-none',
            ].join(' ')}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor={`inspector-color-${obj.id}`}
            className="w-16 flex-shrink-0 text-xs text-muted-foreground"
          >
            Color
          </label>
          <div className="flex flex-1 items-center gap-1.5">
            <input
              id={`inspector-color-${obj.id}`}
              type="color"
              value={colorHex}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                patch({ color: hexToNumber(e.target.value) })
              }}
              className="h-6 w-8 cursor-pointer rounded border border-input bg-transparent p-0.5"
            />
            <input
              type="text"
              aria-label="Text color hex"
              value={colorHex.toUpperCase()}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value.trim()
                const hex = raw.startsWith('#') ? raw : `#${raw}`
                if (/^#[0-9a-f]{6}$/i.test(hex)) {
                  patch({ color: hexToNumber(hex) })
                }
              }}
              className={[
                'flex-1 rounded border border-input bg-surface-2 px-2 py-0.5',
                'font-mono text-xs text-foreground',
                'focus:border-ring focus:outline-none',
              ].join(' ')}
            />
          </div>
        </div>
      </Section>
    </>
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
          className="flex-1 rounded border border-input bg-surface-2 px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
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
        <ul className="flex flex-col gap-1" aria-label="Object animations">
          {objectAnimations.map((step) => (
            <li
              key={step.id}
              className="flex items-center justify-between rounded bg-surface-2 px-2 py-1"
            >
              <div className="flex flex-col">
                <span className="text-xs text-foreground">{animationLabel(step)}</span>
                <span className="text-[10px] text-muted-foreground/80">{step.trigger}</span>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(step.id)}
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
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
