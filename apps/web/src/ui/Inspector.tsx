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
 */

import type { ChangeEvent } from 'react'
import { useSelection } from '../state/SelectionContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { updateObject } from '@narrative/slide-model'
import type {
  SlideObject,
  RectangleObject,
  EllipseObject,
  TextObject,
  SlideObjectPatch,
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
  onChange: (value: number) => void
}

function NumberField({ id, label, value, step = 1, onChange }: NumberFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-16 flex-shrink-0 text-xs text-gray-400">
        {label}
      </label>
      <input
        id={id}
        type="number"
        step={step}
        value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const parsed = parseFloat(e.target.value)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
        className={[
          'w-full rounded border border-gray-700 bg-gray-800 px-2 py-0.5',
          'text-right text-xs text-gray-200',
          'focus:border-blue-500 focus:outline-none',
        ].join(' ')}
      />
    </div>
  )
}

interface SectionProps {
  title: string
  children: React.ReactNode
}

function Section({ title, children }: SectionProps) {
  return (
    <div className="border-b border-gray-800 px-3 py-2">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        {title}
      </p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hlavní komponenta
// ---------------------------------------------------------------------------

export function Inspector() {
  const { selectedId } = useSelection()
  const { objects, mutationCtx } = useSlideObjects()

  if (selectedId === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-gray-600">No selection</p>
      </div>
    )
  }

  const obj = objects.find((o) => o.id === selectedId)

  if (obj === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-gray-600">Object not found</p>
      </div>
    )
  }

  function patch<T extends SlideObject>(p: SlideObjectPatch<T>) {
    if (obj === undefined) return
    updateObject(mutationCtx, obj.id, p)
  }

  const rotationDeg = radToDeg(obj.rotation)

  return (
    <div className="flex flex-col overflow-y-auto">
      {/* Position */}
      <Section title="Position">
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
      <Section title="Size">
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
      <Section title="Transform">
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
    <Section title="Appearance">
      <div className="flex items-center gap-2">
        <label
          htmlFor={`inspector-fill-${obj.id}`}
          className="w-16 flex-shrink-0 text-xs text-gray-400"
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
            className="h-6 w-8 cursor-pointer rounded border border-gray-700 bg-transparent p-0.5"
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
              'flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-0.5',
              'font-mono text-xs text-gray-200',
              'focus:border-blue-500 focus:outline-none',
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
      <Section title="Text">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`inspector-text-${obj.id}`} className="text-xs text-gray-400">
            Content
          </label>
          <textarea
            id={`inspector-text-${obj.id}`}
            defaultValue={obj.text}
            key={obj.id}
            rows={3}
            onBlur={(e) => patch({ text: e.target.value })}
            onKeyDown={(e) => {
              // Ctrl+Enter nebo Escape → blur (commit)
              if ((e.ctrlKey && e.key === 'Enter') || e.key === 'Escape') {
                e.currentTarget.blur()
              }
            }}
            className={[
              'w-full resize-none rounded border border-gray-700 bg-gray-800 px-2 py-1',
              'text-xs text-gray-200',
              'focus:border-blue-500 focus:outline-none',
            ].join(' ')}
          />
        </div>
      </Section>

      <Section title="Typography">
        <NumberField
          id={`inspector-fontsize-${obj.id}`}
          label="Size"
          value={obj.fontSize}
          onChange={(v) => patch({ fontSize: Math.max(1, v) })}
        />

        <div className="flex items-center gap-2">
          <label
            htmlFor={`inspector-fontweight-${obj.id}`}
            className="w-16 flex-shrink-0 text-xs text-gray-400"
          >
            Weight
          </label>
          <select
            id={`inspector-fontweight-${obj.id}`}
            value={obj.fontWeight}
            onChange={(e) => patch({ fontWeight: e.target.value as 'normal' | 'bold' })}
            className={[
              'flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-0.5',
              'text-xs text-gray-200',
              'focus:border-blue-500 focus:outline-none',
            ].join(' ')}
          >
            <option value="normal">Normal</option>
            <option value="bold">Bold</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor={`inspector-align-${obj.id}`}
            className="w-16 flex-shrink-0 text-xs text-gray-400"
          >
            Align
          </label>
          <select
            id={`inspector-align-${obj.id}`}
            value={obj.align}
            onChange={(e) => patch({ align: e.target.value as 'left' | 'center' | 'right' })}
            className={[
              'flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-0.5',
              'text-xs text-gray-200',
              'focus:border-blue-500 focus:outline-none',
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
            className="w-16 flex-shrink-0 text-xs text-gray-400"
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
              className="h-6 w-8 cursor-pointer rounded border border-gray-700 bg-transparent p-0.5"
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
                'flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-0.5',
                'font-mono text-xs text-gray-200',
                'focus:border-blue-500 focus:outline-none',
              ].join(' ')}
            />
          </div>
        </div>
      </Section>
    </>
  )
}
