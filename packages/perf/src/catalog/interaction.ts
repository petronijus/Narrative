/**
 * catalog/interaction.ts — the layer I benches (docs/plans/perf-harness.md →
 * The benchmark catalogue): the editor driven by real pointer and key events
 * in a browser. Defined here — ids, what they cover, their metrics — so the
 * coverage guard and the budget check see them; their `run` is bound by the
 * Playwright driver (apps/web/e2e/perf/), which is the only place that can run
 * them (`bindRun`).
 *
 * Every bench reports the same time metrics (input-to-pixel, frames, long
 * tasks, the editor's render time, how long the gesture's work went on after
 * the last input) and a list of work counters. A work counter is budgeted
 * exactly in perf/budgets/<id>.json; a count that depends on how many frames
 * a gesture happened to span (renders, rasters per key) is a time metric
 * instead. A count of once-a-frame work during a stream of inputs — the
 * slide-object flush of a drag — is `perFrame`: exact where the runtime draws
 * a frame per input (headless Chromium), a time metric in every other runtime
 * (defineBench.ts → metricsFor).
 */

import { defineBench, type BenchDef, type MetricSpec, type SceneRef } from '../defineBench.js'

const ms: MetricSpec = { unit: 'ms', better: 'lower', kind: 'time' }
const timedCount: MetricSpec = { unit: 'count', better: 'lower', kind: 'time' }
const work: MetricSpec = { unit: 'count', better: 'lower', kind: 'work' }
const workPerFrame: MetricSpec = { ...work, perFrame: true }
const workKpx: MetricSpec = { unit: 'count', better: 'lower', kind: 'work' }

/** Time metrics of a gesture: what a person feels, and what the frame loop did. */
export const GESTURE_METRICS: Readonly<Record<string, MetricSpec>> = {
  'input.p50': ms,
  'input.p90': ms,
  'input.max': ms,
  'frame.p50': ms,
  'frame.p90': ms,
  'frame.max': ms,
  'frame.over50': timedCount,
  'longTask.total': ms,
  'render.ms': ms,
  'render.count': timedCount,
  /** From the last input to the scene being quiet again (rasters, thumbnails, loads). */
  settle: ms,
  wall: ms,
}

/** Time metrics of opening a deck, from navigation start. */
export const OPEN_METRICS: Readonly<Record<string, MetricSpec>> = {
  'open.firstPaint': ms,
  'open.wsSynced': ms,
  /** Every object of the first slide mounted on the canvas. */
  'open.mounted': ms,
  /** Nothing moving any more: rasters, thumbnails, loads — "all thumbnails". */
  'open.settled': ms,
  'longTask.total': ms,
  'render.count': timedCount,
}

/**
 * The work counters a bench may budget. Each is a counter of the in-page
 * harness (apps/web/src/perf/harness.ts) or a sum of a family of them
 * (`sg.mount` = every `sg.mount.<type>`).
 */
export const WORK_COUNTERS = [
  'text.raster.started',
  'text.raster.kpx',
  // kB of @font-face CSS embedded into the rasters' SVGs, and the rasters
  // that wait Pixi's fixed 100 ms in WebKit (performance.md → E2, W1).
  'text.raster.fontKb',
  'text.raster.safariDelay',
  'text.measure.bounds',
  'text.autofit.measure',
  'text.restage',
  'thumb.render',
  'thumb.live',
  'thumb.text.raster.started',
  'thumb.text.raster.fontKb',
  'thumb.reused',
  'sg.mount',
  'sg.update',
  'sg.destroy',
  'procedural.created',
  'procedural.hit',
  'filters.applied',
  'gl.texUpload',
  'gl.texUploadKpx',
  'gl.mipmap',
  'y.listSlides',
  'y.listSlides.objects',
  'y.tx.local',
  'y.tx.local.empty',
  'y.observeDeep.slideObjects',
  'y.slideObjects.flush',
  'net.requests',
  'net.api',
  'net.mediaUrl',
  'net.imgproxy',
  // Pictures the ResourceManager loaded (fetched and decoded) as textures.
  'rm.texture.load',
] as const

export type WorkCounter = (typeof WORK_COUNTERS)[number]

/**
 * Counters measured on every run but never budgeted: how often a gesture's
 * frames happened to fire them depends on the machine (time metrics).
 */
export const TIMED_COUNTERS = [
  'react.commits',
  'react.renders',
  'thumb.live.unsettled',
  'thumb.live.kept',
  'text.restage.texts',
  'y.tx.remote',
  'y.tx.remote.empty',
  'y.observeDeep.slides',
  // The shared deck store (slide-model deckStore.ts, performance.md → E1):
  // its observer calls, the rebuilds a read after a change triggers, the
  // object snapshots rebuilt, the per-frame notifications. Rebuilds and
  // notifications follow the frames a gesture spans.
  'y.observeDeep.deckStore',
  'y.deckStore.rebuild',
  'y.deckStore.objects',
  'y.deckStore.notify',
  'y.observeDeep.deckSlideEvents',
  'gl.draw',
  'gl.stencil',
  'gl.bufferData',
  'gl.thumb.texUpload',
  'gl.thumb.texUploadKpx',
  // The ResourceManager's upload gate (apps/web/src/renderer/textureUploadGate.ts):
  // large textures it uploaded, their kpx, the frames that uploaded, the most
  // kpx one frame uploaded (a high-water mark), textures that missed a frame
  // for the budget and the frames they waited past their first, frames held
  // while present mode moved, and the times the budget shrank after a long
  // task. Whether a texture waits depends on when its decode lands.
  'rm.upload.count',
  'rm.upload.kpx',
  'rm.upload.frames',
  'rm.upload.frameKpxMax',
  'rm.upload.deferred',
  'rm.upload.waitFrames',
  'rm.upload.held',
  'rm.upload.shrunk',
  'net.code',
  'net.storage',
  'net.other',
] as const

/** The scenes of the layer I scenarios (generated by the driver from these knobs). */
export const SCENES = {
  /** perf-heavy-slide: 120 texts, 40 pictures, 60 rectangles + three probes (PERF_TEXTS/IMAGES/RECTS). */
  crowded: { generator: 'crowded-slide', seed: 1, size: { texts: 120, images: 40, rects: 60 } },
  /** perf-zoom-drag: one text and twelve rectangles. */
  light: { generator: 'light-slide', seed: 1, size: { texts: 1, rects: 12 } },
  /** A deck of N slides, each with 6 texts, 4 rectangles and 2 pictures (PERF_SLIDES). */
  deck10: { generator: 'deck', seed: 1, size: { slides: 10, objectsPerSlide: 12 } },
  deck100: { generator: 'deck', seed: 1, size: { slides: 100, objectsPerSlide: 12 } },
  /** Present mode: 12 slides of text in a folder font (scenes.ts → presentTextOps). */
  presentText: { generator: 'present-text', seed: 1, size: { slides: 12, texts: 8 } },
  /** Present mode: 12 slides of photos, 12 distinct pictures, 3 a slide (presentPhotoOps). */
  presentPhoto: { generator: 'present-photo', seed: 1, size: { slides: 12, photos: 12 } },
  /** Present mode: one slide per transition the DSL has — fade, push ×4, cube, magic (presentTransitionOps). */
  presentTransitions: { generator: 'present-transitions', seed: 1, size: { slides: 8 } },
  /** Present mode: build animations — afterPrevious chains, onClick steps, withPrevious groups (presentBuildOps). */
  presentBuilds: { generator: 'present-builds', seed: 1, size: { slides: 4 } },
  /** Present mode: a 10 s 1080p H.264 video between two text slides (presentVideoOps). */
  presentVideo: { generator: 'present-video', seed: 1, size: { slides: 3, videoSeconds: 10 } },
  /**
   * Present mode: the same deck with a 10 s 4K H.264 source (~20 Mbit/s): its
   * 1080p rendition or the original, as present mode chooses (P3).
   */
  presentVideo4k: {
    generator: 'present-video',
    seed: 1,
    size: { slides: 3, videoSeconds: 10, videoHeight: 2160 },
  },
  /** Present mode: the 4K source trimmed to 4.5–7 s and looped (P3: a loop restarts by a seek). */
  presentVideoLoop: {
    generator: 'present-video',
    seed: 1,
    size: { slides: 3, videoSeconds: 10, videoHeight: 2160, trimStartMs: 4500, trimEndMs: 7000 },
  },
  /** One styled 12 × 8 table in Inter, every cell with text, and a title-only second slide (tableSlideOps). */
  table: { generator: 'table-slide', seed: 1, size: { rows: 12, cols: 8 } },
} as const satisfies Record<string, SceneRef>

/** The driver binds this; anywhere else a run is a mistake. */
function unbound(id: string) {
  return (): never => {
    throw new Error(`${id} is a layer I bench: it runs from apps/web/e2e/perf (just perf ${id})`)
  }
}

/**
 * The growth benches' budgeted counts (apps/web/e2e/perf/memory.spec.ts,
 * performance.md → E8). Each run is one session: the scene opened, a first
 * pass (caches fill), then the same pass twice more; what a repeated pass
 * left behind that the one before had not is growth, and growth that repeats
 * with every pass is a leak. Each count is the growth both repeated passes
 * show (the smaller of the two), never below 0 (a pass that gives memory back
 * is no leak; a one-off in flight at one snapshot shows in only one pass): textures and their MB
 * (glResidency.ts), WebGL contexts alive, elements, event listeners (CDP,
 * Chromium; 0 elsewhere), object URLs not revoked, and the retained JS heap
 * over its bound (`MEMORY_HEAP_BOUND_MB`; CDP after a full GC, Chromium).
 */
export const MEMORY_WORK = [
  'mem.leak.heapMB',
  'mem.leak.textures',
  'mem.leak.textureMB',
  'mem.leak.contexts',
  'mem.leak.nodes',
  'mem.leak.listeners',
  'mem.leak.blobUrls',
] as const

export type MemoryCounter = (typeof MEMORY_WORK)[number]

const mb: MetricSpec = { unit: 'count', better: 'lower', kind: 'time' }

/**
 * Time metrics of a growth bench: where the session stands after its first
 * pass and what each pass added, signed (a pass may give memory back). The
 * heap is read through CDP after a full collection (Chromium; 0 in WebKit,
 * where only the GL, DOM and URL figures exist), never `performance.memory`
 * (bucketed and cached for 20 minutes, present.spec.ts → retainedHeap).
 */
export const MEMORY_METRICS: Readonly<Record<string, MetricSpec>> = {
  /** Retained JS heap right after the scene opened, MB. */
  'mem.heapMB': mb,
  /** What the first pass added (caches filling), MB. */
  'mem.heap.firstMB': mb,
  /** What the second, identical pass added, MB: the leak signal. */
  'mem.heap.growMB': mb,
  /** Textures of the scene's GL context at the end, and what each pass added. */
  'mem.textures': timedCount,
  'mem.textures.first': timedCount,
  'mem.textures.grow': timedCount,
  /** Their bytes (estimate: 4 per pixel, every level), MB. */
  'mem.textureMB': mb,
  'mem.textureMB.grow': mb,
  /** Every WebGL context alive and not lost at the end (editor, thumbnails, offscreen). */
  'mem.contexts': timedCount,
  'mem.nodes': timedCount,
  'mem.nodes.grow': timedCount,
  'mem.listeners': timedCount,
  'mem.listeners.grow': timedCount,
  'mem.blobUrls': timedCount,
  'mem.blobUrls.grow': timedCount,
  wall: ms,
}

/**
 * The retained heap a growth bench's second pass may add before it counts
 * (`mem.leak.heapMB` = whole MB above it): V8 does not hand back every page
 * it compacted, inline caches and lazily compiled code grow on a path's
 * second walk, and React's dev build keeps more of each commit. Measured on
 * the leak-free tree (performance.md → Log, E8 2026-10-23); a bound is not a
 * budget for growth, it is the noise floor under one.
 */
export const MEMORY_HEAP_BOUND_MB: Readonly<Record<string, number>> = {
  'memory.slide.switch': 2,
  'memory.zoom.cycle': 2,
  'memory.deck.reopen': 2,
  'memory.present.loop': 2,
}

interface InteractionOptions {
  scene: SceneRef
  actions?: readonly string[]
  commands?: readonly string[]
  /** Work counters budgeted exactly for this bench. */
  work: readonly (WorkCounter | MemoryCounter)[]
  /**
   * Those of `work` that count once-a-frame work during the gesture's stream
   * of inputs: budgeted where the runtime draws a frame per input, timed
   * elsewhere (`MetricSpec.perFrame`).
   */
  perFrame?: readonly WorkCounter[]
  /** The time metrics (default: the gesture's). */
  time?: Readonly<Record<string, MetricSpec>>
  threshold?: number
  /** Default warm-up and recorded runs (`BenchDef.runs`). */
  runs?: { warmup: number; runs: number }
}

function interaction(id: string, o: InteractionOptions): BenchDef<never> {
  const metrics: Record<string, MetricSpec> = { ...(o.time ?? GESTURE_METRICS) }
  const perFrame = new Set<string>(o.perFrame ?? [])
  for (const c of perFrame)
    if (!(o.work as readonly string[]).includes(c))
      throw new Error(`${id}: perFrame ${c} is not one of its work counters`)
  for (const c of o.work)
    metrics[c] = perFrame.has(c)
      ? workPerFrame
      : c.endsWith('Kpx') || c.endsWith('.kpx')
        ? workKpx
        : work
  // Every other counter is measured too, as a time metric: visible in every
  // result and A/B, never budgeted (its count follows the frames).
  for (const c of [...WORK_COUNTERS, ...TIMED_COUNTERS])
    if (!(c in metrics)) metrics[c] = timedCount
  return defineBench<never>({
    id,
    area: id.split('.')[0]!,
    layer: 'I',
    scene: o.scene,
    ...(o.actions !== undefined ? { actions: o.actions } : {}),
    ...(o.commands !== undefined ? { commands: o.commands } : {}),
    run: unbound(id),
    metrics,
    ...(o.threshold !== undefined ? { threshold: o.threshold } : {}),
    ...(o.runs !== undefined ? { runs: o.runs } : {}),
  })
}

/**
 * What a drag costs that must not change unnoticed: no rasters, mounts,
 * uploads or new gradient textures, and — per pointer move — one document
 * transaction, no `listSlides` deep copy of the deck and one slide-object
 * observer call (the renderer's); per frame that carried a move, one flush
 * and its object update (DRAG_PER_FRAME). Counted on 2026-10-18 in dev,
 * deterministic across runs on SwiftShader at load 35 and on Metal; before
 * E1 (performance.md) a move made six deck copies and eleven observer calls.
 * Live thumbnails and mipmaps are not budgeted: whether the thumbnail is drawn
 * from the canvas or offscreen depends on how fast the scene settles.
 */
const DRAG_WORK: readonly WorkCounter[] = [
  'text.raster.started',
  'text.raster.kpx',
  'text.autofit.measure',
  'sg.mount',
  'sg.update',
  'sg.destroy',
  'procedural.created',
  'gl.texUpload',
  'y.tx.local',
  'y.listSlides',
  'y.listSlides.objects',
  'y.observeDeep.slideObjects',
  'y.slideObjects.flush',
]

/**
 * What of DRAG_WORK a drag counts once a frame, not once a move: the
 * slide-object observer's flush (rAF-batched, slide-model slideObserve.ts →
 * PERF-1) and the scene updates it applies. Every move arrives in every
 * runtime — `y.tx.local` and the observer calls equal the moves in WebKit
 * too — but where frames are paced apart from the input (WebKit headless,
 * headed and in Tauri) two moves can share a frame and one flush: 59 of 60
 * in headless WebKit, 85–90 of 90 headed (performance.md → W1). Awaiting a
 * frame per move would make them exact there, and would stop measuring the
 * case the batching exists for — a mouse faster than the display.
 */
const DRAG_PER_FRAME: readonly WorkCounter[] = ['sg.update', 'y.slideObjects.flush']

/** A drag's work: DRAG_WORK, its per-frame part exact in headless Chromium only. */
const DRAG = { work: DRAG_WORK, perFrame: DRAG_PER_FRAME } as const

/**
 * Opening a deck: the first slide's mounts and rasters, the writes an open
 * makes (4 on 2026-10-18 — an open should write nothing). The thumbnail count,
 * the deck copies (24 `listSlides`, now and then 28: a late sync update) and
 * the requests are timed: a warm open draws one thumbnail from the canvas when
 * it settles in time, and the HTTP cache decides the rest.
 */
const OPEN_WORK: readonly WorkCounter[] = [
  'sg.mount',
  'text.raster.started',
  'text.raster.kpx',
  'text.autofit.measure',
  'gl.texUpload',
  'y.tx.local',
]
/** Switching to a slide and back: twice its objects mounted and destroyed, its texts rasterised again (E3). */
const SWITCH_WORK: readonly WorkCounter[] = [
  'sg.mount',
  'sg.destroy',
  'text.raster.started',
  'text.raster.kpx',
  'text.measure.bounds',
  'y.listSlides',
  'y.tx.local',
  'thumb.render',
  'net.requests',
]
/** One slide moved: one transaction, the deck copied six times; the ~105 thumbnails it redraws are timed. */
const REORDER_WORK: readonly WorkCounter[] = [
  'sg.mount',
  'sg.destroy',
  'text.raster.started',
  'y.listSlides',
  'y.listSlides.objects',
  'y.tx.local',
]
/** One slide added (and shown): its predecessor's objects go; the thumbnails it redraws are timed. */
const ADD_WORK: readonly WorkCounter[] = [
  'sg.mount',
  'sg.destroy',
  'text.raster.started',
  'y.listSlides',
  'y.listSlides.objects',
  'y.tx.local',
]

/** A zoom changes no document and mounts nothing; its text re-rasters follow the frames (timed). */
const ZOOM_WORK: readonly WorkCounter[] = [
  'sg.mount',
  'sg.update',
  'y.tx.local',
  'y.listSlides',
  'thumb.render',
  'net.requests',
]

/**
 * Time metrics of a presentation pass (performance.md → D): the presentation
 * opened and made ready, then every advance of the pass, recorded from the
 * first input on. A pass is smooth when no frame is missed and no advance
 * waits for anything but its own transition and builds.
 */
export const PRESENT_METRICS: Readonly<Record<string, MetricSpec>> = {
  /** Navigation to "ready": the preparing overlay gone, the first slide shown. */
  'present.ready': ms,
  /** Frames drawn (rAF) during the pass. */
  'present.frames': timedCount,
  /** Frames the display missed: Σ (round(frame ÷ refresh interval) − 1) over the pass. */
  'present.dropped': timedCount,
  /** Frames longer than twice the refresh interval. */
  'present.hitches': timedCount,
  'frame.p50': ms,
  'frame.p99': ms,
  'frame.max': ms,
  /** One advance: the input to the incoming slide fully shown and quiet (its transition and builds done). */
  'advance.p50': ms,
  'advance.max': ms,
  /** Long tasks of the pass (Chromium; WebKit has no Long Tasks API). */
  'longTask.total': ms,
  'longTask.max': ms,
  /**
   * Textures the canvas's GL context gained over the pass (created minus
   * deleted, ready to the end): every slide was shown and left again, so
   * anything above 0 stayed behind (performance.md → E8).
   */
  'present.glTextures': timedCount,
  /** JS heap retained after the pass, MB (Chromium, after a GC through CDP — since 2026-10-23, before that the bucketed, 20-min-cached performance.memory; 0 elsewhere). */
  'present.heapMB': { unit: 'count', better: 'lower', kind: 'time' },
  wall: ms,
}

/**
 * Work after "ready" that must be none: no text rasterised, no texture
 * uploaded, nothing mounted, no picture loaded or decoded, no request, no
 * thumbnail rendered — every advance only composites what was prepared.
 */
const PRESENT_WORK: readonly WorkCounter[] = [
  'text.raster.started',
  'text.raster.kpx',
  'gl.texUpload',
  'gl.texUploadKpx',
  'sg.mount',
  'rm.texture.load',
  'net.requests',
  'thumb.render',
]
/** A playing video uploads a texture per frame and streams its file: those follow the frames. */
const PRESENT_VIDEO_WORK: readonly WorkCounter[] = [
  'text.raster.started',
  'text.raster.kpx',
  'sg.mount',
  'rm.texture.load',
  'thumb.render',
]
const PRESENT_ACTIONS = ['present.start', 'present.next', 'present.previous'] as const

/**
 * A video pass's own metrics (performance.md → P3), beside the frames of the
 * page: what the video itself did while it played, read from the playing
 * elements (present.spec.ts → video probe).
 */
const PRESENT_VIDEO_METRICS: Readonly<Record<string, MetricSpec>> = {
  ...PRESENT_METRICS,
  /** Video frames handed to the canvas (requestVideoFrameCallback), the pass's playback. */
  'video.frames': { unit: 'count', better: 'higher', kind: 'time' },
  /** Video frames that were never shown: gaps in the presented frames' media time. */
  'video.skipped': timedCount,
  /** Frames the decoder dropped (getVideoPlaybackQuality). */
  'video.decoderDropped': timedCount,
  /** The longest wait from `play` to the first new frame handed to the canvas (a start or a loop's restart). */
  'video.startMs': ms,
  /** The larger side of the file that played, px (3840: the original of a 4K source; 1920: its rendition). */
  'video.width': { unit: 'count', better: 'lower', kind: 'time' },
  /** CPU time of the browser's GPU process over the pass (Chromium; 0 elsewhere). */
  'proc.gpuCpuMs': ms,
  /** CPU time of the page's renderer process over the pass (Chromium; 0 elsewhere). */
  'proc.rendererCpuMs': ms,
  /** Resident memory of the browser's GPU process after the pass, MB (Chromium; 0 elsewhere). */
  'proc.gpuRssMB': { unit: 'count', better: 'lower', kind: 'time' },
}

/**
 * The table slide's gestures (performance.md → E5) also report the most draw
 * calls one frame took (`frame.draws`): the table's cells, masks and fills as
 * the GPU sees them. Timed, not budgeted — how Pixi batches depends on the
 * GPU's texture units.
 */
const TABLE_METRICS: Readonly<Record<string, MetricSpec>> = {
  ...GESTURE_METRICS,
  'frame.draws': timedCount,
}
/** Showing the table slide: its cells mounted and rasterised, their textures uploaded. */
const TABLE_MOUNT_WORK: readonly WorkCounter[] = [
  'sg.mount',
  'sg.destroy',
  'text.raster.started',
  'text.raster.kpx',
  'text.raster.fontKb',
  'text.measure.bounds',
  'procedural.created',
  'gl.texUpload',
  'gl.texUploadKpx',
  'y.tx.local',
]
/** Typing into one cell: one transaction per key; the rasters per key follow the frames. */
const TABLE_TYPE_WORK: readonly WorkCounter[] = [
  'sg.mount',
  'sg.destroy',
  'y.tx.local',
  'procedural.created',
  'thumb.render',
  'net.requests',
]

/** Warm-up and recorded runs of a growth bench: one run is a long session. */
const MEMORY_RUNS = { warmup: 1, runs: 3 } as const

export const INTERACTION_BENCHES: ReadonlyArray<BenchDef<never>> = [
  interaction('editor.idle.crowded', {
    scene: SCENES.crowded,
    work: [
      'text.raster.started',
      'sg.mount',
      'sg.update',
      'gl.texUpload',
      'thumb.render',
      'y.tx.local',
      'y.listSlides',
      'net.requests',
    ],
  }),
  interaction('transform.nudge.rect', {
    scene: SCENES.crowded,
    actions: ['object.nudge'],
    commands: ['object.move'],
    work: DRAG_WORK,
  }),
  interaction('transform.move.rect', {
    scene: SCENES.crowded,
    commands: ['object.move'],
    ...DRAG,
  }),
  interaction('transform.move.text', { scene: SCENES.crowded, ...DRAG }),
  interaction('transform.move.image', { scene: SCENES.crowded, ...DRAG }),
  interaction('transform.move.multi', { scene: SCENES.crowded, ...DRAG }),
  interaction('viewport.zoom.wheel', {
    scene: SCENES.crowded,
    actions: ['view.zoomIn', 'view.zoomOut'],
    work: ZOOM_WORK,
  }),
  // The zoom's commit path: zoom in, rest (the backbuffer resizes, the texts
  // are re-rasterised at the new resolution), zoom back out, rest. The wheel
  // bench above ends where it started, so it commits nothing.
  interaction('viewport.zoom.commit', {
    scene: SCENES.crowded,
    actions: ['view.zoomIn', 'view.zoomOut'],
    work: ZOOM_WORK,
  }),
  interaction('text.type.inter', {
    scene: SCENES.crowded,
    commands: ['text.edit'],
    // Rasters per key follow the frames (a key that lands mid-raster is drawn with the next).
    work: [
      'sg.mount',
      'sg.destroy',
      'y.tx.local',
      'y.observeDeep.slideObjects',
      'text.autofit.measure',
      'thumb.render',
      'net.requests',
    ],
  }),
  interaction('viewport.zoom.wheel.light', { scene: SCENES.light, work: ZOOM_WORK }),
  // The table slide (apps/web/e2e/perf/table-slide.spec.ts).
  interaction('table.mount.styled', {
    scene: SCENES.table,
    time: TABLE_METRICS,
    work: TABLE_MOUNT_WORK,
  }),
  interaction('table.cell.type', {
    scene: SCENES.table,
    time: TABLE_METRICS,
    work: TABLE_TYPE_WORK,
  }),
  // Dragging the table: a drag's work like any other (E5 timed its per-move
  // counts, read then as lost moves; they were the per-frame flush, W1).
  interaction('transform.move.table', {
    scene: SCENES.table,
    time: TABLE_METRICS,
    ...DRAG,
  }),
  interaction('viewport.zoom.commit.table', {
    scene: SCENES.table,
    time: TABLE_METRICS,
    work: ZOOM_WORK,
  }),
  interaction('transform.move.rect.light', { scene: SCENES.light, ...DRAG }),
  interaction('deck.open.cold.10', { scene: SCENES.deck10, time: OPEN_METRICS, work: OPEN_WORK }),
  interaction('deck.open.warm.10', { scene: SCENES.deck10, time: OPEN_METRICS, work: OPEN_WORK }),
  interaction('deck.open.cold.100', { scene: SCENES.deck100, time: OPEN_METRICS, work: OPEN_WORK }),
  interaction('deck.open.warm.100', { scene: SCENES.deck100, time: OPEN_METRICS, work: OPEN_WORK }),
  interaction('slide.switch.100', {
    scene: SCENES.deck100,
    actions: ['slide.next', 'slide.previous'],
    work: SWITCH_WORK,
  }),
  interaction('slide.reorder.100', {
    scene: SCENES.deck100,
    commands: ['slide.move'],
    work: REORDER_WORK,
  }),
  interaction('slide.add.100', {
    scene: SCENES.deck100,
    commands: ['slide.add'],
    work: ADD_WORK,
  }),
  // Present mode (apps/web/e2e/perf/present.spec.ts): each run opens the
  // presentation, waits for "ready", then advances through every slide,
  // back to the first, and counts the work after ready.
  interaction('present.advance.text', {
    scene: SCENES.presentText,
    actions: PRESENT_ACTIONS,
    time: PRESENT_METRICS,
    work: PRESENT_WORK,
  }),
  // A presenter's pace: six advances, each slide held 4 s before the next.
  // What rests between two advances goes cold on the GPU (renderer/
  // presentSlides.ts → "Kept warm"); the quick pass above never rests.
  interaction('present.advance.paced', {
    scene: SCENES.presentText,
    actions: PRESENT_ACTIONS,
    time: PRESENT_METRICS,
    work: PRESENT_WORK,
  }),
  interaction('present.advance.photo', {
    scene: SCENES.presentPhoto,
    actions: PRESENT_ACTIONS,
    time: PRESENT_METRICS,
    work: PRESENT_WORK,
  }),
  interaction('present.transition.all', {
    scene: SCENES.presentTransitions,
    actions: PRESENT_ACTIONS,
    commands: ['slide.setTransition'],
    time: PRESENT_METRICS,
    work: PRESENT_WORK,
  }),
  interaction('present.build.steps', {
    scene: SCENES.presentBuilds,
    actions: PRESENT_ACTIONS,
    commands: ['animation.add'],
    time: PRESENT_METRICS,
    work: PRESENT_WORK,
  }),
  interaction('present.video.play', {
    scene: SCENES.presentVideo,
    actions: PRESENT_ACTIONS,
    time: PRESENT_VIDEO_METRICS,
    work: PRESENT_VIDEO_WORK,
  }),
  // A 4K source (P3): present mode plays its 1080p rendition where the
  // canvas shows no more pixels than it has (renderer/videoRendition.ts).
  interaction('present.video.4k', {
    scene: SCENES.presentVideo4k,
    actions: PRESENT_ACTIONS,
    time: PRESENT_VIDEO_METRICS,
    work: PRESENT_VIDEO_WORK,
  }),
  // A trimmed, looped video held over several loops: each loop is a seek
  // back to the trim start, on stage (ui/EditorVideoPreview.tsx).
  interaction('present.video.loop', {
    scene: SCENES.presentVideoLoop,
    actions: PRESENT_ACTIONS,
    time: PRESENT_VIDEO_METRICS,
    work: PRESENT_VIDEO_WORK,
  }),
  // Hyperlinks to a slide far away, there and back: the jump target is known
  // from the slide the link sits on.
  interaction('present.jump.link', {
    scene: SCENES.presentPhoto,
    actions: ['present.start'],
    time: PRESENT_METRICS,
    work: PRESENT_WORK,
  }),
  // The pop-out presenter window (`?presenter=1`, its notes and next-slide
  // picture) drives the presentation; the main window is measured, the
  // presenter window's work is counted with it.
  interaction('present.presenter.window', {
    scene: SCENES.presentText,
    actions: ['present.start'],
    time: PRESENT_METRICS,
    work: PRESENT_WORK,
  }),
  // Growth (apps/web/e2e/perf/memory.spec.ts, performance.md → E8): one run is
  // one session — open, a first pass, the same pass again — so 1 warm-up and
  // 3 runs; the other counters are the second pass's (timed).
  // The 100-slide deck: down through every slide and back up (198 switches), twice.
  interaction('memory.slide.switch', {
    scene: SCENES.deck100,
    time: MEMORY_METRICS,
    work: MEMORY_WORK,
    runs: MEMORY_RUNS,
  }),
  // The crowded slide: five zoom commits in and out (each re-rasterises every text), twice.
  interaction('memory.zoom.cycle', {
    scene: SCENES.crowded,
    time: MEMORY_METRICS,
    work: MEMORY_WORK,
    runs: MEMORY_RUNS,
  }),
  // The 10-slide deck closed to its folder and opened again (in-app navigation), five times, twice.
  interaction('memory.deck.reopen', {
    scene: SCENES.deck10,
    time: MEMORY_METRICS,
    work: MEMORY_WORK,
    runs: MEMORY_RUNS,
  }),
  // One presentation of the photo deck: forward through every slide and back, twice, twice.
  interaction('memory.present.loop', {
    scene: SCENES.presentPhoto,
    time: MEMORY_METRICS,
    work: MEMORY_WORK,
    runs: MEMORY_RUNS,
  }),
]

/** A layer I bench with its run bound — what the driver passes to runBench / runInterleaved. */
export function bindRun<Ctx>(def: BenchDef<never>, run: BenchDef<Ctx>['run']): BenchDef<Ctx> {
  return defineBench<Ctx>({ ...(def as unknown as BenchDef<Ctx>), run })
}
