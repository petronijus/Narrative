import { describe, expect, it } from 'vitest'
import { getDeckGuidesCtx, listDeckGuides, listSlides } from '@narrative/slide-model'
import { harness, type Harness } from '../testing/harness.js'

const guides = (h: Harness) => listDeckGuides(getDeckGuidesCtx(h.deck.doc))

describe('guide.*', () => {
  it('adds guides inside the slide: x 0..1920 for vertical, y 0..1080 for horizontal', () => {
    const h = harness()
    const { guideId } = h.run<{ guideId: string }>('guide.add', {
      orientation: 'vertical',
      position: 1920,
    })
    expect(guides(h)).toContainEqual({ id: guideId, orientation: 'vertical', position: 1920 })
    expect(h.fail('guide.add', { orientation: 'horizontal', position: 1200 }).code).toBe(
      'invalid_input',
    )
    expect(h.fail('guide.add', { orientation: 'vertical', position: -1 }).code).toBe(
      'invalid_input',
    )
  })

  it("moves a guide within its own orientation's bounds", () => {
    const h = harness()
    h.run('guide.update', { guide: 'gd1', position: 1500 })
    expect(guides(h)).toEqual([{ id: 'gd1', orientation: 'vertical', position: 1500 }])
    const { guideId } = h.run<{ guideId: string }>('guide.add', {
      orientation: 'horizontal',
      position: 100,
    })
    expect(h.fail('guide.update', { guide: guideId, position: 1500 }).code).toBe('invalid_input')
    expect(h.fail('guide.update', { guide: 'nope', position: 10 }).code).toBe('not_found')
  })

  it('removes guides and nothing else', () => {
    const h = harness()
    const before = listSlides(h.deck)
    h.run('guide.remove', { guides: ['gd1'] })
    expect(guides(h)).toEqual([])
    expect(listSlides(h.deck)).toEqual(before)
    expect(h.fail('guide.remove', { guides: ['gd1'] }).code).toBe('not_found')
  })
})
