/**
 * main/updateVerify.ts
 *
 * The gate every downloaded update passes before the app offers to install
 * it (docs/plans/desktop-d0-spec.md §3.11, ADR 0015): the file's SHA-512
 * goes into the manifest the release signed, and the signature fetched from
 * the feed must verify against the pinned key. One gate for every platform:
 * electron-updater's own Windows hook runs only for Authenticode-signed
 * builds, and installs happen only through `quitAndInstall` after this
 * (`autoInstallOnAppQuit` is off). Electron is injected, so this is tested
 * without it.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { buildManifest, verifyUpdateSignature } from './updateSignature.js'

export interface DownloadedUpdate {
  /** Where electron-updater put the file. */
  downloadedFile: string
  version: string
  /** The feed's file URLs (relative or absolute) for this version. */
  files: readonly { url: string }[]
}

export interface VerifyDeps {
  feedBase: string
  publicKey: string
  /** Fetch a small text from the feed; null when it is missing or the fetch failed. */
  fetchText(url: string): Promise<string | null>
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

function sha512(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

export async function verifyDownloadedUpdate(
  update: DownloadedUpdate,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const name = path.basename(update.downloadedFile)
  // The name signed is the feed's: the downloaded file must be one of them.
  const feedNames = update.files.map((f) => path.basename(new URL(f.url, deps.feedBase).pathname))
  if (!feedNames.includes(name)) return { ok: false, reason: 'not a file of this release' }
  const signatureUrl = new URL(`${encodeURIComponent(name)}.manifest.sig`, deps.feedBase).toString()
  const signature = await deps.fetchText(signatureUrl)
  if (signature === null) return { ok: false, reason: 'no signature in the feed' }
  let digest: string
  try {
    digest = await sha512(update.downloadedFile)
  } catch {
    return { ok: false, reason: 'the download cannot be read' }
  }
  const manifest = buildManifest(name, update.version, digest)
  return verifyUpdateSignature(manifest, signature, deps.publicKey)
    ? { ok: true }
    : { ok: false, reason: 'signature does not match' }
}
