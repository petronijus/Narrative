import { describe, expect, it } from 'vitest'
import { choosePlayback, presentStageScale } from './videoRendition.js'

const info = {
  playbackUrl: 'https://s/playback.mp4',
  presentPlayback: { url: 'https://s/present.mp4', width: 1920, height: 1080 },
}

describe('choosePlayback (performance.md P3)', () => {
  it('plays the 1080p rendition when the screen shows no more pixels than it has', () => {
    // A full-slide 4K video on a 1920×1080 screen, and on a smaller window.
    expect(choosePlayback(info, { width: 1920, height: 1080 }, 1)?.kind).toBe('present')
    expect(choosePlayback(info, { width: 1920, height: 1080 }, 0.75)?.kind).toBe('present')
    // Half the slide on a 4K screen (2× the slide): still 1920 device px wide.
    expect(choosePlayback(info, { width: 960, height: 540 }, 2)?.kind).toBe('present')
  })

  it('plays the original where the rendition would look softer', () => {
    // A Retina laptop (3024 px wide) or a 4K projector, full slide.
    expect(choosePlayback(info, { width: 1920, height: 1080 }, 1.575)?.kind).toBe('playback')
    expect(choosePlayback(info, { width: 1920, height: 1080 }, 2)?.kind).toBe('playback')
    // Cover crops: a square box filled by a 16:9 picture draws it larger.
    expect(choosePlayback(info, { width: 1080, height: 1080, fit: 'cover' }, 1.5)?.kind).toBe(
      'playback',
    )
    expect(choosePlayback(info, { width: 1080, height: 1080, fit: 'contain' }, 1.5)?.kind).toBe(
      'present',
    )
  })

  it('falls back to the playback without a rendition, and to nothing without either', () => {
    expect(
      choosePlayback({ ...info, presentPlayback: null }, { width: 100, height: 100 }, 1),
    ).toEqual({ url: info.playbackUrl, kind: 'playback' })
    expect(
      choosePlayback({ playbackUrl: null, presentPlayback: null }, { width: 1, height: 1 }, 1),
    ).toBeNull()
  })

  it('measures the presentation in device pixels', () => {
    expect(presentStageScale({ innerWidth: 1512, innerHeight: 982, devicePixelRatio: 2 })).toBe(
      1.575,
    )
    expect(presentStageScale({ innerWidth: 1920, innerHeight: 1200, devicePixelRatio: 1 })).toBe(1)
  })
})
