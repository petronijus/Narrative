import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { getSlideNotesFragment, getSlideNotesText, listSlides } from '@narrative/slide-model'
import { harness } from '../testing/harness.js'
import { createDefaultRegistry } from '../catalog.js'
import { runCommand } from '../run.js'

describe('slide.setTransition', () => {
  it('patches the given fields and can clear the push direction', () => {
    const h = harness()
    h.run('slide.setTransition', { slide: 's2', kind: 'push', durationMs: 500, direction: 'up' })
    expect(listSlides(h.deck)[1]!.transition).toEqual({
      kind: 'push',
      durationMs: 500,
      direction: 'up',
    })
    h.run('slide.setTransition', { slide: 's2', durationMs: 300 })
    expect(listSlides(h.deck)[1]!.transition).toEqual({
      kind: 'push',
      durationMs: 300,
      direction: 'up',
    })
    h.run('slide.setTransition', { slide: 's2', direction: null, kind: 'fade' })
    expect(listSlides(h.deck)[1]!.transition).toEqual({ kind: 'fade', durationMs: 300 })
  })

  it('validates with the shared transition schema', () => {
    const h = harness()
    expect(h.fail('slide.setTransition', { slide: 's1', kind: 'spin' }).code).toBe('invalid_input')
    expect(h.fail('slide.setTransition', { slide: 's1', durationMs: -5 }).code).toBe(
      'invalid_input',
    )
    expect(h.fail('slide.setTransition', { slide: 's1', durationMs: 10_000_000 }).code).toBe(
      'invalid_input',
    )
    expect(h.fail('slide.setTransition', { slide: 's1' }).code).toBe('invalid_input')
  })
})

describe('slide.setBackground', () => {
  it('stores hex colours as integers and resets to the default with null', () => {
    const h = harness()
    h.run('slide.setBackground', {
      slide: 's1',
      background: {
        kind: 'radialGradient',
        centerX: 0.5,
        centerY: 0.4,
        radius: 0.8,
        stops: [
          { offset: 0, color: '#ffffff' },
          { offset: 1, color: '#000' },
        ],
      },
    })
    expect(listSlides(h.deck)[0]!.background).toEqual({
      kind: 'radialGradient',
      centerX: 0.5,
      centerY: 0.4,
      radius: 0.8,
      stops: [
        { offset: 0, color: 0xffffff, alpha: 1 },
        { offset: 1, color: 0x000000, alpha: 1 },
      ],
    })
    h.run('slide.setBackground', { slide: 's1', background: null })
    expect(listSlides(h.deck)[0]!.background).toBeUndefined()
  })

  it('refuses gradients outside the editor limits', () => {
    const h = harness()
    expect(
      h.fail('slide.setBackground', {
        slide: 's1',
        background: { kind: 'linearGradient', angleDeg: 0, stops: [{ offset: 0, color: 0 }] },
      }).code,
    ).toBe('invalid_input')
  })
})

const ids = (h: ReturnType<typeof harness>): string[] => listSlides(h.deck).map((s) => s.id)
const levels = (h: ReturnType<typeof harness>): number[] =>
  listSlides(h.deck).map((s) => s.indent ?? 0)

describe('slide.duplicate', () => {
  it('inserts the copy right after the source, keeping object ids for Magic Move', () => {
    const h = harness()
    const { slideId } = h.run<{ slideId: string }>('slide.duplicate', { slide: 's1' })
    expect(ids(h)).toEqual(['s1', slideId, 's2', 's3'])
    const [source, copy] = listSlides(h.deck)
    expect(copy!.objects.map((o) => o.id)).toEqual(source!.objects.map((o) => o.id))
    expect(copy!.animations.map((a) => a.objectId)).toEqual(
      source!.animations.map((a) => a.objectId),
    )
  })

  it('puts the copy at `index` when given', () => {
    const h = harness()
    const { slideId } = h.run<{ slideId: string }>('slide.duplicate', {
      slide: { index: 0 },
      index: 3,
    })
    expect(ids(h)).toEqual(['s1', 's2', 's3', slideId])
  })
})

describe('slide.delete', () => {
  it('deletes the given slides', () => {
    const h = harness()
    expect(h.run('slide.delete', { slides: ['s2', { index: 2 }] })).toEqual({
      deleted: ['s2', 's3'],
      landOn: 's1',
    })
    expect(ids(h)).toEqual(['s1'])
  })

  it('replaces the last remaining slide with an empty one', () => {
    const h = harness()
    h.run('slide.delete', { slides: ['s1', 's2', 's3'] })
    const slides = listSlides(h.deck)
    expect(slides).toHaveLength(1)
    expect(['s1', 's2', 's3']).not.toContain(slides[0]!.id)
    expect(slides[0]!.objects).toEqual([])
    expect(slides[0]!.animations).toEqual([])
  })

  it('validates every reference before deleting anything', () => {
    const h = harness()
    expect(h.fail('slide.delete', { slides: ['s1', 'nope'] }).code).toBe('not_found')
    expect(ids(h)).toEqual(['s1', 's2', 's3'])
  })

  it('lands on the nearest slide above the first deleted one, else the first remaining', () => {
    let h = harness()
    expect(h.run('slide.delete', { slides: ['s3', 's2'] })).toMatchObject({ landOn: 's1' })
    h = harness()
    expect(h.run('slide.delete', { slides: ['s1', 's2'] })).toMatchObject({ landOn: 's3' })
    h = harness()
    const out = h.run<{ landOn: string }>('slide.delete', { slides: ['s1', 's2', 's3'] })
    expect(out.landOn).toBe(ids(h)[0])
  })

  it("raises a deleted parent's children so none sits two levels below the slide above", () => {
    const h = harness()
    h.run('slide.indent', { slide: 's2', level: 1 })
    h.run('slide.indent', { slide: 's3', level: 2 })
    h.run('slide.delete', { slides: ['s2'] })
    expect(levels(h)).toEqual([0, 1])
  })
})

describe('slide.move — `toIndex` counts positions in the deck BEFORE the move', () => {
  it('moves one slide forward, to the end, and to the front', () => {
    let h = harness()
    h.run('slide.move', { slides: ['s1'], toIndex: 2 })
    expect(ids(h)).toEqual(['s2', 's1', 's3'])
    h = harness()
    expect(h.run('slide.move', { slides: ['s1'], toIndex: 3 })).toEqual({
      order: ['s2', 's3', 's1'],
    })
    h = harness()
    h.run('slide.move', { slides: ['s3'], toIndex: 0 })
    expect(ids(h)).toEqual(['s3', 's1', 's2'])
  })

  it('treats its own position (and the one after it) as a no-op and clamps past the end', () => {
    for (const toIndex of [1, 2]) {
      const h = harness()
      h.run('slide.move', { slides: ['s2'], toIndex })
      expect(ids(h)).toEqual(['s1', 's2', 's3'])
    }
    const h = harness()
    h.run('slide.move', { slides: ['s1'], toIndex: 99 })
    expect(ids(h)).toEqual(['s2', 's3', 's1'])
  })

  it('moves a block in deck order, whatever order the refs come in', () => {
    let h = harness()
    h.run('slide.move', { slides: ['s2', 's1'], toIndex: 3 })
    expect(ids(h)).toEqual(['s3', 's1', 's2'])
    h = harness()
    h.run('slide.move', { slides: ['s3', 's1'], toIndex: 1 })
    expect(ids(h)).toEqual(['s1', 's3', 's2'])
    h = harness()
    h.run('slide.move', { slides: [{ index: 1 }, 's3'], toIndex: 0 })
    expect(ids(h)).toEqual(['s2', 's3', 's1'])
  })
})

describe('slide.move with `level` — the slides panel drag', () => {
  it("shifts the block's levels by the same amount", () => {
    const h = harness()
    h.run('slide.indent', { slide: 's2', level: 1 })
    h.run('slide.indent', { slide: 's3', level: 2 })
    // Drag s2 with its child s3 out to the top level.
    h.run('slide.move', { slides: ['s2', 's3'], toIndex: 1, level: 0 })
    expect(levels(h)).toEqual([0, 0, 1])
  })

  it('never puts the moved block more than one level below the slide above it', () => {
    const h = harness()
    h.run('slide.move', { slides: ['s3'], toIndex: 1, level: 4 })
    expect(ids(h)).toEqual(['s1', 's3', 's2'])
    expect(levels(h)).toEqual([0, 1, 0])
    h.run('slide.move', { slides: ['s1'], toIndex: 3, level: 0 })
    expect(levels(h)).toEqual([0, 0, 0])
  })

  it('raises children left behind by a moved parent', () => {
    const h = harness()
    h.run('slide.indent', { slide: 's2', level: 1 })
    h.run('slide.indent', { slide: 's3', level: 2 })
    h.run('slide.move', { slides: ['s2'], toIndex: 0 })
    expect(ids(h)).toEqual(['s2', 's1', 's3'])
    expect(levels(h)).toEqual([0, 0, 1])
  })
})

describe('slide.copyTo', () => {
  it('copies a block in deck order to `index`, keeping object ids', () => {
    const h = harness()
    const { slideIds } = h.run<{ slideIds: string[] }>('slide.copyTo', {
      slides: ['s2', 's1'],
      index: 1,
    })
    expect(ids(h)).toEqual(['s1', ...slideIds, 's2', 's3'])
    const slides = listSlides(h.deck)
    expect(slides[1]!.objects.map((o) => o.id)).toEqual(slides[0]!.objects.map((o) => o.id))
    expect(slides[2]!.objects.map((o) => o.id)).toEqual(slides[3]!.objects.map((o) => o.id))
  })

  it('appends at the end by default and fits the levels under the slide above', () => {
    const h = harness()
    h.run('slide.indent', { slide: 's2', level: 1 })
    h.run('slide.indent', { slide: 's3', level: 2 })
    const { slideIds } = h.run<{ slideIds: string[] }>('slide.copyTo', { slides: ['s2', 's3'] })
    expect(ids(h).slice(3)).toEqual(slideIds)
    // Below s3 (level 2) the copies keep their relative structure.
    expect(levels(h)).toEqual([0, 1, 2, 1, 2])
    const front = h.run<{ slideIds: string[] }>('slide.copyTo', { slides: ['s3'], index: 0 })
    expect(ids(h)[0]).toBe(front.slideIds[0])
    expect(levels(h)[0]).toBe(0)
  })

  it('validates every reference before copying anything', () => {
    const h = harness()
    expect(h.fail('slide.copyTo', { slides: ['s1', 'nope'] }).code).toBe('not_found')
  })
})

describe('slide.indent — the slides panel depth rule', () => {
  it('keeps the first slide at level 0', () => {
    const h = harness()
    const e = h.fail('slide.indent', { slide: 's1', level: 1 })
    expect(e.code).toBe('conflict')
    expect(e.message).toContain('first slide')
    h.run('slide.indent', { slide: 's1', level: 0 })
  })

  it('allows at most one level deeper than the slide above', () => {
    const h = harness()
    expect(h.fail('slide.indent', { slide: 's2', level: 2 }).code).toBe('conflict')
    h.run('slide.indent', { slide: 's2', level: 1 })
    h.run('slide.indent', { slide: 's3', level: 2 })
    expect(listSlides(h.deck).map((s) => s.indent ?? 0)).toEqual([0, 1, 2])
    // Back to level 0 clears the stored field.
    h.run('slide.indent', { slide: 's3', level: 0 })
    expect(listSlides(h.deck)[2]!.indent).toBeUndefined()
  })
})

describe('slide.skip / slide.collapse', () => {
  it('marks and unmarks a slide as skipped', () => {
    const h = harness()
    h.run('slide.skip', { slide: 's2', skipped: true })
    expect(listSlides(h.deck)[1]!.skipped).toBe(true)
    h.run('slide.skip', { slide: 's2', skipped: false })
    expect(listSlides(h.deck)[1]!.skipped).toBeUndefined()
  })

  it('collapses and expands an outline section', () => {
    const h = harness()
    h.run('slide.collapse', { slide: 's1', collapsed: true })
    expect(listSlides(h.deck)[0]!.collapsed).toBe(true)
    h.run('slide.collapse', { slide: 's1', collapsed: false })
    expect(listSlides(h.deck)[0]!.collapsed).toBeUndefined()
  })
})

describe('slide.notes.set / slide.notes.get — speaker notes as Markdown', () => {
  const registry = createDefaultRegistry()

  it('writes the notes into the slide’s own fragment and reads them back', async () => {
    const h = harness()
    const fragment = getSlideNotesFragment(h.deck, 's1')!
    await runCommand(registry, h.ctx, 'slide.notes.set', {
      slide: 's1',
      markdown: '## Intro\n\n- **Q3** up\n- hiring',
    })
    // The same fragment: an open notes editor bound to it shows the change.
    expect(getSlideNotesFragment(h.deck, 's1')).toBe(fragment)
    expect(getSlideNotesText(h.deck, 's1')).toBe('Intro\n- Q3 up\n- hiring')
    expect(await runCommand(registry, h.ctx, 'slide.notes.get', { slide: { index: 0 } })).toEqual({
      markdown: '## Intro\n\n- **Q3** up\n- hiring',
    })
  })

  it('clears the notes with an empty string', async () => {
    const h = harness()
    await runCommand(registry, h.ctx, 'slide.notes.set', { slide: 's2', markdown: 'Something' })
    await runCommand(registry, h.ctx, 'slide.notes.set', { slide: 's2', markdown: '' })
    expect(getSlideNotesText(h.deck, 's2')).toBe('')
    expect(await runCommand(registry, h.ctx, 'slide.notes.get', { slide: 's2' })).toEqual({
      markdown: '',
    })
  })

  it('refuses an unknown slide without writing', async () => {
    const h = harness()
    const before = Y.encodeStateVector(h.deck.doc)
    await expect(
      runCommand(registry, h.ctx, 'slide.notes.set', { slide: 'nope', markdown: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(Y.encodeStateVector(h.deck.doc)).toEqual(before)
  })
})
