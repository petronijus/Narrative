/**
 * stylePacks/bootstrap/cli.ts — `just style-pack <brand> [sources] [out dir]`
 * (agentic A4.7): build a brand's style pack from its sources, check it
 * whole and write it as JSON into the private overlay
 * (`private/packs/<id>.json`). Which brands exist, and the rules each
 * brand's pack follows, live in the overlay too (`private/bootstrap/index.ts`:
 * `brands` and `defaultSources`): a client's brand never enters the public
 * repo, only the generic builders here (templatePack, measureHtml, common).
 * Putting a pack into a folder is `style.pack.edit` — the Folder Settings
 * import, or the command API (`just style-pack-import`).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { StylePack } from '@narrative/shared'
import { checkPack, tryPack } from './common.js'
import type { BootstrapResult } from './templatePack.js'

/** One brand's builder: the sources' root in, its pack (and the files the pack names) out. */
export type BrandBuild = (sources: string) => StylePack | BootstrapResult | Promise<BootstrapResult>

const OVERLAY = resolve(import.meta.dirname, '../../../../../private')
const BRANDS_MODULE = join(OVERLAY, 'bootstrap/index.ts')

async function loadBrands(): Promise<{
  brands: Readonly<Record<string, BrandBuild>>
  defaultSources?: string
}> {
  if (!existsSync(BRANDS_MODULE)) {
    console.error(`no brands: ${BRANDS_MODULE} is missing (the private overlay, SETUP.md)`)
    process.exit(2)
  }
  return (await import(pathToFileURL(BRANDS_MODULE).href)) as {
    brands: Readonly<Record<string, BrandBuild>>
    defaultSources?: string
  }
}

async function main(): Promise<void> {
  const { brands: BRANDS, defaultSources } = await loadBrands()
  const [brand, sourcesArg, outArg] = process.argv.slice(2)
  const build = brand === undefined ? undefined : BRANDS[brand]
  if (build === undefined && brand !== 'all') {
    console.error(`usage: style-pack <${Object.keys(BRANDS).join('|')}|all> [sources] [out dir]`)
    process.exit(2)
  }
  const given = (v: string | undefined) => (v === undefined || v === '' ? undefined : v)
  const sourcesDir = given(sourcesArg) ?? defaultSources
  if (sourcesDir === undefined) {
    console.error('no sources: pass them, or set defaultSources in the overlay')
    process.exit(2)
  }
  const sources = resolve(sourcesDir)
  const out = resolve(given(outArg) ?? join(OVERLAY, 'packs'))
  mkdirSync(out, { recursive: true })

  let failed = false
  for (const [id, fn] of Object.entries(BRANDS)) {
    if (brand !== 'all' && id !== brand) continue
    const built = await fn(sources)
    const result: BootstrapResult = 'pack' in built ? built : { pack: built, files: {} }
    const checked = checkPack(result.pack)
    if ('issues' in checked) {
      failed = true
      console.error(`${id}: ${checked.issues.length} issues`)
      for (const i of checked.issues.slice(0, 40)) console.error(`  ${i}`)
      continue
    }
    const tried = tryPack(checked.pack)
    if (tried.failures.length > 0) {
      failed = true
      console.error(`${id}: ${tried.failures.length} layouts cannot be laid out`)
      for (const f of tried.failures) console.error(`  ${f}`)
      continue
    }
    // The pack's assets, under the private overlay as the pack names them.
    const overlay = resolve(out, '..')
    for (const [rel, bytes] of Object.entries(result.files)) {
      const target = join(overlay, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    }
    const json = JSON.stringify(checked.pack, null, 2)
    const file = join(out, `${checked.pack.id}.json`)
    writeFileSync(file, `${json}\n`)
    const p = checked.pack
    console.log(
      `${id}: ${p.layouts.length} layouts, ${p.layouts.reduce((n, l) => n + l.regions.length, 0)} regions, ` +
        `${Object.keys(p.textStyles).length} text styles, ${p.components.length} components, ` +
        `${(json.length / 1024).toFixed(1)} KB → ${file}`,
    )
    const counts = Object.entries(tried.findings)
      .map(([k, n]) => `${n}× ${k}`)
      .join(', ')
    if (counts !== '') console.log(`  checked, every layout empty: ${counts}`)
  }
  if (failed) process.exit(1)
}

void main()
