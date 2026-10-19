import { describe, expect, it } from 'vitest'
import { matchFaces, type FaceRequest, type MatchableFace } from './fontFaceMatch'

const face = (weight: string, style: MatchableFace['style'] = 'normal', stretch = '100%') => ({
  id: `${weight}/${style}/${stretch}`,
  weight,
  style,
  stretch,
})

const req = (
  weight: number,
  style: FaceRequest['style'] = 'normal',
  stretch = 100,
): FaceRequest => ({
  weight,
  style,
  stretch,
})

const pick = (faces: ReturnType<typeof face>[], r: FaceRequest): string[] =>
  matchFaces(faces, r).map((f) => f.id)

describe('matchFaces — CSS Fonts 4 §5.2 for our descriptors', () => {
  const statics = [face('300'), face('400'), face('600'), face('700'), face('900')]

  it('takes an exact weight', () => {
    expect(pick(statics, req(600))).toEqual(['600/normal/100%'])
  })

  it('between 400 and 500: heavier up to 500 first, then lighter, then above 500', () => {
    const f = [face('300'), face('450'), face('500'), face('700')]
    expect(pick(f, req(400))).toEqual(['450/normal/100%'])
    expect(pick([face('300'), face('700')], req(400))).toEqual(['300/normal/100%'])
    expect(pick([face('700'), face('900')], req(450))).toEqual(['700/normal/100%'])
    // 500 with no 500: lighter faces before 600+.
    expect(pick(statics, req(500))).toEqual(['400/normal/100%'])
  })

  it('below 400 lighter faces first, above 500 heavier ones first', () => {
    expect(pick(statics, req(200))).toEqual(['300/normal/100%'])
    expect(pick([face('400'), face('700')], req(350))).toEqual(['400/normal/100%'])
    expect(pick([face('300'), face('400')], req(350))).toEqual(['300/normal/100%'])
    expect(pick(statics, req(800))).toEqual(['900/normal/100%'])
    expect(pick([face('400'), face('600')], req(800))).toEqual(['600/normal/100%'])
  })

  it('bold with no bold face draws the regular one (the browser synthesises bold from it)', () => {
    expect(pick([face('400'), face('400', 'italic')], req(700))).toEqual(['400/normal/100%'])
  })

  it('a variable range matches inside it and by its nearer end outside it', () => {
    const f = [face('100 900'), face('100 900', 'italic')]
    expect(pick(f, req(650))).toEqual(['100 900/normal/100%'])
    expect(pick(f, req(650, 'italic'))).toEqual(['100 900/italic/100%'])
    expect(pick([face('200 300'), face('600 800')], req(450))).toEqual(['200 300/normal/100%'])
    expect(pick([face('200 300'), face('480 800')], req(450))).toEqual(['480 800/normal/100%'])
  })

  it('slope: italic → oblique → normal, normal → oblique → italic', () => {
    const all = [face('400'), face('400', 'italic'), face('400', 'oblique')]
    // (The engines tie the oblique face with the italic one: both are kept.)
    expect(pick(all, req(400, 'italic'))).toEqual(['400/italic/100%', '400/oblique/100%'])
    expect(pick(all, req(400))).toEqual(['400/normal/100%'])
    expect(pick([face('400'), face('400', 'oblique')], req(400, 'italic'))).toEqual([
      '400/oblique/100%',
    ])
    // Slope narrows before weight: an italic request takes the light italic
    // over the exact-weight upright face.
    expect(pick([face('700'), face('300', 'italic')], req(700, 'italic'))).toEqual([
      '300/italic/100%',
    ])
  })

  it('an oblique face next to an italic one: the pick of the specification and of the engines', () => {
    // The specification takes the italic face for an italic request whatever
    // its weight; Chromium and WebKit let the two slopes tie and the weight
    // decide (e2e/htmltext-face-subset.spec.ts). Both are embedded.
    const f = [face('400', 'italic'), face('800', 'oblique')]
    expect(pick(f, req(700, 'italic'))).toEqual(['400/italic/100%', '800/oblique/100%'])
    expect(pick(f, req(400, 'italic'))).toEqual(['400/italic/100%'])
    expect(pick([face('400', 'italic'), face('400', 'oblique')], req(400))).toEqual([
      '400/italic/100%',
      '400/oblique/100%',
    ])
  })

  it('width narrows first: at or below normal narrower faces, above it wider ones', () => {
    const f = [
      face('400', 'normal', '75%'),
      face('400', 'normal', '100%'),
      face('700', 'normal', '125%'),
    ]
    expect(pick(f, req(700, 'normal', 87.5))).toEqual(['400/normal/75%'])
    expect(pick(f, req(400, 'normal', 112.5))).toEqual(['700/normal/125%'])
    expect(pick([face('400', 'normal', '75% 125%')], req(400, 'normal', 110))).toEqual([
      '400/normal/75% 125%',
    ])
  })

  it('keeps every face with the same descriptors (one composite face)', () => {
    const f = [{ ...face('400'), id: 'a' }, { ...face('400'), id: 'b' }, face('700')]
    expect(pick(f, req(400))).toEqual(['a', 'b'])
  })

  it('finds nothing only in nothing', () => {
    expect(pick([], req(400))).toEqual([])
  })
})
