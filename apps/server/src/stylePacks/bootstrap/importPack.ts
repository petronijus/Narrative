/**
 * stylePacks/bootstrap/importPack.ts — `just style-pack-import <pack.json>
 * <folderId> [api]` (agentic A4.7): put a bootstrapped pack into a folder
 * through the command API, as the owner of a personal access token
 * (`NARRATIVE_TOKEN`, scope `api`; never printed). Production imports are
 * Petr's call, brand by brand.
 *
 *   1. `style.pack.edit` set — the pack as built, validated whole by the
 *      server; then compile: the folder's tokens and component masters.
 *   2. The pack's files (logos in the private overlay) are uploaded with
 *      `media.upload` into one of the masters the compile made — a master's
 *      media belongs to its folder — and the pack's assets are pointed at
 *      them (`style.pack.edit` update).
 *   3. The fonts the folder still lacks are listed: they come from the
 *      brand's font files (folder.fonts.upload, or Folder Settings → Fonts).
 *
 * `api` is the command API's base: `http://localhost:3001` for the dev
 * stack (the default), `https://narrative.bastla.com/api` in production.
 */

import { readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { StylePack } from '@narrative/shared'

interface CommandResponse<T> {
  ok: boolean
  result?: T
  error?: { code: string; message: string }
}

async function main(): Promise<void> {
  const [packArg, folderId, apiArg] = process.argv.slice(2)
  if (packArg === undefined || folderId === undefined) {
    console.error(
      'usage: style-pack-import <pack.json> <folderId> [api base, default http://localhost:3001]',
    )
    process.exit(2)
  }
  const token = process.env['NARRATIVE_TOKEN']
  if (token === undefined || token === '') {
    console.error(
      'NARRATIVE_TOKEN is not set: a personal access token with the api scope (Settings → Access tokens)',
    )
    process.exit(2)
  }
  const api = (apiArg === undefined || apiArg === '' ? 'http://localhost:3001' : apiArg).replace(
    /\/+$/,
    '',
  )
  const packFile = resolve(packArg)
  // The pack's file paths are relative to the private overlay (packs/<id>/…).
  const overlay = resolve(dirname(packFile), '..')
  const pack = JSON.parse(readFileSync(packFile, 'utf8')) as StylePack

  const run = async <T>(
    target: Record<string, string>,
    command: string,
    input: unknown,
  ): Promise<T> => {
    const res = await fetch(`${api}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ target, command, input, client: 'style-pack import' }),
    })
    const body = (await res.json().catch(() => ({}))) as CommandResponse<T>
    if (!res.ok || body.ok !== true)
      throw new Error(
        `${command}: ${body.error?.code ?? res.status} ${body.error?.message ?? res.statusText}`,
      )
    return body.result as T
  }

  console.log(`${pack.id}: setting the pack in folder ${folderId} (${api})`)
  await run({ folderId }, 'style.pack.edit', { op: 'set', pack })
  const first = await run<{
    compiled: { missingFonts: string[]; components: { created: number; updated: number } }
  }>({ folderId }, 'style.pack.edit', { op: 'compile' })
  console.log(
    `  compiled: ${first.compiled.components.created} masters created, ${first.compiled.components.updated} updated`,
  )

  // Files the pack names, uploaded into a master of the pack's.
  const files = new Map<string, string>() // file path → assetId
  const sources = Object.values(pack.assets).flatMap((a) => [
    ...(a.file !== undefined && 'file' in a.file ? [a.file.file] : []),
    ...Object.values(a.byRole?.files ?? {}).flatMap((s) => ('file' in s ? [s.file] : [])),
  ])
  if (sources.length > 0) {
    const masters = await run<{ components: Array<{ id: string; name: string }> }>(
      { folderId },
      'component.list',
      {},
    )
    const names = new Set(pack.components.map((c) => c.name))
    const host = masters.components.find((c) => names.has(c.name))
    if (host === undefined)
      throw new Error(
        'no master of the pack in the folder to hold its files (the pack has no components?)',
      )
    for (const file of new Set(sources)) {
      const bytes = readFileSync(join(overlay, file))
      const ext = extname(file).slice(1).toLowerCase()
      const mimeType =
        ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      const uploaded = await run<{ assetId: string }>({ componentId: host.id }, 'media.upload', {
        file: { base64: bytes.toString('base64'), filename: basename(file), mimeType },
      })
      files.set(file, uploaded.assetId)
      console.log(`  uploaded ${file} → ${uploaded.assetId}`)
    }
    const patch: Record<string, unknown> = {}
    for (const [id, a] of Object.entries(pack.assets)) {
      const point = (s: { file: string } | { assetId: string }) =>
        'file' in s && files.has(s.file) ? { assetId: files.get(s.file)! } : s
      patch[id] = {
        ...(a.file !== undefined ? { file: point(a.file) } : {}),
        ...(a.byRole !== undefined
          ? {
              byRole: {
                role: a.byRole.role,
                files: Object.fromEntries(
                  Object.entries(a.byRole.files).map(([k, s]) => [k, point(s)]),
                ),
              },
            }
          : {}),
      }
    }
    await run({ folderId }, 'style.pack.edit', { op: 'update', patch: { assets: patch } })
  }

  if (first.compiled.missingFonts.length > 0)
    console.log(`  the folder still needs these fonts: ${first.compiled.missingFonts.join(', ')}`)
  console.log(`${pack.id}: done`)
}

main().catch((e: unknown) => {
  console.error((e as Error).message)
  process.exit(1)
})
