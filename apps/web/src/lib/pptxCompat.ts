/**
 * lib/pptxCompat.ts
 *
 * Pure compatibility scanner for the PPTX export pipeline. Walks every
 * slide + object in the deck and returns a list of human-readable
 * warnings about features that won't survive a `.pptx` round-trip. The
 * categories track the deferred items in `apps/server/src/pptx/export.ts`
 * (F7/F8/F12/F13/F14 + the F9 partial-fidelity case).
 *
 * Multi-level lists are NOT a loss category: the per-paragraph list model
 * (kind / level / custom glyph / autonum format / startAt) round-trips
 * fully through both the exporter (pptxgenjs paragraph-level `bullet` +
 * `indentLevel`, see `emitText`) and the importer (`paragraphs[]` block
 * attrs). The exporter no longer flattens lists to a frame-wide bullet, so
 * there is deliberately no list-flattening warning here.
 *
 * Used by `ExportPptxDialog` to surface a pre-export "you'll lose…"
 * checklist; the user can decide to proceed anyway.
 *
 * Static `IMPORT_KNOWN_LOSSES` is the same kind of list but for the
 * import direction — referenced by `ImportPptxDialog` after a
 * successful import to explain what may not have come through.
 */

import type {
  Slide,
  SlideObject,
  TextObject,
  ImageObject,
  VideoObject,
  TableObject,
} from '@narrative/shared'

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

function walkObject(obj: SlideObject, acc: Accumulator): void {
  // F8 — image rotated inside its frame independent of frame rotation.
  // The image will render upright on PPTX side; frame rotation still
  // works but the inner-rotation is lost.
  if (
    obj.type === 'image' &&
    typeof (obj as ImageObject).imageRotation === 'number' &&
    (obj as ImageObject).imageRotation !== 0
  ) {
    bump(acc, {
      id: 'imageRotation',
      title: 'Image rotated inside frame',
      detail:
        'PowerPoint has no way to rotate an image independently of its frame. The image will display upright; the frame’s own rotation still applies.',
      severity: 'lossy',
    })
  }

  // F9 — non-rect shape with image fill. The export routes it through
  // addImage so the picture renders correctly, but the shape's stroke,
  // corner radius, and shadow are dropped.
  if (
    (obj.type === 'rectangle' ||
      obj.type === 'ellipse' ||
      obj.type === 'triangle' ||
      obj.type === 'polygon') &&
    obj.fillStyle !== undefined &&
    obj.fillStyle.kind === 'image'
  ) {
    bump(acc, {
      id: 'shapeImageFill',
      title: 'Image-filled shape',
      detail:
        'PowerPoint draws the image inside a plain rectangle. The shape’s stroke, corner radius, and shadow are not preserved.',
      severity: 'simplified',
    })
  }

  // F7 — video playback flags. Any VideoObject with non-default trigger /
  // autoplay / loop / muted / volume / poster / trim values lands in
  // PPTX with default click-to-play behaviour.
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
        detail:
          'Autoplay, loop, mute, volume, poster, trim, and trigger settings are not exported. Videos will play with PowerPoint’s default click-to-play behaviour.',
        severity: 'lossy',
      })
    }
  }

  // F12 — custom fontFamily. Folder-uploaded fonts aren't embedded; the
  // recipient sees PowerPoint's substitution if they don't have the font
  // installed. We can't tell "system font" vs "user-uploaded" from the
  // client without scanning the folder's font assets — surface a single
  // umbrella warning whenever any text or table sets `fontFamily`.
  if (obj.type === 'text') {
    const t = obj as TextObject
    if (typeof t.fontFamily === 'string' && t.fontFamily.length > 0) {
      bump(acc, {
        id: 'fontEmbed',
        title: 'Custom fonts',
        detail:
          'Folder-uploaded fonts are not embedded in the .pptx. Recipients who don’t have the font installed will see PowerPoint’s substitute (usually Calibri).',
        severity: 'simplified',
      })
    }
    if (t.textTransform === 'capitalize') {
      bump(acc, {
        id: 'textTransformCapitalize',
        title: '“Capitalize” text transform',
        detail:
          'PowerPoint has no equivalent of CSS `text-transform: capitalize`. The text will render as-stored (no automatic capitalization).',
        severity: 'lossy',
      })
    }
  }
  if (obj.type === 'table') {
    const t = obj as TableObject
    if (typeof t.defaults.fontFamily === 'string' && t.defaults.fontFamily.length > 0) {
      bump(acc, {
        id: 'fontEmbed',
        title: 'Custom fonts',
        detail:
          'Folder-uploaded fonts are not embedded in the .pptx. Recipients who don’t have the font installed will see PowerPoint’s substitute (usually Calibri).',
        severity: 'simplified',
      })
    }
  }
}

/**
 * Group every object by `groupId` and surface a warning when free-form
 * groups (non-table) exist. Called separately from `walkObject` because
 * the detection is cross-object.
 */
function detectGroups(slides: Slide[], acc: Accumulator): void {
  for (const slide of slides) {
    const byGroup = new Map<string, SlideObject[]>()
    for (const obj of slide.objects ?? []) {
      if (typeof obj.groupId !== 'string' || obj.groupId.length === 0) continue
      // Tables are handled via emitGroupedTables, ignore them.
      if (obj.type === 'table') continue
      const list = byGroup.get(obj.groupId) ?? []
      list.push(obj)
      byGroup.set(obj.groupId, list)
    }
    // A "group" only matters if it has at least 2 members.
    for (const [, members] of byGroup) {
      if (members.length >= 2) {
        bump(acc, {
          id: 'freeFormGroup',
          title: 'Grouped shapes',
          detail:
            'Shapes that share a Narrative group will render at the right positions in PowerPoint, but they won’t be a selectable group on re-import.',
          severity: 'simplified',
        })
        break // one warning per slide is enough — count tracks distinct groups
      }
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
  detectGroups(slides, acc)
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
