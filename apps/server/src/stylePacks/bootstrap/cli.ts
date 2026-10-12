/**
 * stylePacks/bootstrap/cli.ts — `just style-pack <brand> [brain repo] [out dir]`
 * (agentic A4.7): build a brand's style pack from its sources in the
 * woodgrove-ai-brain checkout, check it whole and write it as JSON into the
 * private overlay (`private/packs/<id>.json`; client IP never enters the
 * public repo). Putting a pack into a folder is `style.pack.edit` — the
 * Folder Settings import, or the command API — at Petr's go per brand.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { StylePack } from '@narrative/shared'
import { checkPack, tryPack } from './common.js'
import type { BootstrapResult } from './templatePack.js'
import { buildContosoPack } from './vw.js'
import { buildFabrikamPack } from './fabrikam.js'
import { buildTailspinPack } from './tailspin.js'
import { buildWoodgrovePack, buildAdatumPack } from './woodgrove.js'

type Build = (brain: string) => StylePack | BootstrapResult | Promise<BootstrapResult>

const BRANDS: Readonly<Record<string, Build>> = {
  vw: buildContosoPack,
  fabrikam: buildFabrikamPack,
  tailspin: buildTailspinPack,
  woodgrove: buildWoodgrovePack,
  adatum: buildAdatumPack,
}

async function main(): Promise<void> {
  const [brand, brainArg, outArg] = process.argv.slice(2)
  const build = brand === undefined ? undefined : BRANDS[brand]
  if (build === undefined && brand !== 'all') {
    console.error(`usage: style-pack <${Object.keys(BRANDS).join('|')}|all> [brain repo] [out dir]`)
    process.exit(2)
  }
  const given = (v: string | undefined) => (v === undefined || v === '' ? undefined : v)
  const brain = resolve(
    given(brainArg) ?? join(homedir(), 'Documents/Dev/Woodgrove/internal/woodgrove-ai-brain'),
  )
  const out = resolve(given(outArg) ?? join(import.meta.dirname, '../../../../../private/packs'))
  mkdirSync(out, { recursive: true })

  let failed = false
  for (const [id, fn] of Object.entries(BRANDS)) {
    if (brand !== 'all' && id !== brand) continue
    const built = await fn(brain)
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
