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

import { useState, type ChangeEvent } from 'react'
import { HexColorPicker } from 'react-colorful'
import { Pipette } from 'lucide-react'
import { useRecentColors } from '../state/useRecentColors.js'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.js'

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
}: ColorInputProps) {
  const alphaEnabled = alpha !== undefined && onAlphaChange !== undefined
  const alphaVal = alphaEnabled ? clampAlpha(alpha as number) : 1
  const commitAlpha = onAlphaCommit ?? onAlphaChange
  const { colors: recentColors, push } = useRecentColors()
  const [open, setOpen] = useState(false)

  const commit = onCommit ?? onChange

  const handlePickerChange = (hex: string): void => {
    onChange(hex)
  }

  const handleSwatchClick = (hex: string): void => {
    onChange(hex)
    commit(hex)
    push(hex)
  }

  const handleHexChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const hex = normalizeHex(e.target.value)
    if (hex !== null) onChange(hex)
  }

  const handleHexBlur = (e: ChangeEvent<HTMLInputElement>): void => {
    const hex = normalizeHex(e.target.value)
    if (hex !== null) {
      commit(hex)
      push(hex)
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
              'h-7 w-10 flex-shrink-0 cursor-pointer rounded border border-input p-0.5',
              'focus:border-ring focus:outline-none',
              inputClassName,
            ].join(' ')}
          >
            {alphaEnabled ? (
              <span
                aria-hidden="true"
                className="block h-full w-full rounded-sm"
                style={{
                  backgroundImage: CHECKER_BG,
                  backgroundSize: CHECKER_SIZE,
                  backgroundPosition: CHECKER_POS,
                }}
              >
                <span
                  aria-hidden="true"
                  className="block h-full w-full rounded-sm"
                  style={{ background: value, opacity: alphaVal }}
                />
              </span>
            ) : (
              <span
                aria-hidden="true"
                className="block h-full w-full rounded-sm"
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
          // Keep keyboard scope inside the popover; outside-click closes
          // (Radix default).
        >
          <div className="flex flex-col gap-3">
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
                value={value.toUpperCase()}
                onChange={handleHexChange}
                onBlur={handleHexBlur}
                className={[
                  'flex-1 rounded border border-input field-surface px-2 py-1',
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
                  'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded border border-input',
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

            {/* Recent colors swatch row inside the popover. */}
            {recentColors.length > 0 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Recent colors">
                {recentColors.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    title={hex.toUpperCase()}
                    aria-label={`Recent color ${hex.toUpperCase()}`}
                    onClick={() => handleSwatchClick(hex)}
                    className={[
                      'h-5 w-5 rounded-sm border transition',
                      hex.toLowerCase() === value.toLowerCase()
                        ? 'border-foreground shadow-[0_0_0_1.5px_hsl(var(--background))_inset]'
                        : 'border-border hover:border-border-strong',
                    ].join(' ')}
                    style={{ background: hex }}
                  />
                ))}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {showHex && (
        <input
          type="text"
          aria-label={`${ariaLabel} hex`}
          value={value.toUpperCase()}
          onChange={handleHexChange}
          onBlur={handleHexBlur}
          className={[
            'flex-1 rounded border border-input field-surface px-2 py-0.5',
            'font-mono text-xs text-foreground',
            'focus:border-ring focus:outline-none',
            hexClassName,
          ].join(' ')}
        />
      )}
    </div>
  )
}
