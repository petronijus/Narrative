/**
 * state/uploadMetadata.ts
 *
 * The tus Upload-Metadata the editor sends with a media upload
 * (useMediaUpload.tsx). Its own module so the provider file exports only
 * components (fast refresh).
 */

/** Who an upload belongs to: a deck, or a component master (its own pictures and videos, A2.12b). */
export type MediaUploadOwner = { deckId: string } | { componentId: string }

/**
 * The tus Upload-Metadata of a file (the JSON body of the creation request,
 * never custom headers — browser CORS strips those). The owner decides the
 * binding key: `deckId` or `componentId`, never both.
 */
export function buildUploadMetadata(
  owner: MediaUploadOwner,
  file: Pick<File, 'name' | 'type'>,
  dims: { width?: number; height?: number } = {},
): Record<string, string> {
  const metadata: Record<string, string> = {
    ...('componentId' in owner ? { componentId: owner.componentId } : { deckId: owner.deckId }),
    filename: file.name,
    'content-type': file.type,
  }
  if (dims.width !== undefined) metadata['width'] = String(dims.width)
  if (dims.height !== undefined) metadata['height'] = String(dims.height)
  return metadata
}
