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

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
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
  ArrowUpToLine,
  ArrowUp,
  ArrowDown,
  ArrowDownToLine,
  ChevronDown,
  FlipHorizontal,
  FlipVertical,
  Link2,
  Link2Off,
  Lock,
  Repeat,
  RotateCw,
  SlidersHorizontal,
  Unlock,
  Volume2,
  VolumeX,
  X,
  CaseLower,
  CaseSensitive,
  CaseUpper,
  CirclePlay,
  Hash,
  MoreVertical,
  MousePointerClick,
  Plus,
  RotateCcw,
  Rows3,
  Save,
  Type,
  type LucideIcon,
} from 'lucide-react'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { TokenColorInput } from './TokenColorInput.js'
import { TableInspector } from './TableInspector.js'
import { AlignButtonGroup } from './AlignButtonGroup.js'
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
import {
  currentParagraphAttrs,
  setListKind,
  setBulletChar,
  setNumberFormat,
  setStartAt,
  indentList,
} from './textListOps.js'
import { useSelection } from '../state/SelectionContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useAnimations } from '../state/useAnimations.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSlides } from '../state/useSlides.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { useNavigate } from 'react-router-dom'
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
  removeObject,
  listSlides,
} from '@narrative/slide-model'
import type {
  AnimationsMutationContext,
  AlignAxis,
  DistributeAxis,
  LayerMove,
  RichAttrs,
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
  TextStyleOverrideKey,
  ListNumberFormat,
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
import { DEFAULT_BACKGROUND, isTextStyleOverrideKey } from '@narrative/shared'
import {
  useFolderTokens,
  useFolderTokensOptional,
  useFolderMutations,
} from '../state/FolderDocProvider.js'
import { emptyTokensSnapshot } from '../state/FolderDocContext.js'
import { isTokenRef, resolveTokenValue } from '@narrative/slide-model'
import type { TokenRef, ColorTokenSnapshot } from '@narrative/slide-model'
import { useApi } from '../api/client.js'
import { promoteSelectionToComponent } from '../state/promoteSelectionToComponent.js'
import { SlideNumberPromptDialog } from './SlideNumberPromptDialog.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Číslo (hex) → #rrggbb string pro <input type="color"> */
function numberToHex(value: number): string {
  return '#' + value.toString(16).padStart(6, '0')
}

/**
 * M16 P2: coerces `number | TokenRef` to `number` for existing Inspector
 * code that handles colours as hex numbers.  TokenRef values return 0
 * (transparent black) until the token picker UI (P4) provides proper
 * resolution here.  Literal numbers pass through unchanged.
 */
function colourAsNumber(value: number | TokenRef | undefined): number {
  if (value === undefined) return 0
  if (isTokenRef(value)) return 0
  return value
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

/**
 * Shift + ArrowUp/Down on a number field → step by 10× the configured
 * step. Browsers vary here (Firefox does this natively, Chrome doesn't),
 * so we always intercept the shift case for consistent behaviour. Plain
 * arrows are left to the browser so native spinners + the existing
 * onChange path keep working.
 */
function handleShiftArrowStep(
  e: ReactKeyboardEvent<HTMLInputElement>,
  current: number,
  step: number,
  onChange: (next: number) => void,
  bounds?: { min?: number; max?: number },
): void {
  if (!e.shiftKey) return
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  e.preventDefault()
  const dir = e.key === 'ArrowUp' ? 1 : -1
  const base = Number.isFinite(current) ? current : 0
  let next = base + dir * step * 10
  if (bounds?.min !== undefined) next = Math.max(bounds.min, next)
  if (bounds?.max !== undefined) next = Math.min(bounds.max, next)
  onChange(next)
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

// AlignButtonGroup lives in its own module so the table inspector can
// import the same component without circular dependencies. Keep the
// import here colocated with the rest of the ui imports above.

/**
 * Slider + numeric % field for whole-object transparency. Wired to
 * `obj.opacity`, which is applied at the renderer container level and
 * therefore dims fill, stroke, image, text and any nested decoration
 * uniformly — independent of per-fill / per-stroke alpha.
 */
export function TransparencySlider({
  id,
  value,
  onChange,
  ariaLabel = 'Transparency',
  disabled = false,
}: {
  id: string
  value: number
  onChange: (next: number) => void
  ariaLabel?: string
  disabled?: boolean
}) {
  const pct = Math.round(value * 100)
  const commit = (raw: number): void => {
    if (!Number.isFinite(raw)) return
    const clamped = Math.max(0, Math.min(100, raw)) / 100
    onChange(clamped)
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        id={id}
        aria-label={ariaLabel}
        min={0}
        max={100}
        step={1}
        value={pct}
        disabled={disabled}
        onChange={(e) => commit(Number.parseFloat(e.target.value))}
        className="flex-1 accent-primary disabled:opacity-50"
      />
      <div className="w-20 flex-shrink-0">
        <CompactNumberField
          id={`${id}-num`}
          ariaLabel={`${ariaLabel} value`}
          value={pct}
          step={1}
          suffix="%"
          disabled={disabled}
          onChange={commit}
        />
      </div>
    </div>
  )
}

/**
 * Small in-section label for grouping rows ("Alignment", "Position",
 * "Size", "Rotation"). Less pronounced than the section title — used
 * inside the Position block to mirror the Figma inspector layout.
 */
export function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mb-0.5 mt-1 text-[10px] text-muted-foreground/70 first:mt-0">{children}</div>
  )
}

interface CompactNumberFieldProps {
  id: string
  /**
   * Single-glyph leading mark inside the input ("X", "Y", "↻").
   * Omit (or pass empty) for fields whose context already labels them
   * (e.g. the standalone opacity % field next to a colour swatch).
   */
  glyph?: React.ReactNode
  /** Full a11y label (e.g. "X position"). */
  ariaLabel: string
  value: number
  step?: number
  suffix?: string
  disabled?: boolean
  onChange: (value: number) => void
}

/**
 * P16: Figma-style numeric field — leading glyph inside a single
 * field-shaped surface, no separate left-column label. Lets the
 * Position section pack X+Y or rotation+flip controls onto one row
 * while keeping the same focus / select-all / commit semantics as
 * the legacy NumberField.
 */
function CompactNumberField({
  id,
  glyph,
  ariaLabel,
  value,
  step = 1,
  suffix,
  disabled = false,
  onChange,
}: CompactNumberFieldProps) {
  return (
    <div
      className={[
        'group/field flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input field-surface px-2 py-0.5',
        'focus-within:ring-2 focus-within:ring-ring',
        disabled ? 'opacity-50' : '',
      ].join(' ')}
    >
      {glyph !== undefined && glyph !== '' && (
        <span
          aria-hidden
          className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-[11px] text-muted-foreground"
        >
          {glyph}
        </span>
      )}
      <input
        id={id}
        type="number"
        step={step}
        disabled={disabled}
        aria-label={ariaLabel}
        value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
        onFocus={(e) => {
          const target = e.target
          setTimeout(() => {
            if (document.activeElement === target) target.select()
          }, 0)
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const parsed = parseFloat(e.target.value)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
        onKeyDown={(e) => handleShiftArrowStep(e, value, step, onChange)}
        className={[
          'min-w-0 flex-1 bg-transparent text-xs text-foreground',
          'focus:outline-none disabled:cursor-not-allowed',
          // Native spinners: hidden at rest, revealed when the field
          // is hovered or focused. Keep the WebKit spin button laid
          // out at full width but invisible via opacity so the input
          // text doesn't shift on hover. Firefox uses
          // `appearance:textfield` to hide; on hover/focus we let it
          // back to `auto`.
          '[appearance:textfield] group-hover/field:[appearance:auto] focus:[appearance:auto]',
          '[&::-webkit-inner-spin-button]:opacity-0 [&::-webkit-outer-spin-button]:opacity-0',
          'group-hover/field:[&::-webkit-inner-spin-button]:opacity-100 focus:[&::-webkit-inner-spin-button]:opacity-100',
          'group-hover/field:[&::-webkit-outer-spin-button]:opacity-100 focus:[&::-webkit-outer-spin-button]:opacity-100',
          '[&::-webkit-inner-spin-button]:transition-opacity [&::-webkit-outer-spin-button]:transition-opacity',
        ].join(' ')}
      />
      {suffix !== undefined && (
        <span aria-hidden className="flex-shrink-0 text-[10px] text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  )
}

interface IconToggleButtonProps {
  Icon: LucideIcon
  label: string
  pressed: boolean
  disabled?: boolean
  onClick: () => void
}

/** Square icon toggle styled to match the AlignButtonGroup buttons. */
function IconToggleButton({
  Icon,
  label,
  pressed,
  disabled = false,
  onClick,
}: IconToggleButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-input',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // Same shape as AlignButtonGroup, but the active icon is
        // tinted blue (primary) so the toggle reads at a glance.
        pressed
          ? 'bg-primary/15 text-primary'
          : 'field-surface text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        disabled ? 'cursor-not-allowed opacity-50' : '',
      ].join(' ')}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
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
        // Select-all when the user clicks/tabs into the field so
        // typing replaces the existing value. onFocus alone fails for
        // mouse clicks: the focus event fires during mousedown, but
        // the subsequent click positions the caret and DEselects what
        // we just selected. Deferring the select with setTimeout(0)
        // runs it after the click sequence settles. Without this,
        // clicking into "50" and typing "20" lands on "5020".
        onFocus={(e) => {
          const target = e.target
          setTimeout(() => {
            if (document.activeElement === target) target.select()
          }, 0)
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const parsed = parseFloat(e.target.value)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
        onKeyDown={(e) => handleShiftArrowStep(e, value, step, onChange)}
        className={[
          'h-7 w-full rounded-md border border-input field-surface px-2 py-0.5',
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
  /**
   * Optional content rendered on the right side of the header (between
   * the title and the chevron). Used for per-section quick actions
   * (Fill type selector, Add fill, etc.). Stops pointer events from
   * bubbling so clicking these doesn't toggle collapse.
   */
  headerRight?: React.ReactNode
}

/**
 * Identity-name input. The name doubles as the Magic Move pair key, so
 * we enforce per-slide uniqueness — two objects on the SAME slide can't
 * share a name (that would be ambiguous), but the same name on TWO
 * slides is intentional and triggers the Magic Move pairing in
 * playTransition.ts. Validation is local-only on commit (Enter / blur):
 * during typing the input shows what the user is typing, on commit we
 * either save (unique) or revert + flash a red border.
 */
function NameField({
  obj,
  objects,
  disabled,
  onCommit,
}: {
  obj: SlideObject
  objects: SlideObject[]
  disabled: boolean
  onCommit: (next: string | undefined) => void
}) {
  const [draft, setDraft] = useState<string>(obj.name ?? '')
  const [conflict, setConflict] = useState<boolean>(false)
  const externalNameRef = useRef<string>(obj.name ?? '')
  // Sync from obj when the source-of-truth changes from outside (peer
  // edit, undo, etc) — but don't clobber active typing.
  useEffect(() => {
    const next = obj.name ?? ''
    if (next === externalNameRef.current) return
    externalNameRef.current = next
    setDraft(next)
    setConflict(false)
  }, [obj.name])

  const commit = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === (obj.name ?? '')) {
      setConflict(false)
      return
    }
    if (trimmed === '') {
      externalNameRef.current = ''
      setConflict(false)
      onCommit(undefined)
      return
    }
    const collides = objects.some((o) => o.id !== obj.id && o.name === trimmed)
    if (collides) {
      setConflict(true)
      // Revert to last good value after a brief flash so the user sees
      // why the change didn't stick.
      window.setTimeout(() => {
        setDraft(obj.name ?? '')
        setConflict(false)
      }, 1200)
      return
    }
    setConflict(false)
    externalNameRef.current = trimmed
    onCommit(trimmed)
  }

  return (
    <input
      id={`inspector-name-${obj.id}`}
      type="text"
      value={draft}
      placeholder={obj.type}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit(draft)
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          setDraft(obj.name ?? '')
          setConflict(false)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      title={conflict ? 'Another object on this slide already uses that name' : undefined}
      aria-invalid={conflict || undefined}
      className={[
        'h-7 w-full rounded-md border bg-input px-2 py-0.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none',
        conflict
          ? 'border-destructive focus:border-destructive'
          : 'border-border focus:border-primary',
      ].join(' ')}
    />
  )
}

/**
 * Identity section — authored name (Magic Move pair key + layer label)
 * and lock toggle. Shared by the generic shape inspector and by
 * TableInspector so every object type carries the same header chrome.
 *
 * The `children` slot is rendered inside the same `<Section>` after the
 * name + lock row, so callers can append type-specific sub-blocks
 * (e.g. the page-number toggle for text) without duplicating the
 * Section wrapper or the name field wiring.
 */
export function IdentitySection({
  obj,
  objects,
  isViewer,
  patch,
  children,
}: {
  obj: SlideObject
  objects: SlideObject[]
  isViewer: boolean
  patch: (p: SlideObjectPatch<SlideObject>) => void
  children?: React.ReactNode
}) {
  return (
    <Section title="Identity" storageKey="identity">
      <div className="flex items-center gap-2">
        <label
          htmlFor={`inspector-name-${obj.id}`}
          className="w-16 flex-shrink-0 text-xs text-muted-foreground"
        >
          Name
        </label>
        <NameField
          obj={obj}
          objects={objects}
          disabled={isViewer}
          onCommit={(next) => patch({ name: next } as unknown as SlideObjectPatch<SlideObject>)}
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
            'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border',
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
      {children}
    </Section>
  )
}

export function Section({
  title,
  children,
  storageKey,
  defaultCollapsed = false,
  headerRight,
}: SectionProps) {
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
      <div className="relative flex items-center px-3 py-2 hover:bg-accent/40">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          // The toggle covers the full header so the title and the
          // chevron are both clickable, but actions in `headerRight`
          // sit ABOVE it (z-10 + onPointerDown stop) so a click on a
          // pill / icon there doesn't also toggle the section.
          className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
        />
        <span className="pointer-events-none flex-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {headerRight !== undefined && (
          <div
            className="relative z-10 ml-auto flex items-center gap-1"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {headerRight}
          </div>
        )}
        <ChevronDown
          className={`pointer-events-none ml-2 h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ${
            collapsed ? '-rotate-90' : 'rotate-0'
          }`}
          aria-hidden="true"
        />
      </div>
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
  const { role, folderId: deckFolderId } = useDeckRole()
  const isViewer = role === 'viewer'

  // Hooks needed by the slide-number recommendation modal. Always
  // declared here so hook-order stays stable regardless of which
  // sub-inspector renders.
  const api = useApi()
  const { deckCtx } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()
  // Use the optional variant so the Inspector can render during the
  // brief window after a route change when DeckRole hasn't resolved
  // folderId yet — FolderDocGate skips FolderDocProvider in that
  // window and the strict `useFolderTokens()` would throw, taking
  // down the whole editor. Empty snapshot is safe — every token
  // lookup falls through to literal hex.
  const folderTokens = useFolderTokensOptional() ?? emptyTokensSnapshot()
  const [slideNumberPromptOpen, setSlideNumberPromptOpen] = useState(false)
  const slideNumberPromptTargetIdRef = useRef<string | null>(null)
  const closeSlideNumberPrompt = useCallback(() => {
    setSlideNumberPromptOpen(false)
    slideNumberPromptTargetIdRef.current = null
  }, [])
  const footnotesAndPagesStyleId = useMemo<string | null>(() => {
    const match = Object.values(folderTokens.textStyles).find(
      (s) => s.name?.toLowerCase() === 'footnotes and pages',
    )
    return match?.id ?? null
  }, [folderTokens])
  const handleApplyTextStyle = useCallback(() => {
    const targetId = slideNumberPromptTargetIdRef.current
    closeSlideNumberPrompt()
    if (targetId === null || mutationCtx === null) return
    if (footnotesAndPagesStyleId === null) return
    const style = folderTokens.textStyles[footnotesAndPagesStyleId]
    const stylePatch: Record<string, unknown> = {
      isSlideNumber: true,
      textStyleId: footnotesAndPagesStyleId,
      textStyleOverrides: [],
    }
    if (style !== undefined) {
      if (typeof style.family === 'string' && style.family !== '')
        stylePatch['fontFamily'] = style.family
      if (typeof style.weight === 'number') stylePatch['fontWeight'] = style.weight
      if (typeof style.size === 'number' && style.size > 0) stylePatch['fontSize'] = style.size
      if (typeof style.lineHeight === 'number' && style.lineHeight > 0)
        stylePatch['lineHeight'] = style.lineHeight
      if (typeof style.letterSpacing === 'number') stylePatch['letterSpacing'] = style.letterSpacing
      if (
        style.textTransform === 'uppercase' ||
        style.textTransform === 'lowercase' ||
        style.textTransform === 'capitalize'
      ) {
        stylePatch['textTransform'] = style.textTransform
      }
      if (style.color !== undefined) stylePatch['color'] = style.color
    }
    updateObject(mutationCtx, targetId, stylePatch as SlideObjectPatch<TextObject>)
  }, [closeSlideNumberPrompt, footnotesAndPagesStyleId, folderTokens, mutationCtx])
  const handleCreateComponent = useCallback(() => {
    const targetId = slideNumberPromptTargetIdRef.current
    closeSlideNumberPrompt()
    if (targetId === null) return
    if (mutationCtx === null || deckCtx === null || activeSlideId === null) return
    if (deckFolderId === null) return
    // Flag the master text BEFORE promotion so the resulting component
    // master inherits the page-number behaviour.
    updateObject(mutationCtx, targetId, {
      isSlideNumber: true,
    } as unknown as SlideObjectPatch<TextObject>)
    void promoteSelectionToComponent({
      api,
      folderId: deckFolderId,
      deckCtx,
      activeSlideId,
      targetIds: [targetId],
      name: 'Page number',
    }).catch((err: unknown) => {
      console.warn('[Inspector] slide-number → component promote failed', err)
    })
  }, [activeSlideId, api, closeSlideNumberPrompt, deckCtx, deckFolderId, mutationCtx])

  const handleLeaveAsIs = useCallback(() => {
    const targetId = slideNumberPromptTargetIdRef.current
    closeSlideNumberPrompt()
    if (targetId === null || mutationCtx === null) return
    updateObject(mutationCtx, targetId, {
      isSlideNumber: true,
    } as unknown as SlideObjectPatch<TextObject>)
  }, [closeSlideNumberPrompt, mutationCtx])

  // useSlideObjects emits a fresh array reference on every Y.Doc edit
  // (including each Y.Text keystroke during inline edit). Memoise the
  // id lookup so the linear scan only runs when objects or selectedId
  // actually change. Hoisted above the selection-mode early returns so
  // hook order stays stable.
  const obj = useMemo(
    () => (selectedId === null ? undefined : objects.find((o) => o.id === selectedId)),
    [objects, selectedId],
  )

  // Multi-select inspector — align / distribute / layer order.
  if (selectedIds.size > 1) {
    return <MultiSelectInspector selectedIds={[...selectedIds]} />
  }

  if (selectedId === null) {
    return <SlideInspector />
  }

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

  // M29 Phase 2 — Table object has its own inspector with row/col +
  // defaults + active-cell override controls. Skips the generic shape
  // chrome below (fill/stroke/etc. live inside the table's `defaults`).
  if (obj.type === 'table' && mutationCtx !== null) {
    return <TableInspector obj={obj} mutationCtx={mutationCtx} isViewer={isViewer} />
  }

  return (
    <div className="scrollbar-narrative flex flex-col overflow-y-auto">
      {/* M10: viewer mode notice */}
      {isViewer && (
        <div className="border-b border-border bg-muted/50 px-3 py-1.5">
          <p className="text-[10px] text-muted-foreground/80">View only</p>
        </div>
      )}
      {/* P5a: Identity — authored name + lock toggle, shared with the
          table inspector. Name feeds Magic Move pair key and the layer
          label. Lock disables transform handles + click-picking but
          keeps the Inspector functional so the flag can be toggled back
          off. A padlock badge is rendered over the object in the canvas
          so the state is visible without opening this panel. The
          page-number toggle is text-only and passed as children so the
          shared chrome stays type-agnostic. */}
      <IdentitySection obj={obj} objects={objects} isViewer={isViewer} patch={patch}>
        {obj.type === 'text' && (
          <div className="flex items-center gap-2">
            <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Field</span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (obj.isSlideNumber === true) {
                  // Toggling OFF — never gated by the recommendation modal.
                  patch({
                    isSlideNumber: undefined,
                  } as unknown as SlideObjectPatch<SlideObject>)
                  return
                }
                // Toggling ON. If this is the first page-number text in
                // the deck, surface the recommendation modal. Otherwise
                // just flip the flag.
                let firstInDeck = true
                if (deckCtx !== null) {
                  outer: for (const slide of listSlides(deckCtx)) {
                    for (const o of slide.objects) {
                      if (
                        o.type === 'text' &&
                        (o as TextObject).isSlideNumber === true &&
                        o.id !== obj.id
                      ) {
                        firstInDeck = false
                        break outer
                      }
                    }
                  }
                }
                if (firstInDeck) {
                  slideNumberPromptTargetIdRef.current = obj.id
                  setSlideNumberPromptOpen(true)
                  return
                }
                patch({ isSlideNumber: true } as unknown as SlideObjectPatch<SlideObject>)
              }}
              disabled={isViewer}
              aria-pressed={obj.isSlideNumber === true}
              title="Use this text box as the slide-number field"
              className={[
                'flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-[11px] transition-colors',
                obj.isSlideNumber === true
                  ? 'bg-primary/15 text-primary'
                  : 'field-surface text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                'disabled:opacity-40',
              ].join(' ')}
            >
              <Hash className="h-3 w-3" aria-hidden />
              Page number
            </button>
          </div>
        )}
      </IdentitySection>
      <SlideNumberPromptDialog
        open={slideNumberPromptOpen}
        textStyleAvailable={footnotesAndPagesStyleId !== null}
        onApplyTextStyle={handleApplyTextStyle}
        onCreateComponent={handleCreateComponent}
        onLeaveAsIs={handleLeaveAsIs}
        onCancel={closeSlideNumberPrompt}
      />

      {/* Position — Figma-style condensed block:
          alignment row | X+Y row | rotation + flip row.
          Single-object alignment snaps to the slide canvas (not to the
          selection union — that's the multi-select inspector's job). */}
      <PositionSection obj={obj} patch={patch} disabled={isViewer} layerMutationCtx={mutationCtx} />

      {/* Transparency for object types that don't render an Appearance
          section (text / image / video / line / arrow). Same control,
          label, and visual treatment as the slider inside Appearance
          so the chrome reads identical across object types. Path is
          handled by the FilledShape branch below — it's part of the
          Appearance section and surfaces the same slider there. */}
      {obj.type !== 'rectangle' &&
        obj.type !== 'ellipse' &&
        obj.type !== 'triangle' &&
        obj.type !== 'polygon' &&
        obj.type !== 'path' && (
          <Section title="Transparency" storageKey="transparency">
            <TransparencySlider
              id={`inspector-opacity-${obj.id}`}
              value={obj.opacity}
              onChange={(v) => patch({ opacity: Math.min(1, Math.max(0, v)) })}
            />
          </Section>
        )}

      {/* Appearance — every filled shape. P5b extended the schema with
          optional stroke + corner radius so the same section handles rect,
          ellipse, triangle and polygon. Corner radius is rectangle-only
          (ellipse/triangle/polygon don't have axis-aligned corners). */}
      {(obj.type === 'rectangle' ||
        obj.type === 'ellipse' ||
        obj.type === 'triangle' ||
        obj.type === 'polygon' ||
        obj.type === 'path') && (
        <AppearanceSection
          obj={obj}
          patch={
            patch as (
              p: SlideObjectPatch<
                RectangleObject | EllipseObject | TriangleObject | PolygonObject | PathObject
              >,
            ) => void
          }
        />
      )}

      {/* P5b: Line / Arrow stroke controls. Path uses the full Appearance
          section above (fill + stroke + transparency, no corner radius). */}
      {(obj.type === 'line' || obj.type === 'arrow') && (
        <LineStrokeSection
          obj={obj}
          patch={patch as (p: SlideObjectPatch<LineObject | ArrowObject>) => void}
        />
      )}

      {/* Text properties */}
      {obj.type === 'text' && (
        <TypographySection obj={obj} patch={patch as (p: SlideObjectPatch<TextObject>) => void} />
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

      {/* P5c: Shadow + Blur + Link — every object type. Link was its
          own section pre-redesign; merged into Effects for compactness. */}
      <EffectsSection obj={obj} patch={patch as (p: SlideObjectPatch<SlideObject>) => void} />

      {/* P6: Layer order is now embedded at the top of PositionSection
          (see above) for the single-object inspector. The standalone
          LayerOrderSection still backs the multi-select panel. */}

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

  // Promote the current multi-selection to a shared component template.
  const canCreateTemplate = !isViewer && selectedObjects.length >= 1
  const runCreateTemplate = (): void => {
    if (!canCreateTemplate) return
    window.dispatchEvent(
      new CustomEvent('narrative:create-component-template', { detail: { ids: selectedIds } }),
    )
  }

  return (
    <div className="scrollbar-narrative flex flex-col overflow-y-auto">
      <Section title={`${selectedIds.length} objects`} storageKey="multi-header">
        <p className="text-[10px] text-muted-foreground/70">
          Align, distribute + layer actions apply to every selected object.
        </p>
      </Section>
      <Section title="Component" storageKey="multi-component">
        <button
          type="button"
          onClick={runCreateTemplate}
          disabled={!canCreateTemplate}
          title="Create a reusable component template from the selection"
          className="w-full rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground hover:bg-input/70 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Create component template
        </button>
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
            className="w-full rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground hover:bg-input/70 disabled:cursor-not-allowed disabled:opacity-50"
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
      className="flex items-center justify-center rounded-md border border-input field-surface px-1.5 py-1 text-[10px] text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {Icon !== undefined ? <Icon className="h-3.5 w-3.5" aria-hidden /> : label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Layer order section — shared between single-object and multi-select
// ---------------------------------------------------------------------------

/**
 * Layer-order controls — Front / Forward / Backward / Back as a single
 * row of icon buttons. Used both as a sub-row inside PositionSection
 * (single-object inspector) and wrapped in its own Section by the
 * multi-select inspector.
 */
function LayerOrderControls({
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
  const buttons: { move: LayerMove; title: string; Icon: LucideIcon }[] = [
    { move: 'front', title: 'Bring to front (Cmd+])', Icon: ArrowUpToLine },
    { move: 'forward', title: 'Bring forward (])', Icon: ArrowUp },
    { move: 'backward', title: 'Send backward ([)', Icon: ArrowDown },
    { move: 'back', title: 'Send to back (Cmd+[)', Icon: ArrowDownToLine },
  ]
  return (
    <div
      role="group"
      aria-label="Layer order"
      className="flex items-stretch overflow-hidden rounded-md border border-input field-surface"
    >
      {buttons.map(({ move, title, Icon }, idx) => (
        <button
          key={move}
          type="button"
          aria-label={title}
          title={title}
          disabled={disabled}
          onClick={() => run(move)}
          className={[
            'flex flex-1 items-center justify-center px-2 py-1 transition-colors',
            idx > 0 ? 'border-l border-input' : '',
            'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            'disabled:cursor-not-allowed disabled:opacity-50',
          ].join(' ')}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      ))}
    </div>
  )
}

/**
 * Full-width segmented row of icon toggles. Same outer chrome as
 * LayerOrderControls (single bordered surface, dividers between
 * segments), but each segment carries its own pressed/aria-pressed
 * state so it works for boolean flags like Autoplay / Loop / Muted.
 */
function SegmentedToggleRow({
  ariaLabel,
  segments,
}: {
  ariaLabel: string
  segments: {
    Icon: LucideIcon
    label: string
    pressed: boolean
    onClick: () => void
  }[]
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex items-stretch overflow-hidden rounded-md border border-input field-surface"
    >
      {segments.map(({ Icon, label, pressed, onClick }, idx) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          title={label}
          onClick={onClick}
          className={[
            'flex flex-1 items-center justify-center px-2 py-1 transition-colors',
            idx > 0 ? 'border-l border-input' : '',
            pressed
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          ].join(' ')}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      ))}
    </div>
  )
}

function LayerOrderSection({
  ids,
  mutationCtx,
  disabled,
}: {
  ids: string[]
  mutationCtx: Parameters<typeof moveObjectsLayer>[0]
  disabled: boolean
}) {
  return (
    <Section title="Layer order" storageKey="layer-order">
      <LayerOrderControls ids={ids} mutationCtx={mutationCtx} disabled={disabled} />
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

export function LayersPanel({
  activeIds,
  mutationCtx,
  readOnly,
}: {
  activeIds: string[]
  mutationCtx: Parameters<typeof moveObjectToIndex>[0]
  readOnly: boolean
}) {
  const { objects } = useSlideObjects()
  const { selectOne, selectMany, clear } = useSelection()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(
    null,
  )

  // Layer panel convention matches Figma / Illustrator: front of the
  // canvas (last in Y.Array) is rendered at the TOP of the list.
  // Memoise — `objects` is a fresh array on every Y.Doc edit, so without
  // this we paid for a copy + reverse on every keystroke during inline
  // text edit.
  const rows = useMemo(() => [...objects].reverse(), [objects])
  const activeSet = useMemo(() => new Set(activeIds), [activeIds])

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
                'group relative flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 text-[11px]',
                'cursor-pointer select-none',
                // Match the inspector toggle style: tinted blue fill +
                // primary text/icon, no border accent. Keeps the row
                // chrome identical between active and idle so only the
                // colour change distinguishes selection.
                active ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-accent/40',
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
                  className="rounded-md bg-muted px-1 text-[9px] text-muted-foreground"
                  title={`Group ${o.groupId.slice(0, 4)}`}
                >
                  ∘
                </span>
              )}
              {!readOnly && o.locked !== true && (
                <button
                  type="button"
                  aria-label="Delete layer"
                  title="Delete layer"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (activeSet.has(o.id)) clear()
                    removeObject(mutationCtx, o.id)
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  draggable={false}
                  className="ml-0.5 rounded-md p-0.5 text-muted-foreground/60 opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus:opacity-100 focus:outline-none"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

// Module-const hoisted out of SlideInspector so the joined string isn't
// rebuilt on every render of the inspector (used in three places below).
const SELECT_CLASS = [
  'select-chevron',
  'flex-1 appearance-none rounded-md border border-input field-surface px-2 py-1 pr-7',
  'text-xs text-foreground cursor-pointer',
  'hover:border-border-strong',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-ring',
  'disabled:opacity-40 disabled:cursor-not-allowed',
].join(' ')

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
  // Memoize so we don't re-run an O(n·m) filter+some on every render of the
  // SlideInspector (it ran on every keystroke-driven slides emission). The
  // dependencies are the .objects array references — stable until either
  // slide's object list actually changes structurally.
  const magicMatchedCount = useMemo(() => {
    if (slide === undefined || prevSlide === undefined) return 0
    const prevIds = new Set(prevSlide.objects.map((p) => p.id))
    let n = 0
    for (const o of slide.objects) {
      if (prevIds.has(o.id)) n++
    }
    return n
  }, [slide?.objects, prevSlide?.objects])

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

  // SELECT_CLASS hoisted to module scope above (used in three places below).
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
            onKeyDown={(e) =>
              handleShiftArrowStep(
                e,
                transition.durationMs,
                50,
                (v) => patchTransition({ durationMs: Math.max(0, Math.round(v)) }),
                { min: 0 },
              )
            }
            className={[
              'w-full rounded-md border border-input field-surface px-2 py-0.5',
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
              'rounded-md border px-2 py-1.5 text-[11px] leading-snug',
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

function BackgroundSection({
  slideId,
  background,
  selectClass: _selectClass,
}: BackgroundSectionProps) {
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

  function _setSolidColor(color: number): void {
    updateSlideBackground(deckCtx, slideId, { kind: 'color', color, alpha: 1 })
  }

  // Keep the last-seen gradient around so the closing transition has
  // content to collapse — same trick as FillBody. Without this the
  // gradient panel jump-cuts on switch to solid/image.
  const lastGradientRef = useRef<SlideBackground | null>(null)
  if (current.kind === 'linearGradient' || current.kind === 'radialGradient') {
    lastGradientRef.current = current
  }
  const gradientForRender =
    current.kind === 'linearGradient' || current.kind === 'radialGradient'
      ? current
      : lastGradientRef.current
  const isGradient = current.kind === 'linearGradient' || current.kind === 'radialGradient'

  return (
    <Section title="Background" storageKey="background">
      {/* Single-row type picker + (when solid) inline swatch/hex/alpha,
          mirroring the Fill picker. */}
      <div className="flex items-center gap-1">
        <select
          id={`bg-kind-${slideId}`}
          aria-label="Background type"
          value={kind}
          onChange={(e) => setKind(e.target.value as SlideBackground['kind'])}
          className={[
            'h-7 w-20 flex-shrink-0 rounded-md border border-input field-surface px-1.5 text-[11px] text-foreground',
            'focus:border-ring focus:outline-none',
          ].join(' ')}
        >
          <option value="color">Solid</option>
          <option value="linearGradient">Linear</option>
          <option value="radialGradient">Radial</option>
          <option value="image">Image</option>
        </select>

        {current.kind === 'color' && (
          <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input field-surface px-1.5">
            <TokenColorInput
              value={numberToHex(current.color)}
              onChange={(hex) =>
                updateSlideBackground(deckCtx, slideId, {
                  kind: 'color',
                  color: hexToNumber(hex),
                  alpha: current.alpha ?? 1,
                })
              }
              ariaLabel="Background color"
              showHex
              alpha={current.alpha ?? 1}
              onAlphaChange={(a) =>
                updateSlideBackground(deckCtx, slideId, {
                  kind: 'color',
                  color: current.color,
                  alpha: a,
                })
              }
              inputClassName="!h-5 !w-7"
              hexClassName="!h-5 !border-0 !bg-transparent !px-1 !py-0 !text-[11px] uppercase"
            />
          </div>
        )}
      </div>

      {/* Gradient sub-editor — animated reveal mirrors the object-fill
          flow. minmax(0,1fr) on the column keeps the preview bar
          confined to the inspector width. */}
      <div
        className={[
          'grid overflow-hidden transition-[grid-template-rows,margin] duration-200 ease-out',
          '[grid-template-columns:minmax(0,1fr)]',
          isGradient ? 'mt-1.5 grid-rows-[1fr]' : 'mt-0 grid-rows-[0fr]',
        ].join(' ')}
        aria-hidden={!isGradient}
      >
        <div className="min-h-0 min-w-0">
          {gradientForRender !== null &&
            (gradientForRender.kind === 'linearGradient' ||
              gradientForRender.kind === 'radialGradient') && (
              <GradientStopsEditor
                kind={gradientForRender.kind}
                stops={gradientForRender.stops}
                angleDeg={
                  gradientForRender.kind === 'linearGradient'
                    ? gradientForRender.angleDeg
                    : undefined
                }
                onStopsChange={(stops) =>
                  updateSlideBackground(deckCtx, slideId, { ...gradientForRender, stops })
                }
                onAngleChange={
                  gradientForRender.kind === 'linearGradient'
                    ? (angleDeg) =>
                        updateSlideBackground(deckCtx, slideId, {
                          ...gradientForRender,
                          angleDeg,
                        })
                    : undefined
                }
              />
            )}
        </div>
      </div>

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
// Position section — alignment to slide canvas, X/Y, rotation + flip
// ---------------------------------------------------------------------------

interface PositionSectionProps {
  obj: SlideObject
  patch: (p: SlideObjectPatch<SlideObject>) => void
  disabled: boolean
  /** Optional layer-order mutation context — when present, a row of
   *  Front/Forward/Backward/Back icon buttons is rendered at the top of
   *  the Position section. */
  layerMutationCtx?: Parameters<typeof moveObjectsLayer>[0] | null
}

/**
 * P16: Figma-parity Position block.
 *
 * Layout:
 *   [ align L | C | R ] [ align T | M | B ]
 *   [ X #####         ] [ Y #####         ]
 *   [ rot ##°         ] [ flipH ] [ flipV ]
 *
 * Single-object alignment snaps the object's bounding box to the slide
 * canvas (1920×1080). Multi-object alignment lives in
 * MultiSelectInspector and uses the selection union as the reference,
 * matching Figma / Keynote conventions.
 */
export function PositionSection({
  obj,
  patch,
  disabled,
  layerMutationCtx = null,
}: PositionSectionProps) {
  const rotationDeg = radToDeg(obj.rotation)

  const alignToCanvas = (axis: AlignAxis): void => {
    if (disabled) return
    switch (axis) {
      case 'left':
        patch({ x: 0 })
        return
      case 'right':
        patch({ x: SLIDE_WIDTH - obj.width })
        return
      case 'center-x':
        patch({ x: Math.round((SLIDE_WIDTH - obj.width) / 2) })
        return
      case 'top':
        patch({ y: 0 })
        return
      case 'bottom':
        patch({ y: SLIDE_HEIGHT - obj.height })
        return
      case 'center-y':
        patch({ y: Math.round((SLIDE_HEIGHT - obj.height) / 2) })
        return
    }
  }

  return (
    <Section title="Position" storageKey="position">
      {/* Layer order — Front / Forward / Backward / Back. Lives at the
          top of the Position panel so the most-used spatial controls
          (depth, alignment, X/Y, rotation) are clustered together. */}
      {layerMutationCtx !== null && (
        <>
          <SubLabel>Layer order</SubLabel>
          <LayerOrderControls ids={[obj.id]} mutationCtx={layerMutationCtx} disabled={disabled} />
        </>
      )}

      {/* Alignment */}
      <SubLabel>Alignment</SubLabel>
      <div className="flex items-center gap-1">
        <div
          role="group"
          aria-label="Align horizontally to slide"
          className="flex flex-1 items-stretch overflow-hidden rounded-md border border-input field-surface"
        >
          {[
            {
              axis: 'left' as const,
              label: 'Align left edge of slide',
              Icon: AlignHorizontalJustifyStart,
            },
            {
              axis: 'center-x' as const,
              label: 'Align horizontal centre of slide',
              Icon: AlignHorizontalJustifyCenter,
            },
            {
              axis: 'right' as const,
              label: 'Align right edge of slide',
              Icon: AlignHorizontalJustifyEnd,
            },
          ].map(({ axis, label, Icon }, idx) => (
            <button
              key={axis}
              type="button"
              aria-label={label}
              title={label}
              disabled={disabled}
              onClick={() => alignToCanvas(axis)}
              className={[
                'flex flex-1 items-center justify-center px-2 py-1 transition-colors',
                idx > 0 ? 'border-l border-input' : '',
                'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                'disabled:cursor-not-allowed disabled:opacity-50',
              ].join(' ')}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
            </button>
          ))}
        </div>
        <div
          role="group"
          aria-label="Align vertically to slide"
          className="flex flex-1 items-stretch overflow-hidden rounded-md border border-input field-surface"
        >
          {[
            {
              axis: 'top' as const,
              label: 'Align top edge of slide',
              Icon: AlignVerticalJustifyStart,
            },
            {
              axis: 'center-y' as const,
              label: 'Align vertical centre of slide',
              Icon: AlignVerticalJustifyCenter,
            },
            {
              axis: 'bottom' as const,
              label: 'Align bottom edge of slide',
              Icon: AlignVerticalJustifyEnd,
            },
          ].map(({ axis, label, Icon }, idx) => (
            <button
              key={axis}
              type="button"
              aria-label={label}
              title={label}
              disabled={disabled}
              onClick={() => alignToCanvas(axis)}
              className={[
                'flex flex-1 items-center justify-center px-2 py-1 transition-colors',
                idx > 0 ? 'border-l border-input' : '',
                'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                'disabled:cursor-not-allowed disabled:opacity-50',
              ].join(' ')}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
            </button>
          ))}
        </div>
      </div>

      {/* Position */}
      <SubLabel>Position</SubLabel>
      <div className="flex items-center gap-1">
        <CompactNumberField
          id={`inspector-x-${obj.id}`}
          glyph="X"
          ariaLabel="X position"
          value={obj.x}
          disabled={disabled}
          onChange={(v) => patch({ x: v })}
        />
        <CompactNumberField
          id={`inspector-y-${obj.id}`}
          glyph="Y"
          ariaLabel="Y position"
          value={obj.y}
          disabled={disabled}
          onChange={(v) => patch({ y: v })}
        />
      </div>

      {/* Size — moved here from its own section. Aspect-lock chain
          icon shows pressed/primary state when active so the toggle
          is unmistakable. */}
      <SubLabel>Size</SubLabel>
      <div className="flex items-center gap-1">
        <CompactNumberField
          id={`inspector-w-${obj.id}`}
          glyph="W"
          ariaLabel="Width"
          value={obj.width}
          disabled={disabled}
          onChange={(v) => {
            if (obj.aspectLocked === true && obj.width > 0) {
              const ratio = obj.height / obj.width
              patch({ width: v, height: Math.max(1, Math.round(v * ratio)) })
            } else {
              patch({ width: v })
            }
          }}
        />
        <CompactNumberField
          id={`inspector-h-${obj.id}`}
          glyph="H"
          ariaLabel="Height"
          value={obj.height}
          disabled={disabled}
          onChange={(v) => {
            if (obj.aspectLocked === true && obj.height > 0) {
              const ratio = obj.width / obj.height
              patch({ height: v, width: Math.max(1, Math.round(v * ratio)) })
            } else {
              patch({ height: v })
            }
          }}
        />
        <IconToggleButton
          Icon={obj.aspectLocked === true ? Link2 : Link2Off}
          label={
            obj.aspectLocked === true
              ? 'Aspect ratio: locked — Shift while dragging unlocks'
              : 'Aspect ratio: free — Shift while dragging locks'
          }
          pressed={obj.aspectLocked === true}
          disabled={disabled}
          onClick={() =>
            patch({
              aspectLocked: obj.aspectLocked === true ? undefined : true,
            } as SlideObjectPatch<SlideObject>)
          }
        />
      </div>

      {/* Rotation + flip H / flip V */}
      <SubLabel>Rotation</SubLabel>
      <div className="flex items-center gap-1">
        <CompactNumberField
          id={`inspector-rot-${obj.id}`}
          glyph={<RotateCw className="h-3 w-3" aria-hidden />}
          ariaLabel="Rotation"
          value={rotationDeg}
          step={0.1}
          suffix="°"
          disabled={disabled}
          onChange={(v) => patch({ rotation: degToRad(v) })}
        />
        <IconToggleButton
          Icon={FlipHorizontal}
          label="Flip horizontal"
          pressed={obj.flipH === true}
          disabled={disabled}
          onClick={() => {
            // World-space mirror about the object's vertical centre
            // axis. Identity M_x · R(θ) = R(-θ) · M_x lets us express
            // it as: toggle the local scale.x flag AND negate the
            // rotation. Symmetric shapes (solid rectangle / ellipse)
            // see no change from the scale flip but DO see the
            // rotation flip — which is the visible mirror the user
            // expects. Asymmetric content (image / text / gradient
            // fill) needs both pieces to mirror correctly.
            patch({
              flipH: obj.flipH === true ? undefined : true,
              rotation: -obj.rotation,
            } as SlideObjectPatch<SlideObject>)
          }}
        />
        <IconToggleButton
          Icon={FlipVertical}
          label="Flip vertical"
          pressed={obj.flipV === true}
          disabled={disabled}
          onClick={() => {
            // Same identity for the horizontal axis: M_y · R(θ) =
            // R(-θ) · M_y. Composing flipH then flipV therefore
            // collapses to a 180° rotation, matching Figma.
            patch({
              flipV: obj.flipV === true ? undefined : true,
              rotation: -obj.rotation,
            } as SlideObjectPatch<SlideObject>)
          }}
        />
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Appearance section — fill + stroke + (rectangle-only) corner radius
// ---------------------------------------------------------------------------

export type FilledShape =
  | RectangleObject
  | EllipseObject
  | TriangleObject
  | PolygonObject
  | PathObject

interface AppearanceSectionProps {
  obj: FilledShape
  patch: (p: SlideObjectPatch<FilledShape>) => void
}

function AppearanceSection({ obj, patch }: AppearanceSectionProps) {
  return (
    <Section title="Appearance" storageKey="appearance">
      {/* Closed-path toggle — paths only. Closed paths can be filled;
          open paths are stroke-only regardless of the Fill control. */}
      {obj.type === 'path' && (
        <PathClosedToggle obj={obj} patch={patch as (p: SlideObjectPatch<PathObject>) => void} />
      )}

      <SubLabel>Fill</SubLabel>
      <FillBody obj={obj} patch={patch} />

      <SubLabel>Stroke</SubLabel>
      <StrokeBody obj={obj} patch={patch} />

      {/* Corner radius — rectangle only. Uniform slider + per-corner expand. */}
      {obj.type === 'rectangle' && (
        <>
          <SubLabel>Corner radius</SubLabel>
          <CornerRadiusRow
            obj={obj}
            patch={patch as (p: SlideObjectPatch<RectangleObject>) => void}
          />
        </>
      )}

      <SubLabel>Transparency</SubLabel>
      {/* Whole-object transparency. `obj.opacity` is applied to the
          renderer's container, so it dims fill, stroke, image, text
          and any nested decoration uniformly — independent of the
          per-fill / per-stroke alpha. Slider + numeric % so coarse
          drags and precise typing both work. */}
      <TransparencySlider
        id={`inspector-opacity-${obj.id}`}
        value={obj.opacity}
        onChange={(v) => patch({ opacity: v } as SlideObjectPatch<FilledShape>)}
      />
    </Section>
  )
}

function PathClosedToggle({
  obj,
  patch,
}: {
  obj: PathObject
  patch: (p: SlideObjectPatch<PathObject>) => void
}) {
  const closed = obj.closed === true
  return (
    <div className="flex items-center justify-between pb-1.5">
      <SubLabel>Path</SubLabel>
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={closed}
          onChange={(e) =>
            patch({
              closed: e.target.checked ? true : undefined,
            } as unknown as SlideObjectPatch<PathObject>)
          }
          className="accent-primary"
        />
        Closed
      </label>
    </div>
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
  // Derive the picker mode directly from the Y.Doc value so a peer
  // flipping the shape (uniform number ↔ per-corner object) is reflected
  // locally without remount. Toggling locally also writes to Y.Doc so
  // the mode is shared, not just the values.
  const perCorner = typeof obj.cornerRadius === 'object' && obj.cornerRadius !== null

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
      <div className="flex items-center gap-1">
        <input
          type="range"
          aria-label="Corner radius"
          min={0}
          max={Math.max(1, Math.round(maxR))}
          step={1}
          value={uniformVal}
          disabled={perCorner}
          onChange={(e) => setUniform(Number.parseFloat(e.target.value))}
          className={[
            'flex-1 accent-primary transition-opacity',
            perCorner ? 'pointer-events-none opacity-40' : '',
          ].join(' ')}
        />
        <input
          type="number"
          aria-label="Corner radius value"
          min={0}
          max={Math.round(maxR)}
          value={Math.round(uniformVal)}
          disabled={perCorner}
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value)
            if (Number.isFinite(v)) setUniform(v)
          }}
          onKeyDown={(e) =>
            handleShiftArrowStep(e, uniformVal, 1, setUniform, {
              min: 0,
              max: Math.round(maxR),
            })
          }
          className={[
            'w-16 flex-shrink-0 rounded-md border border-input field-surface px-2 py-0.5',
            'text-xs text-foreground focus:border-ring focus:outline-none',
            'transition-opacity',
            perCorner ? 'pointer-events-none opacity-40' : '',
          ].join(' ')}
        />
        <button
          type="button"
          aria-label={perCorner ? 'Collapse to single radius' : 'Edit each corner separately'}
          aria-pressed={perCorner}
          title={perCorner ? 'Collapse to single radius' : 'Edit each corner separately'}
          onClick={() => {
            if (perCorner) {
              setUniform(current.tl)
            } else {
              const seed = uniformVal
              patch({
                cornerRadius: { tl: seed, tr: seed, br: seed, bl: seed },
              } as unknown as SlideObjectPatch<RectangleObject>)
            }
          }}
          className={[
            'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-input',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            perCorner
              ? 'bg-primary/15 text-primary'
              : 'field-surface text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          ].join(' ')}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M1.5 5 V1.5 H5" />
            <path d="M9 1.5 H12.5 V5" />
            <path d="M12.5 9 V12.5 H9" />
            <path d="M5 12.5 H1.5 V9" />
          </svg>
        </button>
      </div>

      <div
        className={[
          'grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out',
          perCorner ? 'mt-1.5 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0',
        ].join(' ')}
        aria-hidden={!perCorner}
      >
        <div className="overflow-hidden">
          <div className="grid grid-cols-2 gap-1.5">
            {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
              <div key={c} className="flex items-center gap-1">
                <span className="w-5 text-[10px] uppercase text-muted-foreground">{c}</span>
                <input
                  type="number"
                  aria-label={`${c} corner radius`}
                  min={0}
                  max={Math.round(maxR)}
                  value={Math.round(current[c])}
                  tabIndex={perCorner ? 0 : -1}
                  onChange={(e) => {
                    const v = Number.parseFloat(e.target.value)
                    if (Number.isFinite(v)) setCorner(c, v)
                  }}
                  onKeyDown={(e) =>
                    handleShiftArrowStep(e, current[c], 1, (v) => setCorner(c, v), {
                      min: 0,
                      max: Math.round(maxR),
                    })
                  }
                  className={[
                    'flex-1 rounded-md border border-input field-surface px-2 py-0.5',
                    'text-xs text-foreground focus:border-ring focus:outline-none',
                  ].join(' ')}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Fill picker — solid / linear gradient / radial gradient / token (M16 P2)
// ---------------------------------------------------------------------------

type FillMode = 'solid' | 'linearGradient' | 'radialGradient' | 'image'

function fillModeOf(style: FillStyle | undefined, _fillIsToken: boolean): FillMode {
  // M16 P2 follow-up: tokens are no longer a separate fill mode — the
  // fill picker always shows the folder palette in the Solid row, and
  // a TokenRef just marks the solid fill as "linked" to a token.
  if (style === undefined) return 'solid'
  return style.kind
}

/**
 * Stroke row — same layout as FillBody. Single row with a Solid /
 * Dashed dropdown and a colour swatch + hex pill, plus a small
 * thickness field on the next line.
 *
 * "Off" is implicit: thickness 0 (or missing) ⇒ no stroke renders,
 * since the schema treats missing `stroke` as no stroke and width 0
 * draws nothing. Any change to colour / dropdown / thickness fills
 * in sensible defaults so the user never sees a half-applied state.
 */
function StrokeBody({
  obj,
  patch,
}: {
  obj: FilledShape
  patch: (p: SlideObjectPatch<FilledShape>) => void
}) {
  const strokeHex = numberToHex(colourAsNumber(obj.stroke) ?? 0x000000)
  const strokeAlpha = obj.strokeAlpha ?? 1
  const strokeWidth = obj.strokeWidth ?? 0
  // PathObject historically uses `dash` (boolean) where the parametric
  // shapes use `strokeDash`. Read whichever the object carries; on
  // write below, target the right field per type.
  const dashed = obj.type === 'path' ? (obj as PathObject).dash === true : obj.strokeDash === true

  // Picking a colour or changing the dash style implies the user
  // wants the stroke visible — bump width to 1 if it's currently 0
  // so the choice has a visible effect. Touching `stroke` keeps it
  // set so colour changes survive a width-to-zero excursion.
  const ensureStrokeVisible = (
    extra: SlideObjectPatch<FilledShape>,
  ): SlideObjectPatch<FilledShape> => {
    if (strokeWidth > 0 && obj.stroke !== undefined) return extra
    return {
      ...extra,
      ...(obj.stroke === undefined ? { stroke: 0x000000 } : {}),
      ...(strokeWidth === 0 ? { strokeWidth: 1 } : {}),
    } as SlideObjectPatch<FilledShape>
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <select
          aria-label="Stroke style"
          value={dashed ? 'dashed' : 'solid'}
          onChange={(e) => {
            const next = e.target.value === 'dashed'
            const dashPatch =
              obj.type === 'path'
                ? ({ dash: next ? true : undefined } as unknown as SlideObjectPatch<FilledShape>)
                : ({
                    strokeDash: next ? true : undefined,
                  } as unknown as SlideObjectPatch<FilledShape>)
            patch(ensureStrokeVisible(dashPatch))
          }}
          className={[
            'h-7 w-20 flex-shrink-0 rounded-md border border-input field-surface px-1.5 text-[11px] text-foreground',
            'focus:border-ring focus:outline-none',
          ].join(' ')}
        >
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
        </select>

        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input field-surface px-1.5">
          <TokenColorInput
            value={strokeHex}
            onChange={(hex) =>
              patch(
                ensureStrokeVisible({
                  stroke: hexToNumber(hex),
                } as SlideObjectPatch<FilledShape>),
              )
            }
            ariaLabel="Stroke color"
            showHex
            alpha={strokeAlpha}
            onAlphaChange={(a) => patch({ strokeAlpha: a } as SlideObjectPatch<FilledShape>)}
            inputClassName="!h-5 !w-7"
            hexClassName="!h-5 !border-0 !bg-transparent !px-1 !py-0 !text-[11px] uppercase"
          />
        </div>
      </div>

      {/* Thickness + corner-join. Thickness controls visibility
          (0 = off). The join group sets how stroked corners render
          on rectangles / triangles / polygons / paths — irrelevant
          for ellipses, which have no corners. */}
      <div className="flex items-center gap-1">
        <div className="w-24">
          <CompactNumberField
            id={`inspector-stroke-w-${obj.id}`}
            glyph="W"
            ariaLabel="Stroke width"
            value={strokeWidth}
            step={0.5}
            onChange={(v) => {
              const clamped = Math.max(0, v)
              // If the user is enabling stroke for the first time
              // and there's no colour yet, seed black so the bump
              // is visible.
              if (clamped > 0 && obj.stroke === undefined) {
                patch({
                  strokeWidth: clamped,
                  stroke: 0x000000,
                } as SlideObjectPatch<FilledShape>)
              } else {
                patch({ strokeWidth: clamped } as SlideObjectPatch<FilledShape>)
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}

export function FillBody({
  obj,
  patch,
  onClear,
  emptyFill,
}: {
  obj: FilledShape
  patch: (p: SlideObjectPatch<FilledShape>) => void
  /**
   * Override for the picker's "No color" button. When omitted, FillBody
   * drops the visible fill by zeroing `fillAlpha` (schema-safe — `fill`
   * is required on most FilledShape variants, so we can't just delete
   * it). When the parent has a richer notion of "no fill" — e.g. a
   * TableDefaults shim that can truly remove the `fill` field — it
   * passes its own clear handler here.
   */
  onClear?: (() => void) | undefined
  /**
   * Parent-supplied override for the empty-fill display state. When
   * the host's schema can truly clear the fill (TableDefaults.fill,
   * which is optional), the picker should show "No color" instead of
   * the seed hex it fell back to. When omitted, FillBody infers from
   * `obj.fillAlpha === 0` (the schema-safe "no fill" representation
   * for FilledShape variants whose `fill` field is required).
   */
  emptyFill?: boolean
}) {
  const folderTokensSnapshot = useFolderTokens()
  const { folderId } = useDeckRole()
  const navigate = useNavigate()
  // Convert the colors Record to an array for rendering
  const colorTokensList: ColorTokenSnapshot[] = Object.values(folderTokensSnapshot.colors)

  // M16 P2: detect if current fill is a TokenRef.
  // `obj.fill` is typed as `number | TokenRef` — at runtime the Yjs value may
  // be a TokenRef object when the state-sync agent writes one.
  const rawFill: number | TokenRef = obj.fill as number | TokenRef
  const currentTokenRef: TokenRef | null = isTokenRef(rawFill) ? rawFill : null
  const fillIsToken = currentTokenRef !== null

  const committedMode = fillModeOf(obj.fillStyle, fillIsToken)
  // What the user last asked for, which is ahead of `committedMode` until the
  // patch has gone through Y.Doc and come back as new props. Two changes in
  // quick succession (Linear, then Solid before the round-trip lands) would
  // otherwise see the pre-Linear mode on the second one and discard it as a
  // no-op — leaving the gradient in the document while the dropdown reads
  // "Solid". Cleared as soon as the document agrees.
  const requestedModeRef = useRef<FillMode | null>(null)
  if (requestedModeRef.current === committedMode) requestedModeRef.current = null
  const mode = requestedModeRef.current ?? committedMode
  // PathObject's `fill` is optional — fall back to white so the picker
  // and gradient seed always have a starting colour.
  // When fill is a token, resolve to the current literal for seed purposes.
  const resolvedTokenHex =
    currentTokenRef !== null
      ? (resolveTokenValue(currentTokenRef, folderTokensSnapshot) ?? '#ffffff')
      : null
  const solidHex = resolvedTokenHex ?? numberToHex(typeof rawFill === 'number' ? rawFill : 0xffffff)
  const fillAlpha = obj.fillAlpha ?? 1

  // The linked token's metadata (name, value) for the "Linked:" chip
  const tokenIdFromRef =
    currentTokenRef !== null ? (currentTokenRef.$token.split('.')[1] ?? null) : null
  const linkedToken =
    tokenIdFromRef !== null ? (folderTokensSnapshot.colors[tokenIdFromRef] ?? null) : null

  // Keep the last-seen gradient / image fillStyle around so the closing
  // transition has content to collapse. Without this, switching mode →
  // solid clears fillStyle synchronously and the sub-editor unmounts
  // before the height transition runs, producing a jump-cut close.
  const lastGradientRef = useRef<FillStyle | null>(null)
  const lastImageRef = useRef<ImageFillStyle | null>(null)
  if (obj.fillStyle !== undefined && obj.fillStyle.kind !== 'image') {
    lastGradientRef.current = obj.fillStyle
  }
  if (obj.fillStyle?.kind === 'image') {
    lastImageRef.current = obj.fillStyle
  }
  const gradientForRender =
    obj.fillStyle !== undefined && obj.fillStyle.kind !== 'image'
      ? obj.fillStyle
      : lastGradientRef.current
  const imageForRender = obj.fillStyle?.kind === 'image' ? obj.fillStyle : lastImageRef.current

  const setMode = (next: FillMode): void => {
    if (next === mode) return
    requestedModeRef.current = next
    // If the current fill is a TokenRef and we're switching away from
    // solid, unlink (write resolved hex as a literal first).
    if (fillIsToken && next !== 'solid') {
      patch({ fill: hexToNumber(solidHex) } as unknown as SlideObjectPatch<FilledShape>)
    }
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
    // Seed a two-stop gradient from the current solid colour + a darker
    // tint of itself (multiply RGB by 0.55) so the object reads as a
    // gradient without slamming to pure black on the second stop.
    const startColor = typeof rawFill === 'number' ? rawFill : 0xffffff
    const r = (startColor >> 16) & 0xff
    const g = (startColor >> 8) & 0xff
    const b = startColor & 0xff
    const tint = (c: number): number => Math.max(0, Math.min(255, Math.round(c * 0.55)))
    const endColor = (tint(r) << 16) | (tint(g) << 8) | tint(b)
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
      {/* Single row: type dropdown + colour swatch / hex. The fill-
          alpha popover slider stays available inside the colour
          picker; whole-object opacity is the separate Transparency
          slider below. */}
      <div className="flex items-center gap-1">
        <select
          aria-label="Fill type"
          value={mode}
          onChange={(e) => setMode(e.target.value as FillMode)}
          className={[
            'h-7 w-20 flex-shrink-0 rounded-md border border-input field-surface px-1.5 text-[11px] text-foreground',
            'focus:border-ring focus:outline-none',
          ].join(' ')}
        >
          <option value="solid">Solid</option>
          <option value="linearGradient">Linear</option>
          <option value="radialGradient">Radial</option>
          <option value="image">Image</option>
        </select>

        {mode === 'solid' && (
          <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input field-surface px-1.5">
            <TokenColorInput
              value={solidHex}
              onChange={(hex) => patch({ fill: hexToNumber(hex) })}
              ariaLabel="Fill color"
              showHex={!fillIsToken}
              alpha={fillAlpha}
              onAlphaChange={(a) => patch({ fillAlpha: a } as SlideObjectPatch<FilledShape>)}
              inputClassName="!h-5 !w-7"
              hexClassName="!h-5 !border-0 !bg-transparent !px-1 !py-0 !text-[11px] uppercase"
              tokenColors={colorTokensList}
              activeTokenRef={currentTokenRef}
              onTokenSelect={(tokenRef) =>
                patch({
                  fill: tokenRef,
                  fillStyle: undefined,
                } as unknown as SlideObjectPatch<FilledShape>)
              }
              linkedLabel={fillIsToken && linkedToken !== null ? linkedToken.name : undefined}
              onUnlink={
                fillIsToken && linkedToken !== null
                  ? () =>
                      patch({
                        fill: hexToNumber(linkedToken.value),
                        fillStyle: undefined,
                      } as unknown as SlideObjectPatch<FilledShape>)
                  : undefined
              }
              // "No color". Default path zeroes fillAlpha — FilledShape
              // schema requires `fill`, so dropping coverage is the
              // schema-safe way to render nothing. Parents with a
              // richer schema (TableDefaults supports `fill?`) inject
              // their own handler here and remove the field outright.
              onClear={
                onClear ??
                (() =>
                  patch({
                    fillAlpha: 0,
                    fillStyle: undefined,
                  } as unknown as SlideObjectPatch<FilledShape>))
              }
              // Parent's truth wins; otherwise derive from alpha for the
              // shape default (`fill` is required so we can't tell from
              // the value itself whether it's "set" or "unset").
              emptyLabel={(emptyFill ?? fillAlpha === 0) && !fillIsToken ? 'No color' : undefined}
              onOpenFolderSettings={
                folderId !== null ? () => void navigate(`/folder/${folderId}/settings`) : undefined
              }
            />
          </div>
        )}
      </div>

      {/* Folder palette is rendered inside the ColorInput popover (above
          Recents). When the fill is linked to a token, the row above
          shows a "Linked: <name> [×]" chip in place of the hex input. */}

      {/* Gradient sub-editor — keeps the previous fillStyle mounted while
          collapsing so the closing animation has content to slide. The
          grid-rows trick animates intrinsic height without measuring.
          grid-cols-[minmax(0,1fr)] forces the column to respect the
          parent width so children with w-full don't push the cell past
          the inspector's right edge. */}
      <div
        className={[
          'grid overflow-hidden transition-[grid-template-rows,margin] duration-200 ease-out',
          '[grid-template-columns:minmax(0,1fr)]',
          mode === 'linearGradient' || mode === 'radialGradient'
            ? 'mt-1.5 grid-rows-[1fr]'
            : 'mt-0 grid-rows-[0fr]',
        ].join(' ')}
        aria-hidden={!(mode === 'linearGradient' || mode === 'radialGradient')}
      >
        <div className="min-h-0 min-w-0">
          {gradientForRender !== null && gradientForRender.kind !== 'image' && (
            <GradientEditor
              fillStyle={gradientForRender}
              onChange={(next) => {
                // The editor stays mounted while the panel collapses so the
                // close animation has something to slide. Anything it emits
                // after the mode moved on would resurrect the gradient.
                if (mode !== 'linearGradient' && mode !== 'radialGradient') return
                patch({ fillStyle: next } as SlideObjectPatch<FilledShape>)
              }}
            />
          )}
        </div>
      </div>

      <div
        className={[
          'grid overflow-hidden transition-[grid-template-rows,margin] duration-200 ease-out',
          '[grid-template-columns:minmax(0,1fr)]',
          mode === 'image' ? 'mt-1.5 grid-rows-[1fr]' : 'mt-0 grid-rows-[0fr]',
        ].join(' ')}
        aria-hidden={mode !== 'image'}
      >
        <div className="min-h-0 min-w-0">
          {imageForRender !== null && (
            <ImageFillEditor
              fillStyle={imageForRender}
              onChange={(next) => {
                // Same collapse guard as the gradient editor above.
                if (mode !== 'image') return
                patch({ fillStyle: next } as SlideObjectPatch<FilledShape>)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// FillTokenPanel was the standalone token swatch grid; superseded by
// the folder palette row inside ColorInput's popover.

const MAX_GRADIENT_STOPS = 10

function GradientEditor({
  fillStyle,
  onChange,
}: {
  fillStyle: FillStyle
  onChange: (next: FillStyle) => void
}) {
  if (fillStyle.kind === 'image') return null
  return (
    <GradientStopsEditor
      kind={fillStyle.kind}
      stops={fillStyle.stops}
      angleDeg={fillStyle.kind === 'linearGradient' ? fillStyle.angleDeg : undefined}
      onStopsChange={(stops) => onChange({ ...fillStyle, stops } as FillStyle)}
      onAngleChange={
        fillStyle.kind === 'linearGradient'
          ? (angleDeg) => onChange({ ...fillStyle, angleDeg } as FillStyle)
          : undefined
      }
    />
  )
}

/**
 * Figma-style stops editor. Pure on its inputs — works equally well
 * against object FillStyle gradients and slide backgrounds. The
 * angle row only renders for linear gradients (caller passes
 * `angleDeg` + `onAngleChange`); it slides in / out via the
 * grid-rows trick so flipping kinds doesn't jump-cut.
 */
function GradientStopsEditor({
  kind,
  stops,
  angleDeg,
  onStopsChange,
  onAngleChange,
}: {
  kind: 'linearGradient' | 'radialGradient'
  stops: FillGradientStop[]
  angleDeg: number | undefined
  onStopsChange: (next: FillGradientStop[]) => void
  onAngleChange: ((next: number) => void) | undefined
}) {
  const canAdd = stops.length < MAX_GRADIENT_STOPS
  const canRemove = stops.length > 2

  const sorted = [...stops].sort((a, b) => a.offset - b.offset)
  const previewCss = `linear-gradient(90deg, ${sorted
    .map((s) => `${numberToRgba(s.color, s.alpha ?? 1)} ${(s.offset * 100).toFixed(2)}%`)
    .join(', ')})`

  const updateStop = (idx: number, patchStop: Partial<FillGradientStop>): void => {
    onStopsChange(stops.map((s, i) => (i === idx ? { ...s, ...patchStop } : s)))
  }

  const removeStop = (idx: number): void => {
    if (!canRemove) return
    onStopsChange(stops.filter((_, i) => i !== idx))
  }

  const addStop = (): void => {
    if (!canAdd) return
    const sortedIdx = sorted.map((s, i) => ({ s, i }))
    let bestGap = -1
    let insertAfterSortedIdx = 0
    for (let i = 0; i < sortedIdx.length - 1; i++) {
      const gap = sortedIdx[i + 1]!.s.offset - sortedIdx[i]!.s.offset
      if (gap > bestGap) {
        bestGap = gap
        insertAfterSortedIdx = i
      }
    }
    const a = sortedIdx[insertAfterSortedIdx]!.s
    const b = sortedIdx[insertAfterSortedIdx + 1]!.s
    const midOffset = (a.offset + b.offset) / 2
    const midColor = mixColors(a.color, b.color, 0.5)
    const midAlpha = ((a.alpha ?? 1) + (b.alpha ?? 1)) / 2
    const newStop: FillGradientStop = {
      color: midColor,
      offset: midOffset,
      ...(midAlpha < 1 ? { alpha: midAlpha } : {}),
    }
    onStopsChange([...stops, newStop])
  }

  const setAngle = (deg: number): void => {
    if (onAngleChange === undefined) return
    onAngleChange(((deg % 360) + 360) % 360)
  }

  const isLinear =
    kind === 'linearGradient' && angleDeg !== undefined && onAngleChange !== undefined

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <GradientPreviewBar
        stops={stops}
        previewCss={previewCss}
        onUpdate={(idx, patchStop) => updateStop(idx, patchStop)}
      />

      <div
        className={[
          'grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out',
          '[grid-template-columns:minmax(0,1fr)]',
          isLinear ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        ].join(' ')}
        aria-hidden={!isLinear}
      >
        <div className="min-h-0 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="w-12 text-[10px] uppercase text-muted-foreground">Angle</span>
            <input
              type="range"
              aria-label="Gradient angle"
              min={0}
              max={360}
              value={angleDeg ?? 0}
              disabled={!isLinear}
              onChange={(e) => setAngle(Number.parseFloat(e.target.value))}
              className="flex-1 accent-primary"
            />
            <span className="w-10 text-right text-[10px] tabular-nums text-muted-foreground">
              {Math.round(angleDeg ?? 0)}°
            </span>
            <button
              type="button"
              aria-label="Rotate 90°"
              title="Rotate 90°"
              disabled={!isLinear}
              onClick={() => isLinear && setAngle((angleDeg ?? 0) + 90)}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-input field-surface text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCw className="h-3 w-3" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase text-muted-foreground">Stops</span>
        <button
          type="button"
          aria-label="Add gradient stop"
          title={canAdd ? 'Add stop' : `Max ${MAX_GRADIENT_STOPS} stops`}
          onClick={addStop}
          disabled={!canAdd}
          className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-sm leading-none">+</span>
        </button>
      </div>

      <div className="flex flex-col gap-1">
        {stops.map((stop, idx) => (
          <GradientStopRow
            key={idx}
            stop={stop}
            canRemove={canRemove}
            onChange={(patchStop) => updateStop(idx, patchStop)}
            onRemove={() => removeStop(idx)}
          />
        ))}
      </div>
    </div>
  )
}

function GradientPreviewBar({
  stops,
  previewCss,
  onUpdate,
}: {
  stops: FillGradientStop[]
  previewCss: string
  onUpdate: (idx: number, patch: Partial<FillGradientStop>) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const handleSlotRefs = useRef<(HTMLDivElement | null)[]>([])
  // Track whether the pointer actually moved during a press so a
  // click-without-drag can fall through to the dblclick handler.
  const draggedRef = useRef(false)
  // While dragging, paint the handle from local state instead of the
  // prop so the cursor and handle move 1:1 regardless of the Yjs +
  // React re-render round-trip. Cleared on pointerup; the prop value
  // then matches what we last committed and the handoff is seamless.
  const [dragOverride, setDragOverride] = useState<{
    idx: number
    offset: number
  } | null>(null)

  const beginDrag = (idx: number, e: React.PointerEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const bar = barRef.current
    if (bar === null) return
    const rect = bar.getBoundingClientRect()
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    draggedRef.current = false
    const startX = e.clientX

    // rAF-coalesce the Yjs writes so a 120Hz pointer doesn't fire
    // 120 transactions per second through the whole Inspector tree.
    // `latestOffset` always holds the most-recent value seen since
    // the last flush so the rAF callback writes exactly that.
    let pendingFrame: number | null = null
    let latestOffset: number | null = null
    const flush = (): void => {
      pendingFrame = null
      if (latestOffset !== null) onUpdate(idx, { offset: latestOffset })
    }

    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 2) draggedRef.current = true
      if (!draggedRef.current) return
      const x = ev.clientX - rect.left
      const t = Math.max(0, Math.min(1, x / Math.max(1, rect.width)))
      latestOffset = t
      // Instant visual feedback — bypasses Yjs entirely.
      setDragOverride({ idx, offset: t })
      if (pendingFrame === null) pendingFrame = requestAnimationFrame(flush)
    }
    const up = (ev: PointerEvent) => {
      // Flush the last pending tick synchronously so the committed
      // offset matches the visible handle before we release the
      // override (no flash back to the previous value).
      if (pendingFrame !== null) {
        cancelAnimationFrame(pendingFrame)
        flush()
      } else if (latestOffset !== null) {
        // pointerup without an outstanding rAF — still need to make
        // sure the very last move committed.
        onUpdate(idx, { offset: latestOffset })
      }
      setDragOverride(null)
      target.releasePointerCapture(ev.pointerId)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const openPicker = (idx: number): void => {
    const trigger = handleSlotRefs.current[idx]?.querySelector(
      'button[aria-label="Stop color picker"]',
    ) as HTMLButtonElement | null
    trigger?.click()
  }

  return (
    <div
      ref={barRef}
      aria-label="Gradient preview"
      className="relative mx-1.5 h-7 rounded-md border border-input"
      style={{ backgroundImage: previewCss }}
    >
      {stops.map((stop, idx) => {
        // During a drag, the active handle paints from local state so
        // the cursor and handle stay locked together regardless of the
        // Yjs / React round-trip. Inactive handles + every handle when
        // not dragging come straight from the prop.
        const effectiveOffset =
          dragOverride !== null && dragOverride.idx === idx ? dragOverride.offset : stop.offset
        const left = `${Math.max(0, Math.min(1, effectiveOffset)) * 100}%`
        return (
          <div
            key={idx}
            ref={(el) => {
              handleSlotRefs.current[idx] = el
            }}
            className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2"
            style={{ left }}
          >
            {/* Hidden ColorInput — popover anchors to its (invisible)
                swatch trigger, which sits exactly under the handle. */}
            <div className="pointer-events-none absolute inset-0 opacity-0">
              <TokenColorInput
                value={numberToHex(stop.color)}
                onChange={(hex) => onUpdate(idx, { color: hexToNumber(hex) })}
                alpha={stop.alpha ?? 1}
                onAlphaChange={(a) => onUpdate(idx, { alpha: a })}
                ariaLabel="Stop color picker"
                showHex={false}
                inputClassName="!h-5 !w-3 !p-0"
              />
            </div>
            <button
              type="button"
              aria-label={`Drag stop ${idx + 1}`}
              title={`Stop ${idx + 1} — drag to move, double-click to edit`}
              onPointerDown={(e) => beginDrag(idx, e)}
              onDoubleClick={() => openPicker(idx)}
              className={[
                'absolute inset-0 cursor-ew-resize rounded-xs border-2 border-white shadow ring-1 ring-black/40',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              ].join(' ')}
              style={{
                backgroundColor: numberToRgba(stop.color, stop.alpha ?? 1),
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

function GradientStopRow({
  stop,
  canRemove,
  onChange,
  onRemove,
}: {
  stop: FillGradientStop
  canRemove: boolean
  onChange: (patch: Partial<FillGradientStop>) => void
  onRemove: () => void
}) {
  const offsetPct = Math.round(stop.offset * 100)
  const alphaPct = Math.round((stop.alpha ?? 1) * 100)

  return (
    <div className="flex w-full min-w-0 items-center gap-1">
      <input
        type="number"
        aria-label="Stop position"
        min={0}
        max={100}
        value={offsetPct}
        onChange={(e) => {
          const v = Number.parseFloat(e.target.value)
          if (!Number.isFinite(v)) return
          onChange({ offset: Math.max(0, Math.min(100, v)) / 100 })
        }}
        className="w-10 flex-shrink-0 rounded-md border border-input field-surface px-1 py-0.5 text-[11px] text-foreground focus:border-ring focus:outline-none"
      />
      <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-input field-surface px-1">
        <TokenColorInput
          value={numberToHex(stop.color)}
          onChange={(hex) => onChange({ color: hexToNumber(hex) })}
          ariaLabel="Stop color"
          showHex
          alpha={stop.alpha ?? 1}
          onAlphaChange={(a) => onChange({ alpha: a })}
          inputClassName="!h-5 !w-5"
          hexClassName="!h-5 !min-w-0 !flex-1 !border-0 !bg-transparent !px-1 !py-0 !text-[11px] uppercase"
        />
      </div>
      <input
        type="number"
        aria-label="Stop alpha"
        min={0}
        max={100}
        value={alphaPct}
        onChange={(e) => {
          const v = Number.parseFloat(e.target.value)
          if (!Number.isFinite(v)) return
          onChange({ alpha: Math.max(0, Math.min(100, v)) / 100 })
        }}
        className="w-10 flex-shrink-0 rounded-md border border-input field-surface px-1 py-0.5 text-[11px] text-foreground focus:border-ring focus:outline-none"
      />
      <button
        type="button"
        aria-label="Remove stop"
        title={canRemove ? 'Remove stop' : 'Need at least 2 stops'}
        onClick={onRemove}
        disabled={!canRemove}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="text-sm leading-none">−</span>
      </button>
    </div>
  )
}

function numberToRgba(color: number, alpha: number): string {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function mixColors(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff
  const ag = (a >> 8) & 0xff
  const ab = a & 0xff
  const br = (b >> 16) & 0xff
  const bg = (b >> 8) & 0xff
  const bb = b & 0xff
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
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
  // Stable per-instance id — keying on fillStyle.assetId would detach
  // the <label htmlFor> from the <input> the moment an upload finished
  // (assetId changes from '' → resolved id) and re-attach to a fresh
  // mount, breaking the click-to-pick affordance for the next upload.
  const fileInputId = useId()

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
          className="flex-1 cursor-pointer rounded-md border border-input field-surface px-2 py-1 text-center text-[10px] text-muted-foreground hover:text-foreground"
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
          className="flex-1 rounded-md border border-input field-surface px-1 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
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
  const strokeHex = numberToHex(colourAsNumber(obj.stroke))
  const dashOn = obj.dash === true

  return (
    <Section title="Stroke" storageKey="stroke">
      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Color</span>
        <div className="flex flex-1 items-center gap-1.5">
          <TokenColorInput
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
        className="flex-1 rounded-md border border-input field-surface px-1 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
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
  const hasBlur = blur > 0

  return (
    <Section title="Effects" storageKey="effects">
      <SubLabel>Effects</SubLabel>

      {/* Shadow */}
      <EffectToggleRow
        label="Shadow"
        enabled={hasShadow}
        onToggle={(on) =>
          patch({
            shadow: on ? DEFAULT_SHADOW : undefined,
          } as unknown as SlideObjectPatch<SlideObject>)
        }
      >
        {hasShadow && obj.shadow !== undefined && (
          <ShadowControls
            shadow={obj.shadow}
            onChange={(next) => patch({ shadow: next } as SlideObjectPatch<SlideObject>)}
          />
        )}
      </EffectToggleRow>

      {/* Blur */}
      <EffectToggleRow
        label="Blur"
        enabled={hasBlur}
        onToggle={(on) =>
          patch({
            blur: on ? (blur > 0 ? blur : 8) : undefined,
          } as unknown as SlideObjectPatch<SlideObject>)
        }
      >
        {hasBlur && (
          <BlurSlider
            value={blur}
            ariaLabel="Blur radius"
            onChange={(v) =>
              patch({
                blur: v === 0 ? undefined : v,
              } as unknown as SlideObjectPatch<SlideObject>)
            }
          />
        )}
      </EffectToggleRow>

      {/* Link — hyperlink target on any object. */}
      <LinkControls obj={obj} patch={patch} />
    </Section>
  )
}

function EffectToggleRow({
  label,
  enabled,
  onToggle,
  children,
}: {
  label: string
  enabled: boolean
  onToggle: (next: boolean) => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-foreground">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Enable ${label.toLowerCase()}`}
          onClick={() => onToggle(!enabled)}
          className={[
            'relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            enabled ? 'bg-primary' : 'bg-input',
          ].join(' ')}
        >
          <span
            className={[
              'pointer-events-none inline-block h-3 w-3 transform rounded-full bg-background shadow',
              'transition-transform',
              enabled ? 'translate-x-3.5' : 'translate-x-0.5',
            ].join(' ')}
          />
        </button>
      </div>
      <div
        className={[
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
          enabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        ].join(' ')}
        aria-hidden={!enabled}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  )
}

function BlurSlider({
  value,
  ariaLabel,
  onChange,
}: {
  value: number
  ariaLabel: string
  onChange: (next: number) => void
}) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <input
        type="range"
        aria-label={ariaLabel}
        min={0}
        max={40}
        step={1}
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
        className="flex-1 accent-primary"
      />
      <div className="w-16 flex-shrink-0">
        <CompactNumberField
          id={`${ariaLabel.replace(/\s+/g, '-').toLowerCase()}-num`}
          ariaLabel={`${ariaLabel} value`}
          value={value}
          step={1}
          onChange={(v) => onChange(Math.max(0, v))}
        />
      </div>
    </div>
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
    <div className="flex flex-col gap-1.5 pt-1">
      {/* Color swatch + hex (Fill-style) + X / Y offsets in one row. */}
      <div className="flex w-full min-w-0 items-center gap-1">
        <TokenColorInput
          value={numberToHex(colourAsNumber(shadow.color))}
          onChange={(hex) => onChange({ ...shadow, color: hexToNumber(hex) })}
          ariaLabel="Shadow color"
          showHex={false}
          alpha={shadow.opacity}
          onAlphaChange={(a) => onChange({ ...shadow, opacity: a })}
          inputClassName="!h-7 !w-9"
        />
        <CompactNumberField
          id="shadow-offset-x"
          glyph="X"
          ariaLabel="Shadow offset X"
          value={shadow.offsetX}
          step={1}
          onChange={(v) => onChange({ ...shadow, offsetX: v })}
        />
        <CompactNumberField
          id="shadow-offset-y"
          glyph="Y"
          ariaLabel="Shadow offset Y"
          value={shadow.offsetY}
          step={1}
          onChange={(v) => onChange({ ...shadow, offsetY: v })}
        />
      </div>

      {/* Blur slider + number input */}
      <div className="flex items-center gap-2">
        <input
          type="range"
          aria-label="Shadow blur"
          min={0}
          max={40}
          step={1}
          value={shadow.blur}
          onChange={(e) => onChange({ ...shadow, blur: Number.parseFloat(e.target.value) })}
          className="flex-1 accent-primary"
        />
        <div className="w-16 flex-shrink-0">
          <CompactNumberField
            id="shadow-blur"
            ariaLabel="Shadow blur value"
            value={shadow.blur}
            step={1}
            onChange={(v) => onChange({ ...shadow, blur: Math.max(0, v) })}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text section
// ---------------------------------------------------------------------------

/**
 * Toggle which optional rows the Typography section renders. Defaults
 * are tuned for a TextObject (everything on); the TableInspector
 * passes a subset because TableDefaults / TableCell don't model
 * paragraph spacing, list markers, glyph stroke or text-style preset
 * binding.
 */
export interface TypographyFeatures {
  /** Folder text-style preset dropdown + actions menu (TextObject-only). */
  textStylePreset?: boolean
  /** Paragraph space-before / space-after row. */
  paragraphSpacing?: boolean
  /** List style (•, 1.) dropdown. */
  listStyle?: boolean
  /** Glyph stroke checkbox + color + width. */
  stroke?: boolean
  /** Text-color alpha popover (TextObject has colorAlpha; TableDefaults does not). */
  colorAlpha?: boolean
}

const FEATURES_TEXT: Required<TypographyFeatures> = {
  textStylePreset: true,
  paragraphSpacing: true,
  listStyle: true,
  stroke: true,
  colorAlpha: true,
}

interface TypographySectionProps {
  obj: TextObject
  patch: (p: SlideObjectPatch<TextObject>) => void
  features?: TypographyFeatures
}

/** Quick-pick bullet glyphs for the Inspector. `null` = per-level default. */
const LIST_BULLET_GLYPHS: ReadonlyArray<string | null> = [null, '•', '◦', '▪', '–', '‣', '★', '→']

/** Numbering formats offered in the Inspector, with sample labels. */
const LIST_NUMBER_FORMATS: ReadonlyArray<[ListNumberFormat, string]> = [
  ['decimal', '1.'],
  ['decimalParen', '1)'],
  ['lowerAlpha', 'a.'],
  ['lowerAlphaParen', 'a)'],
  ['upperAlpha', 'A.'],
  ['upperAlphaParen', 'A)'],
  ['lowerRoman', 'i.'],
  ['upperRoman', 'I.'],
]

interface FontSizeFieldProps {
  obj: TextObject
  patch: (p: SlideObjectPatch<TextObject>) => void
  selAttrs: RichAttrs | null
}

/**
 * Dedicated Size field for text. Uses an uncontrolled-style local
 * draft so per-keystroke commits can't race with the inline-format
 * Y.Text mutation: typing "20" used to land on "5020" because the
 * controlled <input value=…> was being driven from obj.fontSize +
 * selAttrs and the per-digit commit kept feeding the prior partial
 * number back as the prop. Commit only on Enter, ArrowUp/ArrowDown,
 * or blur. The arrow keys also step the value — same UX as a
 * "real" number spinner. Refocus the textarea once focus leaves
 * the whole wrapper so the user can keep typing on the canvas.
 */
function FontSizeField({ obj, patch, selAttrs }: FontSizeFieldProps) {
  const externalValue =
    selAttrs?.fontSize !== undefined && selAttrs.fontSize > 0 ? selAttrs.fontSize : obj.fontSize
  const [draft, setDraft] = useState<string>(String(externalValue))
  const lastExternalRef = useRef<number>(externalValue)

  // Sync draft to external value whenever obj/selAttrs changes from
  // outside this component (e.g. select-all + change box-wide,
  // selection moved into a different run, peer edit). Local edits
  // increment lastExternalRef themselves so they don't trigger a
  // round-trip.
  useEffect(() => {
    if (externalValue !== lastExternalRef.current) {
      lastExternalRef.current = externalValue
      setDraft(String(externalValue))
    }
  }, [externalValue])

  const commit = (raw: string): void => {
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) {
      // Invalid input — snap back to the last known good value.
      setDraft(String(externalValue))
      return
    }
    const next = Math.max(1, parsed)
    lastExternalRef.current = next
    setDraft(String(next))
    const sel = getActiveTextSelection()
    if (sel !== null && sel.objectId === obj.id) {
      if (isEntireContentSelected(obj.id)) {
        clearActiveSelectionAttrs(obj.id, ['fontSize'])
        patch({ fontSize: next })
        return
      }
      const applied = applyInlineFormatIfSelected(obj.id, { fontSize: next })
      if (!applied) patch({ fontSize: next })
      return
    }
    clearAllInlineRunAttrs(obj.text, ['fontSize'])
    patch({ fontSize: next })
  }

  return (
    <div
      data-text-edit-keep-focus
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          refocusActiveTextEdit(obj.id)
        }
      }}
      className="flex items-center gap-2"
    >
      <label
        htmlFor={`inspector-fontsize-${obj.id}`}
        className="w-16 flex-shrink-0 text-xs text-muted-foreground"
      >
        Size
      </label>
      <input
        id={`inspector-fontsize-${obj.id}`}
        type="number"
        step={1}
        min={1}
        value={draft}
        onFocus={(e) => {
          const t = e.target
          // Defer until after the click's caret-placement so the
          // selection actually sticks (browsers reset selection on
          // the trailing mouseup/click).
          setTimeout(() => {
            if (document.activeElement === t) t.select()
          }, 0)
        }}
        onChange={(e) => {
          // Browser native step arrows (the up/down spinners) emit an
          // input event with no `inputType` — typing emits one with
          // `inputType: 'insertText'` etc. Distinguish so we can keep
          // committing immediately on a spinner click while still
          // deferring a typed "20" until Enter/blur.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const inputType = (e.nativeEvent as any).inputType as string | undefined
          const v = e.target.value
          setDraft(v)
          if (inputType === undefined || inputType === '') commit(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(draft)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            setDraft(String(externalValue))
            ;(e.target as HTMLInputElement).blur()
          } else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            // Shift + arrow → 10× step. Browser default is inconsistent,
            // so we drive it explicitly through commit() to keep the
            // run-attr / box patch logic intact.
            e.preventDefault()
            const dir = e.key === 'ArrowUp' ? 1 : -1
            const base = Number.parseFloat(draft)
            const start = Number.isFinite(base) ? base : externalValue
            const next = Math.max(1, start + dir * 10)
            setDraft(String(next))
            commit(String(next))
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            // Let the browser step the value naturally; the resulting
            // input event (with inputType === undefined) will commit
            // through the onChange branch above.
          }
        }}
        onBlur={() => commit(draft)}
        className={[
          'w-full rounded-md border border-input field-surface px-2 py-0.5',
          'text-right text-xs text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        ].join(' ')}
      />
    </div>
  )
}

export function TypographySection({
  obj,
  patch: rawPatch,
  features: featuresIn,
}: TypographySectionProps) {
  const features: Required<TypographyFeatures> = { ...FEATURES_TEXT, ...featuresIn }
  const { role } = useDeckRole()
  const isViewer = role === 'viewer'
  // M16 P2: folder text style tokens
  const folderTokensSnapshot = useFolderTokens()
  const { addToken, updateToken } = useFolderMutations()
  const textStylesList = Object.values(folderTokensSnapshot.textStyles)
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const presetMenuRef = useRef<HTMLDivElement>(null)
  // Close the preset action menu on any outside click.
  useEffect(() => {
    if (!presetMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (presetMenuRef.current && !presetMenuRef.current.contains(e.target as Node)) {
        setPresetMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [presetMenuOpen])
  const [newPresetOpen, setNewPresetOpen] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const newPresetInputRef = useRef<HTMLInputElement>(null)
  // Auto-focus the modal input on open + suggest a non-colliding default.
  useEffect(() => {
    if (!newPresetOpen) return
    const existing = new Set(textStylesList.map((s) => s.name.toLowerCase()))
    let n = 1
    let suggested = 'New style'
    while (existing.has(suggested.toLowerCase())) {
      n += 1
      suggested = `New style ${n}`
    }
    setNewPresetName(suggested)
    requestAnimationFrame(() => {
      newPresetInputRef.current?.focus()
      newPresetInputRef.current?.select()
    })
  }, [newPresetOpen, textStylesList])

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
  // Per-paragraph list state for the targeted paragraph(s) — recomputed on
  // selection change (activeSel dep above triggers the re-render).
  const paraAttrs = currentParagraphAttrs(obj)
  void activeSel

  // M16 P2: linked text style — stored in textStyleId field (cast via unknown
  // because the shared type doesn't have this field yet; state-sync agent owns schema).
  const rawObj: Record<string, unknown> = obj as unknown as Record<string, unknown>
  const textStyleId: string | undefined =
    typeof rawObj['textStyleId'] === 'string' ? rawObj['textStyleId'] : undefined
  const linkedTextStyle =
    textStyleId !== undefined ? (folderTokensSnapshot.textStyles[textStyleId] ?? null) : null

  // Override-tracking patch wrapper. When the object is linked to a
  // folder text style and the patch touches one of the typography
  // fields that participates in preset binding, we record the field
  // name in `textStyleOverrides` so a later edit to the underlying
  // token in folder settings will skip that field. Non-typography
  // patches (align, italic, listStyle, …) pass through unmodified.
  // Patches that already include `textStyleOverrides` (e.g. "Reset to
  // preset" writing []) bypass the wrapper to avoid clobbering an
  // explicit override-state reset.
  //
  // We alias the inbound `patch` prop to `rawPatch` and re-bind the
  // local name `patch` to the wrapper so every existing call site in
  // this section automatically picks up override-tracking with no
  // further edits.
  const patch = (p: SlideObjectPatch<TextObject>): void => {
    const anyP = p as unknown as Record<string, unknown>
    if (textStyleId === undefined) {
      rawPatch(p)
      return
    }
    if ('textStyleOverrides' in anyP) {
      rawPatch(p)
      return
    }
    const touched: TextStyleOverrideKey[] = []
    for (const k of Object.keys(anyP)) {
      if (isTextStyleOverrideKey(k)) touched.push(k)
    }
    if (touched.length === 0) {
      rawPatch(p)
      return
    }
    const existing =
      (obj as { textStyleOverrides?: TextStyleOverrideKey[] }).textStyleOverrides ?? []
    const merged = Array.from(new Set([...existing, ...touched]))
    rawPatch({
      ...p,
      textStyleOverrides: merged,
    } as unknown as SlideObjectPatch<TextObject>)
  }

  const applyTextStyle = (styleId: string | null) => {
    if (styleId === null) {
      // Detach — clear textStyleId, leave inline values intact
      patch({ textStyleId: undefined } as unknown as SlideObjectPatch<TextObject>)
      return
    }
    const style = folderTokensSnapshot.textStyles[styleId]
    if (style === undefined) return
    // Write all style properties + store styleId for the "Linked" indicator.
    // TextStyleTokenSnapshot uses `family`, `weight`, `size` (not fontFamily etc.)
    const colorVal = style.color
    const colorNum =
      typeof colorVal === 'string' && /^#[0-9a-f]{6}$/i.test(colorVal)
        ? hexToNumber(colorVal)
        : isTokenRef(colorVal)
          ? colorVal // pass the TokenRef through; renderer resolves it
          : undefined
    patch({
      ...(style.family !== undefined ? { fontFamily: style.family } : {}),
      ...(style.weight !== undefined ? { fontWeight: style.weight } : {}),
      ...(style.size !== undefined ? { fontSize: style.size } : {}),
      ...(style.lineHeight !== undefined ? { lineHeight: style.lineHeight } : {}),
      ...(style.letterSpacing !== undefined ? { letterSpacing: style.letterSpacing } : {}),
      // Paragraph spacing — write 0 explicitly when the preset has
      // none so reapplying a preset without spacing resets a previous
      // override (mirrors the textTransform behaviour below).
      paragraphSpaceBefore: style.paragraphSpaceBefore ?? 0,
      paragraphSpaceAfter: style.paragraphSpaceAfter ?? 0,
      ...(colorNum !== undefined ? { color: colorNum } : {}),
      // Always write textTransform — undefined explicitly clears any
      // previous override so a preset without a transform resets the
      // object back to "none" instead of inheriting the old value.
      textTransform: style.textTransform ?? 'none',
      textStyleId: style.id,
      // Reset the override list — applying a preset is a fresh
      // baseline, not a per-field tweak.
      textStyleOverrides: [],
    } as unknown as SlideObjectPatch<TextObject>)
  }

  return (
    <>
      {/* P15: removed "Text content" textarea — double-click on the
          text on canvas to edit inline; the side-panel textarea was
          redundant and easy to accidentally type into. */}

      <Section title="Typography" storageKey="typography">
        {/* M16 P2: Text style dropdown — only shown when folder has text styles defined.
            Gated behind the textStylePreset feature so the table inspector can hide
            it (table defaults don't bind to folder text styles). */}
        {features.textStylePreset && textStylesList.length > 0 && (
          <div className="flex items-center gap-2" data-text-edit-keep-focus>
            <label
              htmlFor={`inspector-textstyle-${obj.id}`}
              className="w-16 flex-shrink-0 text-xs text-muted-foreground"
            >
              Preset
            </label>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <select
                id={`inspector-textstyle-${obj.id}`}
                aria-label="Text style preset"
                value={textStyleId ?? ''}
                onChange={(e) => applyTextStyle(e.target.value === '' ? null : e.target.value)}
                disabled={isViewer}
                className={[
                  'h-7 min-w-0 flex-1 rounded-md border border-input field-surface px-1.5 text-[11px] text-foreground',
                  'focus:border-ring focus:outline-none',
                ].join(' ')}
              >
                <option value="">(Custom)</option>
                {textStylesList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {/* Preset action menu — "Update" pushes current object
                  typography back to the linked token (only meaningful
                  when one is linked); "Create new preset" promotes the
                  current object's typography to a new folder text
                  style and links this object to it. */}
              {!isViewer && (
                <div ref={presetMenuRef} className="relative shrink-0">
                  <button
                    type="button"
                    aria-label="Preset actions"
                    aria-haspopup="menu"
                    aria-expanded={presetMenuOpen}
                    onClick={() => setPresetMenuOpen((v) => !v)}
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-input text-muted-foreground hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    title="Preset actions"
                  >
                    <MoreVertical className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  {presetMenuOpen && (
                    <div
                      role="menu"
                      aria-label="Preset actions"
                      className="absolute right-0 top-full z-30 mt-1 w-44 rounded-md border border-border bg-popover py-1 shadow-lg"
                    >
                      {linkedTextStyle !== null && (
                        <button
                          role="menuitem"
                          type="button"
                          onClick={() => {
                            // Reset = re-apply the linked preset's
                            // typography onto this object, AND drop
                            // every per-run inline override so
                            // hand-formatted highlights (a bolded
                            // word, a coloured span) are wiped too.
                            // The user's mental model is "back to the
                            // preset, no exceptions".
                            clearAllInlineRunAttrs(obj.text, [
                              'fontFamily',
                              'fontWeight',
                              'fontSize',
                              'color',
                              'italic',
                              'underline',
                            ])
                            applyTextStyle(linkedTextStyle.id)
                            setPresetMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent"
                        >
                          <RotateCcw className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                          Reset to preset
                        </button>
                      )}
                      {linkedTextStyle !== null && (
                        <button
                          role="menuitem"
                          type="button"
                          onClick={() => {
                            // Push the current object's typography back
                            // onto the linked token — same shape that
                            // applyTextStyle would write in reverse.
                            const currentColor =
                              typeof obj.color === 'number'
                                ? `#${obj.color.toString(16).padStart(6, '0')}`
                                : undefined
                            updateToken('textStyles', linkedTextStyle.id, {
                              ...(typeof obj.fontFamily === 'string'
                                ? { family: obj.fontFamily }
                                : {}),
                              ...(typeof obj.fontWeight === 'number'
                                ? { weight: obj.fontWeight }
                                : {}),
                              ...(typeof obj.fontSize === 'number' ? { size: obj.fontSize } : {}),
                              ...(typeof obj.lineHeight === 'number'
                                ? { lineHeight: obj.lineHeight }
                                : {}),
                              ...(typeof obj.letterSpacing === 'number'
                                ? { letterSpacing: obj.letterSpacing }
                                : {}),
                              paragraphSpaceBefore: obj.paragraphSpaceBefore ?? 0,
                              paragraphSpaceAfter: obj.paragraphSpaceAfter ?? 0,
                              ...(currentColor !== undefined ? { color: currentColor } : {}),
                              textTransform: obj.textTransform ?? 'none',
                            })
                            setPresetMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent"
                        >
                          <Save className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                          Update preset
                        </button>
                      )}
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          setPresetMenuOpen(false)
                          setNewPresetOpen(true)
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent"
                      >
                        <Plus className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                        Create new text style
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <FontSizeField obj={obj} patch={patch} selAttrs={selAttrs} />

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

        {/* Bold + Italic + Underline as a single 3-segment toggle bar.
            Each toggle first attempts an inline format on the active
            text-edit selection (so a highlighted word is bolded /
            italicised on its own); only when there is no selection do
            we fall back to patching the box-wide field. */}
        <div className="flex items-center gap-2" data-text-edit-keep-focus>
          <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Style</span>
          <div
            role="group"
            aria-label="Text style"
            className="flex flex-1 items-stretch overflow-hidden rounded-md border border-input field-surface"
          >
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
              title="Bold"
              className={[
                'flex flex-1 items-center justify-center px-2 py-1 text-[11px] font-bold transition-colors',
                effectiveBold
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              ].join(' ')}
            >
              B
            </button>
            <button
              type="button"
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
              title="Italic"
              className={[
                'flex flex-1 items-center justify-center border-l border-input px-2 py-1 text-[11px] italic transition-colors',
                effectiveItalic
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              ].join(' ')}
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
              title="Underline"
              className={[
                'flex flex-1 items-center justify-center border-l border-input px-2 py-1 text-[11px] underline transition-colors',
                effectiveUnderline
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              ].join(' ')}
            >
              U
            </button>
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

        {/* Case transform — visual only, underlying text stays in
            original casing. Click the active option again to reset. */}
        <div className="flex items-center gap-2">
          <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">Case</span>
          <AlignButtonGroup
            value={obj.textTransform ?? 'none'}
            onChange={(v) =>
              patch({
                textTransform: v === 'none' ? undefined : v,
              } as unknown as SlideObjectPatch<TextObject>)
            }
            ariaLabel="Text case"
            options={[
              { value: 'none', label: 'As typed', Icon: Type },
              { value: 'uppercase', label: 'UPPERCASE', Icon: CaseUpper },
              { value: 'lowercase', label: 'lowercase', Icon: CaseLower },
              { value: 'capitalize', label: 'Capitalize', Icon: CaseSensitive },
            ]}
          />
        </div>

        {/* Line height + Letter spacing in a single 2-column row,
            Figma-style. Glyphs hint the field; values stay numeric. */}
        <div className="flex items-center gap-1">
          <CompactNumberField
            id={`inspector-lineheight-${obj.id}`}
            glyph={<Rows3 className="h-3 w-3" aria-hidden />}
            ariaLabel="Line height"
            value={obj.lineHeight ?? 1.2}
            step={0.1}
            onChange={(v) =>
              patch({ lineHeight: Math.max(0.1, v) } as SlideObjectPatch<TextObject>)
            }
          />
          <CompactNumberField
            id={`inspector-letterspacing-${obj.id}`}
            glyph={
              <span className="tracking-widest" aria-hidden>
                |A|
              </span>
            }
            ariaLabel="Letter spacing"
            value={obj.letterSpacing ?? 0}
            step={0.5}
            onChange={(v) => patch({ letterSpacing: v } as SlideObjectPatch<TextObject>)}
          />
        </div>

        {/* Paragraph spacing — vertical gap above and below each
            paragraph block. The renderer wraps every line break in a
            <div> with these margins so multi-paragraph text gets the
            requested room without the user fiddling with line-height.
            Gated behind paragraphSpacing — table cells don't model
            multi-paragraph blocks (cell text is single-flow). */}
        {features.paragraphSpacing && (
          <div className="flex items-center gap-1">
            <CompactNumberField
              id={`inspector-paragraphspacebefore-${obj.id}`}
              glyph={
                <span className="text-[9px] font-semibold leading-none" aria-hidden>
                  ¶↑
                </span>
              }
              ariaLabel="Paragraph space before"
              value={obj.paragraphSpaceBefore ?? 0}
              step={1}
              onChange={(v) =>
                patch({
                  paragraphSpaceBefore: Math.max(0, v),
                } as SlideObjectPatch<TextObject>)
              }
            />
            <CompactNumberField
              id={`inspector-paragraphspaceafter-${obj.id}`}
              glyph={
                <span className="text-[9px] font-semibold leading-none" aria-hidden>
                  ¶↓
                </span>
              }
              ariaLabel="Paragraph space after"
              value={obj.paragraphSpaceAfter ?? 0}
              step={1}
              onChange={(v) =>
                patch({
                  paragraphSpaceAfter: Math.max(0, v),
                } as SlideObjectPatch<TextObject>)
              }
            />
          </div>
        )}

        {/* Text color — Appearance-Fill–style inline swatch + hex with
            alpha popover. No "Color" label; context is the Text panel. */}
        <div data-text-edit-keep-focus>
          <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-input field-surface px-1.5">
            <TokenColorInput
              value={numberToHex(colourAsNumber(selAttrs?.color ?? obj.color))}
              onChange={(hex) => {
                // The picker fires onChange continuously while the user
                // drags. Do NOT call refocusActiveTextEdit here — pulling
                // focus back to the canvas mid-drag releases the
                // popover's pointer capture and the rest of the gesture
                // is dropped. The CE overlay's selection slot survives
                // the popover lifetime via [data-text-edit-keep-focus],
                // so applyInlineFormatIfSelected still hits the right
                // range without needing focus on the editor.
                const next = hexToNumber(hex)
                const sel = getActiveTextSelection()
                if (sel !== null && sel.objectId === obj.id) {
                  if (isEntireContentSelected(obj.id)) {
                    clearActiveSelectionAttrs(obj.id, ['color'])
                    patch({ color: next })
                    return
                  }
                  const applied = applyInlineFormatIfSelected(obj.id, { color: next })
                  if (!applied) patch({ color: next })
                  return
                }
                clearAllInlineRunAttrs(obj.text, ['color'])
                patch({ color: next })
              }}
              ariaLabel="Text color"
              showHex
              {...(features.colorAlpha
                ? {
                    alpha: obj.colorAlpha ?? 1,
                    onAlphaChange: (a: number) =>
                      patch({ colorAlpha: a } as SlideObjectPatch<TextObject>),
                  }
                : {})}
              inputClassName="!h-5 !w-7"
              hexClassName="!h-5 !border-0 !bg-transparent !px-1 !py-0 !text-[11px] uppercase"
            />
          </div>
        </div>

        {/* Lists — per-paragraph bullet / numbering with nesting level,
            glyph and numbering-format pickers. Operates on the paragraph(s)
            under the caret/selection while editing, else the whole box.
            Gated behind listStyle — table cells render single-flow text
            without list markers. */}
        {features.listStyle && (
          <div className="flex flex-col gap-1.5" data-text-edit-keep-focus>
            <div className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">List</span>
              <select
                value={paraAttrs.list ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  setListKind(obj, v === '' ? null : (v as 'bullet' | 'number'), patch)
                  refocusActiveTextEdit(obj.id)
                }}
                className="flex-1 rounded-md border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
                title="List style"
              >
                <option value="">No list</option>
                <option value="bullet">• Bullet</option>
                <option value="number">1. Numbered</option>
              </select>
              {paraAttrs.list !== undefined && (
                <div className="flex items-center">
                  <button
                    type="button"
                    className="rounded-l-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground hover:bg-accent"
                    title="Outdent (Shift+Tab)"
                    onClick={() => {
                      indentList(obj, -1, patch)
                      refocusActiveTextEdit(obj.id)
                    }}
                  >
                    ⇤
                  </button>
                  <button
                    type="button"
                    className="rounded-r-md border-y border-r border-input field-surface px-1.5 py-0.5 text-xs text-foreground hover:bg-accent"
                    title="Indent (Tab)"
                    onClick={() => {
                      indentList(obj, 1, patch)
                      refocusActiveTextEdit(obj.id)
                    }}
                  >
                    ⇥
                  </button>
                </div>
              )}
            </div>

            {paraAttrs.list === 'bullet' && (
              <div className="flex items-center gap-1 pl-[4.5rem]">
                {LIST_BULLET_GLYPHS.map((g) => {
                  const active =
                    g === null ? paraAttrs.bulletChar === undefined : paraAttrs.bulletChar === g
                  return (
                    <button
                      key={g ?? 'default'}
                      type="button"
                      title={g === null ? 'Default (per level)' : `Bullet ${g}`}
                      onClick={() => {
                        setBulletChar(obj, g, patch)
                        refocusActiveTextEdit(obj.id)
                      }}
                      className={`h-6 w-6 rounded-md border text-xs ${
                        active
                          ? 'border-ring bg-accent text-foreground'
                          : 'border-input field-surface text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {g ?? '–'}
                    </button>
                  )
                })}
              </div>
            )}

            {paraAttrs.list === 'number' && (
              <div className="flex items-center gap-2 pl-[4.5rem]">
                <select
                  value={paraAttrs.numberFormat ?? 'decimal'}
                  onChange={(e) => {
                    setNumberFormat(obj, e.target.value as ListNumberFormat, patch)
                    refocusActiveTextEdit(obj.id)
                  }}
                  className="flex-1 rounded-md border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
                  title="Numbering format"
                >
                  {LIST_NUMBER_FORMATS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  placeholder="start"
                  value={paraAttrs.startAt ?? ''}
                  onChange={(e) => {
                    const n = e.target.value === '' ? null : parseInt(e.target.value, 10)
                    setStartAt(obj, n !== null && Number.isFinite(n) ? n : null, patch)
                    refocusActiveTextEdit(obj.id)
                  }}
                  className="w-14 rounded-md border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
                  title="Start numbering at"
                />
              </div>
            )}
          </div>
        )}

        {/* Text stroke (outline on glyphs) — optional. Gated behind
            `stroke` — TableDefaults doesn't model glyph stroke. */}
        {features.stroke && (
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
                  <TokenColorInput
                    value={numberToHex(colourAsNumber(obj.stroke))}
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
                    onKeyDown={(e) =>
                      handleShiftArrowStep(
                        e,
                        obj.strokeWidth ?? 1,
                        0.5,
                        (v) =>
                          patch({ strokeWidth: Math.max(0, v) } as SlideObjectPatch<TextObject>),
                        { min: 0 },
                      )
                    }
                    className="w-16 rounded-md border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
                  />
                </>
              )}
            </div>
          </div>
        )}
      </Section>

      {newPresetOpen && (
        <NewTextStylePresetModal
          initialName={newPresetName}
          existingNames={textStylesList.map((s) => s.name)}
          onCancel={() => setNewPresetOpen(false)}
          onConfirm={(name) => {
            const currentColor =
              typeof obj.color === 'number'
                ? `#${obj.color.toString(16).padStart(6, '0')}`
                : '#000000'
            const newId = addToken('textStyles', {
              name,
              family: obj.fontFamily ?? 'Inter, system-ui, sans-serif',
              weight: typeof obj.fontWeight === 'number' ? obj.fontWeight : 400,
              size: typeof obj.fontSize === 'number' ? obj.fontSize : 16,
              lineHeight: typeof obj.lineHeight === 'number' ? obj.lineHeight : 1.5,
              letterSpacing: typeof obj.letterSpacing === 'number' ? obj.letterSpacing : 0,
              ...(typeof obj.paragraphSpaceBefore === 'number' && obj.paragraphSpaceBefore > 0
                ? { paragraphSpaceBefore: obj.paragraphSpaceBefore }
                : {}),
              ...(typeof obj.paragraphSpaceAfter === 'number' && obj.paragraphSpaceAfter > 0
                ? { paragraphSpaceAfter: obj.paragraphSpaceAfter }
                : {}),
              color: currentColor,
              ...(obj.textTransform !== undefined && obj.textTransform !== 'none'
                ? { textTransform: obj.textTransform }
                : {}),
            })
            patch({ textStyleId: newId } as unknown as SlideObjectPatch<TextObject>)
            setNewPresetOpen(false)
          }}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// NewTextStylePresetModal — captures the name for a fresh preset
// promoted from the current TextObject's typography.
// ---------------------------------------------------------------------------

interface NewTextStylePresetModalProps {
  initialName: string
  existingNames: ReadonlyArray<string>
  onConfirm: (name: string) => void
  onCancel: () => void
}

function NewTextStylePresetModal({
  initialName,
  existingNames,
  onConfirm,
  onCancel,
}: NewTextStylePresetModalProps) {
  const [name, setName] = useState(initialName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  // Esc closes; the parent provides cancellation logic.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const trimmed = name.trim()
  const lower = trimmed.toLowerCase()
  const collides = existingNames.some((n) => n.toLowerCase() === lower)
  const valid = trimmed !== '' && !collides

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create new text style"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        // Close when clicking the backdrop, not the panel itself.
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-[360px] rounded-lg border border-border bg-popover p-4 shadow-xl">
        <h3 className="text-sm font-semibold text-foreground">Create new text style</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Saves the current typography as a folder text style and links this object to it.
        </p>
        <label
          htmlFor="new-preset-name"
          className="mt-3 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70"
        >
          Name
        </label>
        <input
          id="new-preset-name"
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid) {
              e.preventDefault()
              onConfirm(trimmed)
            }
          }}
          maxLength={80}
          className="mt-1 w-full rounded-md border border-input field-surface px-2 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
        />
        {collides && (
          <p className="mt-1.5 text-[11px] text-destructive">
            A text style with this name already exists.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-input px-3 py-1.5 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => valid && onConfirm(trimmed)}
            disabled={!valid}
            className="btn-brand rounded-md px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// P8: Video properties section
// ---------------------------------------------------------------------------

/**
 * Filmstrip-style trim — drag the in / out handles to set trimStart /
 * trimEnd. The lit region between handles is the kept range; the
 * darkened cuffs on either side are trimmed away. No number inputs;
 * the position of the handles IS the source of truth.
 *
 * Drag math: each handle captures (pointerX, originalSec) on pointerdown
 * and writes the new value on pointermove using the track's clientWidth
 * so the math is independent of canvas zoom. Min separation of 0.1 s
 * keeps the kept range from collapsing to zero.
 */
function TrimFilmstrip({
  obj,
  patch,
}: {
  obj: VideoObject
  patch: (p: SlideObjectPatch<VideoObject>) => void
}) {
  const { info } = useVideoInfo(obj.assetId !== '' ? obj.assetId : null)
  const duration = info?.durationSec ?? 0
  const hasDuration = duration > 0

  const trimStart = obj.trimStart ?? 0
  const trimEnd = obj.trimEnd !== undefined && obj.trimEnd > 0 ? obj.trimEnd : duration
  const minGap = 0.1

  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    handle: 'start' | 'end'
    startX: number
    originalSec: number
    trackWidth: number
  } | null>(null)

  if (!hasDuration) return null

  const startPct = (trimStart / duration) * 100
  const endPct = (trimEnd / duration) * 100

  const scrubVideo = (sec: number): void => {
    const reg = (
      window as unknown as {
        __narrative_video_currents?: Record<
          string,
          { currentTime: number; seek?: (sec: number) => void }
        >
      }
    ).__narrative_video_currents
    reg?.[obj.id]?.seek?.(sec)
  }

  const writeStart = (sec: number): void => {
    const clamped = Math.max(0, Math.min(trimEnd - minGap, sec))
    patch({
      trimStart: clamped <= 0 ? undefined : clamped,
    } as unknown as SlideObjectPatch<VideoObject>)
    scrubVideo(clamped)
  }
  const writeEnd = (sec: number): void => {
    const clamped = Math.max(trimStart + minGap, Math.min(duration, sec))
    patch({
      trimEnd: clamped >= duration ? undefined : clamped,
    } as unknown as SlideObjectPatch<VideoObject>)
    scrubVideo(clamped)
  }

  const onPointerDown = (handle: 'start' | 'end') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const track = trackRef.current
    if (track === null) return
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    dragRef.current = {
      handle,
      startX: e.clientX,
      originalSec: handle === 'start' ? trimStart : trimEnd,
      trackWidth: track.clientWidth,
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null) return
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const dxPx = e.clientX - drag.startX
    const dxSec = (dxPx / Math.max(1, drag.trackWidth)) * duration
    const next = drag.originalSec + dxSec
    if (drag.handle === 'start') writeStart(next)
    else writeEnd(next)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
  }

  return (
    <div className="flex flex-col gap-1">
      <SubLabel>Trim</SubLabel>
      <div
        ref={trackRef}
        className="relative h-8 w-full overflow-hidden rounded-md border border-input field-surface"
      >
        {/* Filmstrip texture — repeating hash gives the strip a subtle
            "frames" look without paying for actual frame thumbnails. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, hsl(0 0% 100% / 0.04) 0 6px, hsl(0 0% 100% / 0.08) 6px 8px)',
          }}
        />
        {/* Trimmed cuffs — left and right of the kept region. */}
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-background/70"
          style={{ width: `${startPct}%` }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-0 bg-background/70"
          style={{ width: `${100 - endPct}%` }}
        />
        {/* Kept region outline — primary tint so the in/out range pops. */}
        <div
          aria-hidden="true"
          className="absolute inset-y-0 border-y-2 border-primary/80"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
        />
        {/* In handle. */}
        <div
          role="slider"
          aria-label="Trim start"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={trimStart}
          onPointerDown={onPointerDown('start')}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="absolute inset-y-0 z-10 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-xs bg-primary"
          style={{ left: `${startPct}%`, touchAction: 'none' }}
        >
          <div className="h-3 w-0.5 rounded bg-white/80" />
        </div>
        {/* Out handle. */}
        <div
          role="slider"
          aria-label="Trim end"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={trimEnd}
          onPointerDown={onPointerDown('end')}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="absolute inset-y-0 z-10 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-xs bg-primary"
          style={{ left: `${endPct}%`, touchAction: 'none' }}
        >
          <div className="h-3 w-0.5 rounded bg-white/80" />
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground/70">
        <span>{formatTimecode(trimStart)}</span>
        <span>{formatTimecode(trimEnd - trimStart)} kept</span>
        <span>{formatTimecode(trimEnd)}</span>
      </div>
    </div>
  )
}

/**
 * P8: poster-frame picker — Keynote-style. Single scrub slider whose
 * position IS the poster time; a timecode below shows the current value.
 * No number input, no buttons — drop the slider where you want and
 * release. Hidden when video duration isn't known yet.
 */
function formatTimecode(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  // Show 1 decimal so dragging the slider gives instant precise feedback
  // (a 90-frame video at 30 fps is still discriminable as 0.0 → 3.0).
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

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

  if (!hasDuration) return null

  const setPoster = (v: number): void => {
    const clamped = Math.max(0, Math.min(duration, v))
    patch({
      posterTime: clamped <= 0 ? undefined : clamped,
    } as unknown as SlideObjectPatch<VideoObject>)
    // Scrub the live <video> overlay so the user sees the exact frame
    // they're picking as the poster.
    const reg = (
      window as unknown as {
        __narrative_video_currents?: Record<
          string,
          { currentTime: number; seek?: (sec: number) => void }
        >
      }
    ).__narrative_video_currents
    reg?.[obj.id]?.seek?.(clamped)
  }

  return (
    <div className="flex flex-col gap-1">
      <SubLabel>Poster frame</SubLabel>
      <input
        id={`inspector-video-poster-${obj.id}`}
        type="range"
        aria-label="Poster frame"
        min={0}
        max={duration}
        step={Math.max(0.05, duration / 200)}
        value={value}
        onChange={(e) => setPoster(Number.parseFloat(e.target.value))}
        className="w-full accent-primary"
      />
      <div className="text-right text-[10px] tabular-nums text-muted-foreground/70">
        {formatTimecode(value)} / {formatTimecode(duration)}
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
      <SegmentedToggleRow
        ariaLabel="Playback"
        segments={[
          {
            Icon: CirclePlay,
            label: 'Autoplay',
            pressed: obj.autoplay === true,
            onClick: () =>
              patch({
                autoplay: obj.autoplay === true ? undefined : true,
                // Autoplay and playOnClick are mutually exclusive — pressing
                // one clears the other so the trigger reads unambiguously.
                ...(obj.autoplay !== true && obj.playOnClick === true
                  ? { playOnClick: undefined }
                  : {}),
              } as unknown as SlideObjectPatch<VideoObject>),
          },
          {
            Icon: MousePointerClick,
            label: 'Click to play',
            pressed: obj.playOnClick === true,
            onClick: () =>
              patch({
                playOnClick: obj.playOnClick === true ? undefined : true,
                ...(obj.playOnClick !== true && obj.autoplay === true
                  ? { autoplay: undefined }
                  : {}),
              } as unknown as SlideObjectPatch<VideoObject>),
          },
          {
            Icon: Repeat,
            label: 'Loop',
            pressed: obj.loop === true,
            onClick: () =>
              patch({
                loop: obj.loop === true ? undefined : true,
              } as unknown as SlideObjectPatch<VideoObject>),
          },
          {
            Icon: muted ? VolumeX : Volume2,
            label: muted ? 'Muted' : 'Sound on',
            pressed: muted,
            onClick: () => patch({ muted: !muted } as SlideObjectPatch<VideoObject>),
          },
          {
            Icon: SlidersHorizontal,
            label: 'Show native controls',
            pressed: obj.showControls === true,
            onClick: () =>
              patch({
                showControls: obj.showControls === true ? undefined : true,
              } as unknown as SlideObjectPatch<VideoObject>),
          },
        ]}
      />

      <SubLabel>Volume</SubLabel>
      <TransparencySlider
        id={`inspector-video-vol-${obj.id}`}
        value={volume}
        ariaLabel="Volume"
        disabled={muted}
        onChange={(v) => patch({ volume: v } as SlideObjectPatch<VideoObject>)}
      />

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
          className="flex-1 rounded-md border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
        >
          <option value="contain">Contain</option>
          <option value="cover">Cover</option>
        </select>
      </div>

      {/* P15: aspect-lock moved to the Size section as a chain icon
          shared by every object type. The previous video-only "Lock
          to native ratio" checkbox lived here; it's now redundant. */}

      <PosterFrameRow obj={obj} patch={patch} />
      <TrimFilmstrip obj={obj} patch={patch} />
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
  'rounded-md border border-input px-2 py-0.5 text-xs text-foreground/90',
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
  selected,
  onSelect,
}: {
  step: AnimationStep
  onRemove: (stepId: string) => void
  mutationCtx: AnimationsMutationContext
  selected: boolean
  onSelect: () => void
}) {
  function patch(p: Partial<AnimationStep>): void {
    updateAnimation(mutationCtx, step.id, p)
  }
  function patchParams(next: Record<string, unknown>): void {
    updateAnimation(mutationCtx, step.id, { params: { ...(step.params ?? {}), ...next } })
  }
  const hasDirection = step.preset === 'slideIn' || step.preset === 'slideOut'
  const direction = (step.params?.['direction'] as string | undefined) ?? 'up'
  const distance = (step.params?.['distance'] as number | undefined) ?? 100
  const isMoveTo = step.preset === 'moveTo'
  const isRotateTo = step.preset === 'rotateTo'
  const targetX = (step.params?.['targetX'] as number | undefined) ?? 0
  const targetY = (step.params?.['targetY'] as number | undefined) ?? 0
  const angleDeg = (step.params?.['angleDeg'] as number | undefined) ?? 360
  return (
    <li
      onClick={onSelect}
      className={[
        'flex flex-col gap-1 rounded-md field-surface px-2 py-1.5 cursor-pointer',
        selected ? 'ring-2 ring-primary/70 bg-primary/10' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-foreground">{animationLabel(step)}</span>
        <button
          type="button"
          onClick={() => onRemove(step.id)}
          aria-label={`Remove ${animationLabel(step)} animation`}
          className={[
            'ml-2 rounded-md p-0.5 text-muted-foreground/50 transition-colors',
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
            className="rounded-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
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
            className="rounded-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
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
            className="rounded-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (!Number.isNaN(v) && v >= 0) patch({ duration: v })
            }}
            onKeyDown={(e) =>
              handleShiftArrowStep(
                e,
                step.duration ?? 0,
                0.05,
                (v) => patch({ duration: Math.max(0, v) }),
                { min: 0 },
              )
            }
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
            className="rounded-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (!Number.isNaN(v) && v >= 0) patch({ delay: v })
            }}
            onKeyDown={(e) =>
              handleShiftArrowStep(
                e,
                step.delay ?? 0,
                0.05,
                (v) => patch({ delay: Math.max(0, v) }),
                { min: 0 },
              )
            }
          />
        </label>
      </div>
      {isMoveTo && (
        <div className="grid grid-cols-2 gap-1">
          <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground/80">
            Target X
            <input
              type="number"
              step={1}
              value={targetX}
              aria-label="Target X"
              className="rounded-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (Number.isFinite(v)) patchParams({ targetX: v })
              }}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground/80">
            Target Y
            <input
              type="number"
              step={1}
              value={targetY}
              aria-label="Target Y"
              className="rounded-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (Number.isFinite(v)) patchParams({ targetY: v })
              }}
            />
          </label>
        </div>
      )}
      {isRotateTo && (
        <div className="grid grid-cols-2 gap-1">
          <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground/80">
            Angle (°)
            <input
              type="number"
              step={1}
              value={angleDeg}
              aria-label="Target angle"
              className="rounded-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (Number.isFinite(v)) patchParams({ angleDeg: v })
              }}
            />
          </label>
        </div>
      )}
      {hasDirection && (
        <div className="grid grid-cols-2 gap-1">
          <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground/80">
            Direction
            <select
              value={direction}
              aria-label="Direction"
              className="rounded-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
              onChange={(e) => patchParams({ direction: e.target.value })}
            >
              <option value="up">up</option>
              <option value="down">down</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground/80">
            Distance (px)
            <input
              type="number"
              min={0}
              step={10}
              value={distance}
              aria-label="Distance in pixels"
              className="rounded-md border border-input field-surface px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (!Number.isNaN(v) && v >= 0) patchParams({ distance: v })
              }}
              onKeyDown={(e) =>
                handleShiftArrowStep(
                  e,
                  distance,
                  10,
                  (v) => patchParams({ distance: Math.max(0, v) }),
                  {
                    min: 0,
                  },
                )
              }
            />
          </label>
        </div>
      )}
    </li>
  )
}

export function AnimationsSection({
  objectId,
  animations,
  mutationCtx,
  totalAnimations,
}: AnimationsSectionProps) {
  // Animace patřící tomuto objektu
  const objectAnimations = animations.filter((a) => a.objectId === objectId)
  const { selectedAnimationId, setSelectedAnimationId, selectOne } = useSelection()

  function handleAddAnimation(preset: AnimationStep['preset'], params?: Record<string, unknown>) {
    // Seed sensible defaults for motion presets so a freshly-added
    // step actually moves the object instead of being a no-op.
    let seededParams = params
    if (preset === 'moveTo' && seededParams === undefined) {
      // targetX / targetY = destination CENTRE in slide-coords (matches
      // Pixi pivot convention so the on-canvas ghost lines up with
      // where playback finishes). Default seeds the slide centre.
      seededParams = { targetX: 960, targetY: 540 }
    } else if (preset === 'rotateTo' && seededParams === undefined) {
      seededParams = { angleDeg: 180 }
    }
    addAnimation(mutationCtx, {
      objectId,
      preset,
      trigger: defaultTrigger(totalAnimations),
      duration: 0.6,
      delay: 0,
      easing: 'power2.out',
      ...(seededParams !== undefined ? { params: seededParams } : {}),
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
          className="flex-1 rounded-md border border-input field-surface px-2 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none"
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
            <option value="slideIn">slideIn</option>
          </optgroup>
          <optgroup label="Exit">
            <option value="fadeOut">fadeOut</option>
            <option value="scaleOut">scaleOut</option>
            <option value="slideOut">slideOut</option>
          </optgroup>
          <optgroup label="Motion">
            <option value="moveTo">moveTo (A→B)</option>
            <option value="rotateTo">rotateTo</option>
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
              selected={selectedAnimationId === step.id}
              onSelect={() => {
                setSelectedAnimationId(step.id)
                selectOne(step.objectId)
              }}
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

function LinkControls({ obj, patch }: LinkSectionProps) {
  const slides = useSlides()
  // Only id+name go into the slide dropdown; memoize so unrelated slide
  // changes (object edits, transition tweaks) don't churn the <option> list.
  // Keyed on a tiny fingerprint string instead of the slides reference,
  // because useSlides() returns a fresh array on every observeDeep event.
  const slideOptionsFingerprint = slides.map((s) => `${s.id}|${s.name ?? ''}`).join('\n')
  const slideOptions = useMemo(
    () =>
      slides.map((s, i) => ({
        id: s.id,
        label: s.name && s.name.length > 0 ? s.name : `Slide ${i + 1}`,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slideOptionsFingerprint],
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const typeSelectRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    function focusHandler() {
      const root = containerRef.current
      if (root === null) return
      root.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
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
    <div ref={containerRef} className="flex flex-col gap-1.5">
      <SubLabel>Link</SubLabel>
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
          className="h-7 w-full rounded-md border border-border bg-input px-2 py-0.5 text-xs text-foreground focus:border-primary focus:outline-none"
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
            className="h-7 w-full rounded-md border border-border bg-input px-2 py-0.5 text-xs text-foreground focus:border-primary focus:outline-none"
          >
            {slideOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
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
              className="h-7 w-full rounded-md border border-border bg-input px-2 py-0.5 text-xs text-foreground focus:border-primary focus:outline-none"
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
              className="h-7 w-full rounded-md border border-border bg-input px-2 py-0.5 text-xs text-foreground focus:border-primary focus:outline-none"
            >
              <option value="_blank">New tab</option>
              <option value="_self">Same tab</option>
            </select>
          </div>
        </>
      )}
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
          className="rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground hover:bg-input/70"
        >
          Crop image…
        </button>
        <button
          type="button"
          disabled={!cropped}
          onClick={() =>
            patch({ imageRect: undefined } as unknown as SlideObjectPatch<ImageObject>)
          }
          className="rounded-md border border-border bg-input px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset crop
        </button>
        {masked && (
          <button
            type="button"
            onClick={() => patch({ mask: undefined } as unknown as SlideObjectPatch<ImageObject>)}
            className="rounded-md border border-border bg-input px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
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
