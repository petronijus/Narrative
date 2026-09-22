/**
 * lib/pptxFiles.ts
 *
 * Deciding whether a dropped file is something the import pipeline can
 * actually read — shared by every drop target (folder pages, the slides
 * panel) so they agree on the answer and, more importantly, on the wording
 * of the refusal.
 *
 * The distinction that matters is `.pptx` vs `.ppt`. They look like the same
 * thing in Finder and people drag them interchangeably, but `.ppt` is the
 * pre-2007 binary format (an OLE compound file), and the parser reads OOXML
 * out of a ZIP. Handing it a `.ppt` produces "Could not parse .pptx — End of
 * central directory record not found", which tells the user nothing about
 * what to do next. So we catch it here and say the one useful thing: re-save
 * it as .pptx.
 */

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** The legacy binary PowerPoint MIME, for the rare browser that reports it. */
const PPT_MIME = 'application/vnd.ms-powerpoint'

/**
 * The OOXML presentation MIME is the canonical answer, but some systems —
 * Safari in particular — hand over an empty string or `application/zip` for
 * the same file, so the extension is the fallback rather than the other way
 * round.
 */
export function isPptxFile(file: File): boolean {
  if (file.name.toLowerCase().endsWith('.pptx')) return true
  return file.type === PPTX_MIME
}

/** Pre-2007 binary `.ppt` — recognised only so it can be refused clearly. */
export function isLegacyPptFile(file: File): boolean {
  if (file.name.toLowerCase().endsWith('.ppt')) return true
  return file.type === PPT_MIME
}

/**
 * Why this file can't be imported, or null when it can. The string is shown
 * to the user as-is.
 */
export function pptxRejectionReason(file: File): string | null {
  if (isPptxFile(file)) return null
  if (isLegacyPptFile(file)) {
    return `“${file.name}” is a legacy .ppt. Open it in PowerPoint or Keynote and save it as .pptx, then drop it again.`
  }
  return 'Only .pptx files can be imported.'
}

/**
 * Does this drag carry at least one file? Read from `types` rather than
 * `files`, which is empty during dragover for security reasons — the
 * filenames are only revealed on drop.
 */
export function dragHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false
  return Array.from(dataTransfer.types).includes('Files')
}
