/**
 * node/photos.ts — the photos the browser scenes place (scenes.ts): six JPEGs
 * of 3200 × 2133, generated once with ImageMagick from fixed seeds into the
 * harness's cache, or the *.jpg of PERF_PHOTOS (the old probe's knob).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { perfHome } from './store.js'

/** JPEGs to upload: PERF_PHOTOS, or six generated once (fixed seed) into the harness cache. */
export function photoFiles(): string[] {
  let dir = process.env['PERF_PHOTOS']
  if (dir === undefined || dir === '') {
    dir = path.join(perfHome(), 'photos-v1')
    mkdirSync(dir, { recursive: true })
    for (let i = 1; i <= 6; i++) {
      const file = path.join(dir, `photo${i}.jpg`)
      if (!existsSync(file)) {
        execFileSync('magick', [
          ...['-seed', String(i), '-size', '3200x2133', 'plasma:fractal'],
          ...['-attenuate', '0.6', '+noise', 'Gaussian', '-quality', '82', file],
        ])
      }
    }
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => path.join(dir, f))
}

/**
 * The present-mode photo deck's pictures (scenes.ts → presentPhotoOps):
 * twelve distinct JPEGs of 3000 × 2000 — a camera's frame size, so each is
 * served as imgproxy's 2560-px `display` variant — generated once with
 * ImageMagick from fixed seeds.
 */
export function presentPhotoFiles(): string[] {
  const dir = path.join(perfHome(), 'present-photos-v1')
  mkdirSync(dir, { recursive: true })
  const files: string[] = []
  for (let i = 1; i <= 12; i++) {
    const file = path.join(dir, `present${String(i).padStart(2, '0')}.jpg`)
    if (!existsSync(file)) {
      execFileSync('magick', [
        ...['-seed', String(100 + i), '-size', '3000x2000', 'plasma:fractal'],
        ...['-blur', '0x2', '-attenuate', '0.4', '+noise', 'Gaussian', '-quality', '85', file],
      ])
    }
    files.push(file)
  }
  return files
}

/**
 * The present-mode video (scenes.ts → presentVideoOps): `seconds` of
 * 1920 × 1080 H.264 at 30 fps (ffmpeg's testsrc2 with a moving counter),
 * generated once with ffmpeg. 1.8 Mbit/s keeps the upload under the command
 * API's 4 MB body as base64; what plays is the video worker's transcode.
 */
export function presentVideoFile(seconds = 10): string {
  const dir = path.join(perfHome(), 'present-video-v1')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `testsrc2-1080p-${seconds}s-1800k.mp4`)
  if (!existsSync(file)) {
    execFileSync('ffmpeg', [
      ...[
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
      ],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium'],
      ...['-b:v', '1800k', '-maxrate', '2000k', '-bufsize', '4000k'],
      ...['-movflags', '+faststart', '-y', file],
    ])
  }
  return file
}

/**
 * The 4K present-mode video (present.video.4k, performance.md → P3):
 * `seconds` of 3840 × 2160 H.264 at 30 fps, testsrc2 under temporal grain so
 * the encoder spends a camera's bitrate (~20 Mbit/s, 25 MB for 10 s) — a
 * clean testsrc2 compresses to almost nothing, and the bitrate is part of
 * what a decoder pays. A keyframe every 2 s. Generated once with ffmpeg
 * into the harness cache (written to a temporary name first, so an
 * interrupted run leaves no half file); too large for the command API's
 * body, so it is uploaded through tus (e2e/perf/lib/presentDecks.ts). What
 * plays is the video worker's output: the stream copied as the playback
 * file, and its 1080p rendition (`present.mp4`).
 */
export function presentVideo4kFile(seconds = 10): string {
  const dir = path.join(perfHome(), 'present-video-v1')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `testsrc2-2160p-${seconds}s-grain-20M.mp4`)
  if (!existsSync(file)) {
    const partial = `${file}.partial.mp4`
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-f', 'lavfi'],
      ...['-i', `testsrc2=size=3840x2160:rate=30:duration=${seconds}`],
      ...['-vf', 'noise=alls=10:allf=t', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
      ...['-preset', 'veryfast', '-b:v', '20M', '-maxrate', '25M', '-bufsize', '40M', '-g', '60'],
      ...['-movflags', '+faststart', '-y', partial],
    ])
    renameSync(partial, file)
  }
  return file
}
