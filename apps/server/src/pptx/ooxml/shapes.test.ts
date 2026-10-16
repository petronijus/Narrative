/**
 * shapes.test.ts — where an exported picture sits in its frame
 * (`fittedRect`, the geometry its srcRect is written from): as the renderer
 * draws it (web renderer/mediaFit.ts), centred or against the side an
 * image's `focus` keeps in view.
 */

import { describe, expect, it } from 'vitest'
import { fittedRect } from './shapes.js'

const frame = { x: 100, y: 100, width: 300, height: 300 }
/** A 2:1 picture. */
const wide = { width: 80, height: 40 }

describe('fittedRect', () => {
  it('covers the frame centred, or keeping the focus side in view', () => {
    expect(fittedRect(frame, wide, 'cover')).toEqual({ x: -50, y: 100, width: 600, height: 300 })
    expect(fittedRect(frame, wide, 'cover', 'left')).toMatchObject({ x: 100, y: 100 })
    expect(fittedRect(frame, wide, 'cover', 'right')).toMatchObject({ x: -200, y: 100 })
    // A focus across the axis that is not cropped changes nothing.
    expect(fittedRect(frame, wide, 'cover', 'top')).toEqual(fittedRect(frame, wide, 'cover'))
  })

  it('puts a contained picture against the focus side', () => {
    expect(fittedRect(frame, wide, 'contain')).toEqual({ x: 100, y: 175, width: 300, height: 150 })
    expect(fittedRect(frame, wide, 'contain', 'top')).toMatchObject({ y: 100 })
    expect(fittedRect(frame, wide, 'contain', 'bottom')).toMatchObject({ y: 250 })
  })

  it('fills the frame when the picture size is not known', () => {
    expect(fittedRect(frame, undefined, 'cover', 'left')).toEqual(frame)
  })
})
