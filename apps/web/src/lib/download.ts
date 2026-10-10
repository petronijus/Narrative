/**
 * lib/download.ts — hand a file the app fetched to the browser as a download.
 */

/** Save `blob` as `filename` through a temporary object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // The click has started the download by the next tick; free the blob after.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/**
 * A deck title as a file name: what a file system or a Content-Disposition
 * header cannot hold becomes a space (the server's `safeFilename`,
 * apps/server/src/pptx/exportDeck.ts, does the same).
 */
export function safeFilename(title: string): string {
  const trimmed = title
    .replace(/[\u0000-\u001f\u007f"'<>\\/|?*:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return trimmed.length === 0 ? 'deck' : trimmed.slice(0, 120)
}
