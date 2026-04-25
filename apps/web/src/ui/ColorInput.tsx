/**
 * ui/ColorInput.tsx
 *
 * P11: Drop-in replacement / wrapper for every <input type="color"> in the
 * Inspector and StageBgPicker. Provides two extras:
 *
 *  1. Recent-colors swatches — a row of up to 12 recent colors above the
 *     native picker, backed by useRecentColors (localStorage ring buffer).
 *
 *  2. Eyedropper button — uses the native EyeDropper API (Chromium).
 *     Rendered disabled with an explanatory title where unsupported
 *     (Firefox, Safari). On pick, calls onChange AND pushes to recent.
 *
 * Usage:
 *   <ColorInput
 *     value={hexString}        // #rrggbb
 *     onChange={(hex) => ...}  // called on every color input change
 *     onCommit={(hex) => ...}  // optional — called when the user settles
 *                              // (eyedropper pick, swatch click, hex input blur)
 *   />
 *
 * The component renders the native <input type="color"> together with an
 * optional hex text field (set showHex={false} to suppress it). It does NOT
 * render the label — the caller is responsible for that, same as before.
 */

import { useId, type ChangeEvent } from 'react'
import { Pipette } from 'lucide-react'
import { useRecentColors } from '../state/useRecentColors.js'

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
  /** Called on every color change (native picker + hex text field). */
  onChange: (hex: string) => void
  /**
   * Called when the user definitively commits a color:
   * - eyedropper pick
   * - swatch click
   * - hex text field blur with a valid value
   *
   * If omitted, `onChange` is used for commits too.
   */
  onCommit?: (hex: string) => void
  /** Render the hex text input alongside the color swatch. Default: true. */
  showHex?: boolean
  /** aria-label for the color swatch input. */
  ariaLabel?: string
  /** Extra className for the color swatch <input>. */
  inputClassName?: string
  /** Extra className for the hex text <input>. */
  hexClassName?: string
}

export function ColorInput({
  value,
  onChange,
  onCommit,
  showHex = true,
  ariaLabel = 'Color',
  inputClassName = '',
  hexClassName = '',
}: ColorInputProps) {
  const colorInputId = useId()
  const { colors: recentColors, push } = useRecentColors()

  const commit = onCommit ?? onChange

  const handleSwatchClick = (hex: string) => {
    onChange(hex)
    commit(hex)
    push(hex)
  }

  const handleNativeChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
  }

  /**
   * Push to recent on blur of the native color input — the browser opens
   * its color picker; we only know the user "committed" when focus leaves.
   */
  const handleNativeBlur = () => {
    commit(value)
    push(value)
  }

  const handleHexChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim()
    const hex = raw.startsWith('#') ? raw : `#${raw}`
    if (/^#[0-9a-f]{6}$/i.test(hex)) {
      onChange(hex)
    }
  }

  const handleHexBlur = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim()
    const hex = raw.startsWith('#') ? raw : `#${raw}`
    if (/^#[0-9a-f]{6}$/i.test(hex)) {
      commit(hex)
      push(hex)
    }
  }

  const handleEyedropper = () => {
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

  return (
    <div className="flex flex-col gap-1">
      {/* Recent colors row */}
      {recentColors.length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Recent colors">
          {recentColors.map((hex) => (
            <button
              key={hex}
              type="button"
              title={hex.toUpperCase()}
              aria-label={`Recent color ${hex.toUpperCase()}`}
              onClick={() => handleSwatchClick(hex)}
              className={[
                'h-4 w-4 rounded-sm border transition',
                hex.toLowerCase() === value.toLowerCase()
                  ? 'border-foreground shadow-[0_0_0_1.5px_hsl(var(--background))_inset]'
                  : 'border-border hover:border-border-strong',
              ].join(' ')}
              style={{ background: hex }}
            />
          ))}
        </div>
      )}

      {/* Main input row */}
      <div className="flex items-center gap-1.5">
        <input
          id={colorInputId}
          type="color"
          aria-label={ariaLabel}
          value={value}
          onChange={handleNativeChange}
          onBlur={handleNativeBlur}
          className={[
            'h-7 w-14 flex-shrink-0 cursor-pointer rounded border border-input bg-transparent p-0.5',
            inputClassName,
          ].join(' ')}
        />

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

        {/* Eyedropper */}
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
            'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-input',
            EYEDROPPER_SUPPORTED
              ? 'cursor-pointer text-muted-foreground hover:border-border-strong hover:text-foreground'
              : 'cursor-not-allowed text-muted-foreground/40',
          ].join(' ')}
        >
          <Pipette className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
