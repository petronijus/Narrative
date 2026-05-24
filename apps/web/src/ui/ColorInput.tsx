/**
 * ui/ColorInput.tsx
 *
 * P11 (round 2): popover-based custom color picker built on `react-colorful`.
 *
 * Why custom over native `<input type="color">`:
 *   The native picker delegates to the OS, so we cannot inject the recent-
 *   colors row into the picker UI itself — the user sees recents only as
 *   a sibling row outside the picker. The popover variant brings recents,
 *   hex input, eyedropper, and the saturation/hue picker into one chrome
 *   that opens in-page when the user clicks the swatch.
 *
 * Trigger: a small swatch button rendering the current color.
 * Popover content: HexColorPicker + hex text field + eyedropper button +
 *   recent-colors swatches (12).
 *
 * Commit semantics:
 *   - onChange fires on every drag / hex character (live preview).
 *   - onCommit fires on close, eyedropper pick, hex blur, swatch click.
 *     If omitted, onChange is used for commits too.
 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { HexColorPicker } from 'react-colorful'
import { Ban, Pipette, Plus, X } from 'lucide-react'
import { useRecentColors } from '../state/useRecentColors.js'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.js'
import type { TokenRef, ColorTokenSnapshot } from '@narrative/slide-model'

// ---------------------------------------------------------------------------
// EyeDropper API types — not yet in the official TypeScript lib.
// ---------------------------------------------------------------------------

interface EyeDropperResult {
  sRGBHex: string
}

interface EyeDropperAPI {
  open: () => Promise<EyeDropperResult>
}

declare global {
  interface Window {
    EyeDropper?: new () => EyeDropperAPI
  }
}

const EYEDROPPER_SUPPORTED = typeof window !== 'undefined' && 'EyeDropper' in window

// ---------------------------------------------------------------------------
// ColorInput
// ---------------------------------------------------------------------------

export interface ColorInputProps {
  /** Current color as #rrggbb. */
  value: string
  /** Live updates on drag / hex typing. */
  onChange: (hex: string) => void
  /**
   * Definitive commits — popover close, eyedropper pick, swatch click,
   * hex blur. Defaults to `onChange` if omitted.
   */
  onCommit?: (hex: string) => void
  /** Render the hex text input alongside the swatch button. Default: true. */
  showHex?: boolean
  /** aria-label for the swatch trigger. */
  ariaLabel?: string
  /** Extra className for the swatch trigger. */
  inputClassName?: string
  /** Extra className for the hex text input. */
  hexClassName?: string
  /**
   * Optional alpha 0..1. When provided alongside `onAlphaChange`, the
   * popover renders an opacity slider and the trigger swatch shows a
   * checkered backdrop so partial transparency is visible.
   */
  alpha?: number
  /** Live alpha updates while dragging the slider. */
  onAlphaChange?: (alpha: number) => void
  /** Definitive alpha commit on slider release. Defaults to `onAlphaChange`. */
  onAlphaCommit?: (alpha: number) => void
  /**
   * M16 P2: folder palette to render inside the popover above Recents.
   * When provided alongside `onTokenSelect`, clicking a swatch links the
   * fill to that token. `activeTokenRef` highlights the current link.
   */
  tokenColors?: ColorTokenSnapshot[] | undefined
  activeTokenRef?: TokenRef | null | undefined
  onTokenSelect?: ((ref: TokenRef) => void) | undefined
  onOpenFolderSettings?: (() => void) | undefined
  /**
   * When the parent fill is linked to a token, render this label (the
   * token name) in place of the hex input + an ✕ Unlink button that
   * calls `onUnlink`. Swatch trigger keeps opening the popover so the
   * user can still adjust alpha while the link is active.
   */
  linkedLabel?: string | undefined
  onUnlink?: (() => void) | undefined
  /**
   * When provided, the popover renders a "No color" button at the top
   * that calls this handler and closes itself. The parent decides what
   * "no colour" means semantically — for a TableDefaults.fill it means
   * clearing the field (transparent cells); for a FilledShape's fill it
   * means dropping the alpha to 0. The picker itself doesn't push the
   * current hex into recents when the clear path is taken.
   */
  onClear?: (() => void) | undefined
  /**
   * When set, the outer hex input is replaced with this static label
   * (similar to `linkedLabel` for tokens), and the trigger swatch
   * paints over a checkered backdrop so the empty state reads as
   * transparent at a glance. Use this when the underlying value is
   * "no colour / cleared" and the displayed hex would be a misleading
   * fallback (e.g. white). Inside the popover the hex input stays
   * editable so the user can type a real colour to un-clear.
   */
  emptyLabel?: string | undefined
}

const CHECKER_BG =
  'linear-gradient(45deg, #bbb 25%, transparent 25%), ' +
  'linear-gradient(-45deg, #bbb 25%, transparent 25%), ' +
  'linear-gradient(45deg, transparent 75%, #bbb 75%), ' +
  'linear-gradient(-45deg, transparent 75%, #bbb 75%)'
const CHECKER_SIZE = '8px 8px'
const CHECKER_POS = '0 0, 0 4px, 4px -4px, -4px 0'

function clampAlpha(a: number): number {
  if (Number.isNaN(a)) return 1
  return Math.min(1, Math.max(0, a))
}

function isValidHex(s: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(s)
}

function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim()
  const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  return isValidHex(hex) ? hex.toLowerCase() : null
}

export function ColorInput({
  value,
  onChange,
  onCommit,
  showHex = true,
  ariaLabel = 'Color',
  inputClassName = '',
  hexClassName = '',
  alpha,
  onAlphaChange,
  onAlphaCommit,
  tokenColors,
  activeTokenRef,
  onTokenSelect,
  linkedLabel,
  onUnlink,
  onOpenFolderSettings,
  onClear,
  emptyLabel,
}: ColorInputProps) {
  const alphaEnabled = alpha !== undefined && onAlphaChange !== undefined
  const isEmpty = emptyLabel !== undefined
  const alphaVal = alphaEnabled ? clampAlpha(alpha as number) : 1
  const commitAlpha = onAlphaCommit ?? onAlphaChange
  const { colors: recentColors, push } = useRecentColors()
  const [open, setOpen] = useState(false)

  // When a folder-token swatch is clicked we close the popover without
  // pushing the previous hex into the recent-colors history (the user
  // didn't actually pick a hex).
  const skipCloseCommitRef = useRef(false)

  const commit = onCommit ?? onChange

  // ColorInput is intentionally context-free; the auto-pull (folder
  // palette + Settings link + hex fallback for non-token fields) lives
  // in <TokenColorInput> so tests / non-editor callers don't need a
  // Router or FolderDocProvider parent.
  const effectiveTokenColors = tokenColors
  const effectiveOnOpenFolderSettings = onOpenFolderSettings
  const effectiveOnTokenSelect = onTokenSelect

  // Local draft for the hex input. The parent's `value` is the source
  // of truth, but committing only valid `#RRGGBB` strings means
  // intermediate keystrokes ("F", "F7", "F7F") are not valid hex and
  // would otherwise be discarded on every change, making the input
  // feel uneditable. Track the user's typing locally and commit when
  // the value normalises (or on blur).
  const [hexDraft, setHexDraft] = useState<string>(() => value.toUpperCase())
  const isFocusedRef = useRef(false)
  useEffect(() => {
    // External value changes (popover picker, swatch click, peer
    // edit) refresh the draft only when the user isn't actively
    // typing, so an in-flight keystroke isn't clobbered.
    if (!isFocusedRef.current) {
      setHexDraft(value.toUpperCase())
    }
  }, [value])

  const handlePickerChange = (hex: string): void => {
    onChange(hex)
  }

  const handleSwatchClick = (hex: string): void => {
    onChange(hex)
    commit(hex)
    push(hex)
  }

  const handleHexChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value
    setHexDraft(raw)
    // Live-commit only when the typed string already forms a valid
    // hex — gives instant preview on the canvas without clobbering
    // partial input.
    const hex = normalizeHex(raw)
    if (hex !== null) onChange(hex)
  }

  const handleHexBlur = (e: ChangeEvent<HTMLInputElement>): void => {
    isFocusedRef.current = false
    const hex = normalizeHex(e.target.value)
    if (hex !== null) {
      setHexDraft(hex.toUpperCase())
      commit(hex)
      push(hex)
    } else {
      // Invalid input on blur — revert to the last committed value.
      setHexDraft(value.toUpperCase())
    }
  }

  const handleEyedropper = (): void => {
    if (!EYEDROPPER_SUPPORTED || window.EyeDropper === undefined) return
    const picker = new window.EyeDropper()
    picker
      .open()
      .then((result) => {
        const hex = result.sRGBHex.toLowerCase()
        onChange(hex)
        commit(hex)
        push(hex)
      })
      .catch(() => {
        // User cancelled — no-op.
      })
  }

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      if (skipCloseCommitRef.current) {
        // Token was just picked — don't push the previous hex into recents.
        skipCloseCommitRef.current = false
        return
      }
      // Closing → commit current value + add to recent.
      commit(value)
      push(value)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            className={[
              'h-7 w-10 flex-shrink-0 cursor-pointer rounded-md border border-input p-0.5',
              'focus:border-ring focus:outline-none',
              inputClassName,
            ].join(' ')}
          >
            {alphaEnabled || isEmpty ? (
              <span
                aria-hidden="true"
                className="block h-full w-full rounded-xs"
                style={{
                  backgroundImage: CHECKER_BG,
                  backgroundSize: CHECKER_SIZE,
                  backgroundPosition: CHECKER_POS,
                }}
              >
                <span
                  aria-hidden="true"
                  className="block h-full w-full rounded-xs"
                  style={{
                    background: isEmpty ? 'transparent' : value,
                    opacity: isEmpty ? 0 : alphaVal,
                  }}
                />
              </span>
            ) : (
              <span
                aria-hidden="true"
                className="block h-full w-full rounded-xs"
                style={{ background: value }}
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-56 p-3"
          side="bottom"
          align="start"
          sideOffset={4}
          // P15: tag the portalled popover so the TextEditOverlay's
          // blur handler treats clicks/focus moves into the picker as
          // "keep editing". Without this, clicking the saturation panel
          // ends inline-edit mode (the overlay unmounts, the active
          // text-selection slot is cleared) and the next picker drag
          // can't apply per-run colour because the selection is gone.
          data-text-edit-keep-focus
          // Keep keyboard scope inside the popover; outside-click closes
          // (Radix default).
        >
          <div className="flex flex-col gap-3">
            {/* "No color" — only when the parent wired the clear path.
                Drops fill entirely (table cells / shape alpha=0 / etc.).
                Pinned to the top so the user sees it before fiddling
                with hex; closes the popover and skips the
                recent-colour push so a transparent state doesn't show
                up as a hex swatch in history. */}
            {onClear !== undefined && (
              <button
                type="button"
                aria-label="No color (transparent)"
                onClick={() => {
                  skipCloseCommitRef.current = true
                  onClear()
                  setOpen(false)
                }}
                className={[
                  'flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-input',
                  'text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  'focus:border-ring focus:outline-none',
                ].join(' ')}
              >
                <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                No color
              </button>
            )}

            {/* Saturation/hue picker. The library renders its own canvas. */}
            <HexColorPicker
              color={value}
              onChange={handlePickerChange}
              style={{ width: '100%', height: 140 }}
            />

            {/* Hex + eyedropper row. */}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                aria-label={`${ariaLabel} hex`}
                value={hexDraft}
                onChange={handleHexChange}
                onFocus={() => {
                  isFocusedRef.current = true
                }}
                onBlur={handleHexBlur}
                className={[
                  'flex-1 rounded-md border border-input field-surface px-2 py-1',
                  'font-mono text-xs text-foreground',
                  'focus:border-ring focus:outline-none',
                  hexClassName,
                ].join(' ')}
              />
              <button
                type="button"
                onClick={EYEDROPPER_SUPPORTED ? handleEyedropper : undefined}
                disabled={!EYEDROPPER_SUPPORTED}
                aria-label="Pick color from screen"
                title={
                  EYEDROPPER_SUPPORTED
                    ? 'Pick color from screen'
                    : 'Eyedropper not supported in this browser'
                }
                className={[
                  'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-input',
                  EYEDROPPER_SUPPORTED
                    ? 'cursor-pointer text-muted-foreground hover:border-border-strong hover:text-foreground'
                    : 'cursor-not-allowed text-muted-foreground/40',
                ].join(' ')}
              >
                <Pipette className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Alpha slider — only when caller wires alpha through. */}
            {alphaEnabled && (
              <div className="flex items-center gap-1.5">
                <span className="w-10 flex-shrink-0 text-[10px] uppercase text-muted-foreground">
                  Alpha
                </span>
                <input
                  type="range"
                  aria-label={`${ariaLabel} opacity`}
                  min={0}
                  max={1}
                  step={0.01}
                  value={alphaVal}
                  onChange={(e) => onAlphaChange?.(clampAlpha(Number.parseFloat(e.target.value)))}
                  onPointerUp={(e) => {
                    const v = clampAlpha(Number.parseFloat((e.target as HTMLInputElement).value))
                    commitAlpha?.(v)
                  }}
                  className="flex-1 accent-primary"
                />
                <span className="w-9 text-right text-[10px] tabular-nums text-muted-foreground">
                  {Math.round(alphaVal * 100)}%
                </span>
              </div>
            )}

            {/* M16 P2: folder palette above Recents inside the popover.
                Clicking a swatch links the fill to that token. */}
            {effectiveTokenColors !== undefined &&
              effectiveTokenColors.length > 0 &&
              effectiveOnTokenSelect !== undefined && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      Folder palette
                    </p>
                    {effectiveOnOpenFolderSettings !== undefined && (
                      <button
                        type="button"
                        title="Edit folder colors"
                        aria-label="Edit folder colors"
                        onClick={() => {
                          skipCloseCommitRef.current = true
                          setOpen(false)
                          effectiveOnOpenFolderSettings()
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
                      >
                        <Plus className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Folder palette">
                    {effectiveTokenColors.map((c) => {
                      const activeId =
                        activeTokenRef !== null && activeTokenRef !== undefined
                          ? (activeTokenRef.$token.split('.')[1] ?? null)
                          : null
                      const isActive = activeId === c.id
                      return (
                        <button
                          key={c.id}
                          type="button"
                          title={`${c.name}\n${c.value.toUpperCase()}`}
                          aria-label={`Apply token: ${c.name}`}
                          aria-pressed={isActive}
                          onClick={() => {
                            skipCloseCommitRef.current = true
                            effectiveOnTokenSelect({ $token: `colors.${c.id}` })
                            setOpen(false)
                          }}
                          className={[
                            'h-5 w-5 rounded-xs border transition',
                            isActive
                              ? 'border-foreground shadow-[0_0_0_1.5px_hsl(var(--background))_inset]'
                              : 'border-border hover:border-border-strong',
                          ].join(' ')}
                          style={{ background: c.value }}
                        />
                      )
                    })}
                  </div>
                </div>
              )}

            {/* Recent colors swatch row inside the popover. */}
            {recentColors.length > 0 && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  Recent
                </p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Recent colors">
                  {recentColors.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      title={hex.toUpperCase()}
                      aria-label={`Recent color ${hex.toUpperCase()}`}
                      onClick={() => handleSwatchClick(hex)}
                      className={[
                        'h-5 w-5 rounded-xs border transition',
                        hex.toLowerCase() === value.toLowerCase()
                          ? 'border-foreground shadow-[0_0_0_1.5px_hsl(var(--background))_inset]'
                          : 'border-border hover:border-border-strong',
                      ].join(' ')}
                      style={{ background: hex }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {linkedLabel !== undefined ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {linkedLabel}
          </span>
          {onUnlink !== undefined && (
            <button
              type="button"
              title="Unlink token — write current value as literal"
              aria-label="Unlink token"
              onClick={onUnlink}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>
      ) : isEmpty ? (
        // Empty / cleared fill — show the parent-supplied label
        // instead of a misleading fallback hex. No unlink affordance:
        // picking any colour in the popover writes through and clears
        // the empty state naturally.
        <span className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-wide text-muted-foreground">
          {emptyLabel}
        </span>
      ) : (
        showHex && (
          <input
            type="text"
            aria-label={`${ariaLabel} hex`}
            value={hexDraft}
            onChange={handleHexChange}
            onFocus={() => {
              isFocusedRef.current = true
            }}
            onBlur={handleHexBlur}
            className={[
              'flex-1 rounded-md border border-input field-surface px-2 py-0.5',
              'font-mono text-xs text-foreground',
              'focus:border-ring focus:outline-none',
              hexClassName,
            ].join(' ')}
          />
        )
      )}
    </div>
  )
}
