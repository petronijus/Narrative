/**
 * yDoc.test.ts
 *
 * Tests for the M9 Y.Doc factory:
 * - createSlideDoc() creates one default empty slide for fresh docs
 * - hydrateSlideDoc() migrates legacy root objects/animations to slides[0]
 * - Migration is idempotent (second call is a no-op)
 * - Root objects/animations are left intact after migration (non-destructive)
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { createSlideDoc, hydrateSlideDoc } from './yDoc.js'
import { plainObjectToYMap } from './bindings.js'
import { animationStepToYMap } from './animationBindings.js'
import type { SlideObject } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Fresh doc behavior
// ---------------------------------------------------------------------------

describe('createSlideDoc — fresh doc', () => {
  it('returns { doc, slides }', () => {
    const handles = createSlideDoc()
    expect(handles.doc).toBeInstanceOf(Y.Doc)
    expect(handles.slides).toBeDefined()
  })

  it('creates exactly one default empty slide', () => {
    const { slides } = createSlideDoc()
    expect(slides.length).toBe(1)
  })

  it('default slide has id, objects, animations, transition', () => {
    const { slides } = createSlideDoc()
    const slide = slides.get(0)
    expect(typeof slide.get('id')).toBe('string')
    expect(slide.get('id')).not.toBe('')
    expect(slide.get('objects')).toBeInstanceOf(Y.Array)
    expect(slide.get('animations')).toBeInstanceOf(Y.Array)
    expect(slide.get('transition')).toBeInstanceOf(Y.Map)
  })

  it('default slide objects and animations are empty', () => {
    const { slides } = createSlideDoc()
    const slide = slides.get(0)
    const objects = slide.get('objects') as Y.Array<Y.Map<unknown>>
    const animations = slide.get('animations') as Y.Array<Y.Map<unknown>>
    expect(objects.length).toBe(0)
    expect(animations.length).toBe(0)
  })

  it('default transition is none / 0ms', () => {
    const { slides } = createSlideDoc()
    const slide = slides.get(0)
    const transition = slide.get('transition') as Y.Map<unknown>
    expect(transition.get('kind')).toBe('none')
    expect(transition.get('durationMs')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Legacy migration (backward compat strategy B)
// ---------------------------------------------------------------------------

const SAMPLE_RECT = {
  id: 'legacy-rect-1',
  type: 'rectangle',
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
}

const SAMPLE_ANIM = {
  id: 'legacy-anim-1',
  objectId: 'legacy-rect-1',
  preset: 'fadeIn' as const,
  trigger: 'onEnter' as const,
  duration: 0.5,
  delay: 0,
  easing: 'power2.out',
}

function seedLegacyDoc(): Y.Doc {
  const doc = new Y.Doc()
  const legacyObjects = doc.getArray<Y.Map<unknown>>('objects')
  const legacyAnimations = doc.getArray<Y.Map<unknown>>('animations')

  doc.transact(() => {
    legacyObjects.push([plainObjectToYMap(SAMPLE_RECT as unknown as SlideObject)])
    legacyAnimations.push([animationStepToYMap(SAMPLE_ANIM)])
  })

  return doc
}

describe('hydrateSlideDoc — legacy migration', () => {
  it('migrates root objects to slides[0].objects', () => {
    const doc = seedLegacyDoc()
    const { slides } = hydrateSlideDoc(doc)

    expect(slides.length).toBe(1)
    const slide = slides.get(0)
    const objects = slide.get('objects') as Y.Array<Y.Map<unknown>>
    expect(objects.length).toBe(1)
    expect(objects.get(0).get('id')).toBe('legacy-rect-1')
  })

  it('migrates root animations to slides[0].animations', () => {
    const doc = seedLegacyDoc()
    const { slides } = hydrateSlideDoc(doc)

    const slide = slides.get(0)
    const animations = slide.get('animations') as Y.Array<Y.Map<unknown>>
    expect(animations.length).toBe(1)
    expect(animations.get(0).get('id')).toBe('legacy-anim-1')
  })

  it('leaves root objects array intact (non-destructive)', () => {
    const doc = seedLegacyDoc()
    const rootObjects = doc.getArray<Y.Map<unknown>>('objects')
    hydrateSlideDoc(doc)
    // Root arrays must still have their original data
    expect(rootObjects.length).toBe(1)
  })

  it('leaves root animations array intact (non-destructive)', () => {
    const doc = seedLegacyDoc()
    const rootAnimations = doc.getArray<Y.Map<unknown>>('animations')
    hydrateSlideDoc(doc)
    expect(rootAnimations.length).toBe(1)
  })

  it('is idempotent — second call does not re-migrate', () => {
    const doc = seedLegacyDoc()
    hydrateSlideDoc(doc)
    const { slides } = hydrateSlideDoc(doc) // second call

    // Should still have exactly 1 slide, not 2
    expect(slides.length).toBe(1)
    const slide = slides.get(0)
    const objects = slide.get('objects') as Y.Array<Y.Map<unknown>>
    expect(objects.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Already-migrated doc — no-op
// ---------------------------------------------------------------------------

describe('hydrateSlideDoc — already migrated doc', () => {
  it('no-op when slides is already populated', () => {
    const { doc, slides } = createSlideDoc()
    const initialSlideId = slides.get(0).get('id') as string

    hydrateSlideDoc(doc) // second call

    expect(slides.length).toBe(1)
    expect(slides.get(0).get('id')).toBe(initialSlideId)
  })
})
