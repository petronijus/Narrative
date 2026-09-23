/**
 * lib/pptxCompat.ts
 *
 * Pure compatibility scanner for the PPTX export. Walks every slide and
 * object in the deck and lists what PowerPoint will show differently from
 * Narrative.
 *
 * The exporter (apps/server/src/pptx/ooxml/) writes every model value: what
 * OOXML can express natively, the rest in Narrative's own extension inside
 * the file, so a deck exported and imported again is the same deck
 * (apps/server/src/pptx/roundtrip.test.ts). Nothing listed here is lost —
 * each entry is something PowerPoint itself cannot draw the way Narrative
 * does, and which comes back when the .pptx is opened in Narrative again.
 *
 * Used by `ExportPptxDialog` to surface a pre-export checklist; the user can
 * decide to proceed anyway.
 *
 * Static `IMPORT_KNOWN_LOSSES` is the same kind of list but for the
 * import direction — referenced by `ImportPptxDialog` after a
 * successful import to explain what may not have come through.
 */

import type { Slide, SlideObject, TextObject, VideoObject } from '@narrative/shared'

/**
 * One compatibility issue surfaced to the user. `count` aggregates across
 * the whole deck so the dialog can render "3 videos with autoplay" instead
 * of repeating the same message thrice.
 */
export interface CompatWarning {
  /** Stable id — useful for tests + telemetry, not shown to users. */
  id: string
  /** One-line summary, rendered as the warning title. */
  title: string
  /** Longer explanation, rendered below the title. */
  detail: string
  /** How many objects / slides trigger this warning. */
  count: number
  /** 'lossy' = data discarded; 'simplified' = preserved but changed. */
  severity: 'lossy' | 'simplified'
}

/**
 * Per-warning increments — internal accumulator shape. Each entry maps
 * to one final CompatWarning; counts add up as the walker visits each
 * object.
 */
interface Accumulator {
  [id: string]: { count: number; warning: Omit<CompatWarning, 'count'> }
}

function bump(acc: Accumulator, entry: Omit<CompatWarning, 'count'>): void {
  const existing = acc[entry.id]
  if (existing !== undefined) {
    existing.count += 1
  } else {
    acc[entry.id] = { count: 1, warning: entry }
  }
}

const RESTORED =
  'Narrative keeps it in the file and restores it when the .pptx is opened in Narrative again.'

function walkObject(obj: SlideObject, acc: Accumulator): void {
  if (obj.type === 'image' && typeof obj.imageRotation === 'number' && obj.imageRotation !== 0) {
    bump(acc, {
      id: 'imageRotation',
      title: 'Image rotated inside frame',
      detail: `PowerPoint cannot rotate a picture inside its frame; it shows the picture upright. ${RESTORED}`,
      severity: 'simplified',
    })
  }

  if (obj.type === 'video') {
    const v = obj as VideoObject
    const hasPlaybackTweaks =
      v.autoplay === true ||
      v.loop === true ||
      v.muted === false ||
      (typeof v.volume === 'number' && v.volume !== 1) ||
      typeof v.posterTime === 'number' ||
      typeof v.trimStart === 'number' ||
      typeof v.trimEnd === 'number' ||
      (typeof v.videoTrigger === 'string' && v.videoTrigger !== 'onClick')
    if (hasPlaybackTweaks) {
      bump(acc, {
        id: 'videoPlayback',
        title: 'Video playback options',
        detail: `PowerPoint plays the video on click with its own defaults, not with its autoplay, loop, mute, volume, poster, trim and trigger settings. ${RESTORED}`,
        severity: 'simplified',
      })
    }
  }

  // One radius per corner: PowerPoint's rounded rectangle has one.
  const perCorner = (r: unknown): boolean => typeof r === 'object' && r !== null
  if (
    (obj.type === 'rectangle' && perCorner(obj.cornerRadius)) ||
    (obj.type === 'image' && obj.mask?.kind === 'rectangle' && perCorner(obj.mask.cornerRadius))
  ) {
    bump(acc, {
      id: 'cornerRadiusPerCorner',
      title: 'Different radius per corner',
      detail: `PowerPoint rounds all four corners alike; it shows the average of the four radii. ${RESTORED}`,
      severity: 'simplified',
    })
  }

  // Folder-uploaded fonts aren't embedded; the recipient sees PowerPoint's
  // substitution if the font isn't installed. The client can't tell a system
  // font from an uploaded one, so any explicit family raises it.
  const fontFamily =
    obj.type === 'text'
      ? obj.fontFamily
      : obj.type === 'table'
        ? obj.defaults.fontFamily
        : undefined
  if (typeof fontFamily === 'string' && fontFamily.length > 0) {
    bump(acc, {
      id: 'fontEmbed',
      title: 'Custom fonts',
      detail:
        'Folder-uploaded fonts are not embedded in the .pptx. Recipients who don’t have the font installed will see PowerPoint’s substitute (usually Calibri).',
      severity: 'simplified',
    })
  }

  if (obj.type === 'text') {
    const t = obj as TextObject
    if (t.textTransform === 'capitalize') {
      bump(acc, {
        id: 'textTransformCapitalize',
        title: '“Capitalize” text transform',
        detail: `PowerPoint has no automatic capitalisation of each word; it shows the text as typed. ${RESTORED}`,
        severity: 'simplified',
      })
    }
    if (typeof t.fontWeight === 'number' && t.fontWeight !== 400 && t.fontWeight !== 700) {
      bump(acc, {
        id: 'fontWeight',
        title: 'Font weights between regular and bold',
        detail: `PowerPoint knows regular and bold only; light, medium and similar weights show as the nearer of the two. ${RESTORED}`,
        severity: 'simplified',
      })
    }
    if (t.flipH === true || t.flipV === true) {
      bump(acc, {
        id: 'mirroredText',
        title: 'Mirrored text',
        detail: `PowerPoint does not mirror text; a flipped text box shows its text readable. ${RESTORED}`,
        severity: 'simplified',
      })
    }
  }
}

/**
 * Scan a deck for every export incompatibility. Sorted lossy >
 * simplified > alphabetical so the dialog always leads with the most
 * painful losses. Counts aggregate across the whole deck (a deck with
 * 3 rotated images surfaces a single entry with `count: 3`).
 */
export function scanDeckForExportCompat(slides: Slide[]): CompatWarning[] {
  const acc: Accumulator = {}
  for (const slide of slides) {
    for (const obj of slide.objects ?? []) walkObject(obj, acc)
  }
  return Object.values(acc)
    .map((e) => ({ ...e.warning, count: e.count }))
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'lossy' ? -1 : 1
      return a.title.localeCompare(b.title)
    })
}

/**
 * Static list of import-side losses — features PPTX has that Narrative
 * doesn't model cleanly. Surfaced after every import so the user knows
 * what to inspect. Augmented with the parser's `ignoredElements` array
 * which contains the literal tags it couldn't handle.
 */
export const IMPORT_KNOWN_LOSSES: ReadonlyArray<Omit<CompatWarning, 'count'>> = [
  {
    id: 'charts',
    title: 'Charts',
    detail:
      'PowerPoint chart objects are imported as static images — the underlying data and editability are not preserved.',
    severity: 'lossy',
  },
  {
    id: 'smartArt',
    title: 'SmartArt',
    detail: 'SmartArt diagrams are not imported. The slide region they occupied will be empty.',
    severity: 'lossy',
  },
  {
    id: 'oleEmbed',
    title: 'Embedded Office objects',
    detail: 'Embedded spreadsheets, equations, and OLE objects are dropped.',
    severity: 'lossy',
  },
  {
    id: 'nestedGroups',
    title: 'Nested groups',
    detail:
      'Nested `<p:grpSp>` groups are flattened on import — children survive, but the grouping hierarchy is lost.',
    severity: 'simplified',
  },
  {
    id: 'complexTiming',
    title: 'Complex animation timing',
    detail:
      'Each animation step is imported as a basic preset / trigger / duration. Easing, by-paragraph delivery, motion paths, and bookmarks may simplify.',
    severity: 'simplified',
  },
  {
    id: 'layoutInherit',
    title: 'Slide masters & layouts',
    detail:
      'Master / layout placeholders are baked into each slide as concrete shapes. Edits to one slide no longer propagate via the layout system.',
    severity: 'simplified',
  },
  {
    id: 'unembeddedFonts',
    title: 'Fonts referenced but not embedded',
    detail:
      'Some text uses custom font families that aren’t shipped inside the .pptx (PowerPoint’s “Embed fonts in the file” option was off when the deck was saved). Those runs render in a category-matched fallback (sans / serif / monospace) until you upload the real font in Folder settings.',
    severity: 'simplified',
  },
]

/**
 * Take the parser's `ignoredElements` (e.g. `["a:chart", "a:smartArt"]`)
 * and return only the user-relevant entries — the parser tracks every
 * tag it didn't recognise but most of them are uninteresting plumbing.
 */
export function relevantIgnoredElements(ignored: ReadonlyArray<string>): string[] {
  const relevant = new Set([
    'a:chart',
    'c:chart',
    'a:smartArt',
    'p:oleObj',
    'p:OLEObject',
    'mc:AlternateContent',
    'p:bldOver',
    'p:tnLst',
  ])
  return ignored.filter((tag) => relevant.has(tag))
}
