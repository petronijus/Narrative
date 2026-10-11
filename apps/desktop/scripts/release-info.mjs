/**
 * scripts/release-info.mjs
 *
 * Bind the packages in release/ to the build they came from (security
 * review of D0, L6): after electron-builder, `just desktop-dist` writes
 * release/release-info.json — the build-info of the bundle that was packaged
 * (version, commit, clean tree, default servers.json) and the SHA-512 of
 * every artefact. `desktop-publish` signs only artefacts listed there with
 * that hash, so a package left from an older or dirty build is never signed.
 *
 *   node scripts/release-info.mjs write
 *   node scripts/release-info.mjs check <artefact>…
 */

import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = path.join(root, 'release')
const infoFile = path.join(release, 'release-info.json')

/** @param {string} file @returns {Promise<string>} */
function sha512(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

const [command, ...files] = process.argv.slice(2)

if (command === 'write') {
  const build = JSON.parse(readFileSync(path.join(root, 'dist/build-info.json'), 'utf8'))
  /** @type {Record<string, string>} */
  const artefacts = {}
  for (const name of readdirSync(release).sort()) {
    const full = path.join(release, name)
    const artefact = name.startsWith('narrative-') || /^latest.*\.yml$/.test(name)
    if (!artefact || !statSync(full).isFile()) continue
    if (/\.(manifest|sig)$/.test(name)) continue
    artefacts[name] = await sha512(full)
  }
  writeFileSync(infoFile, `${JSON.stringify({ build, artefacts }, null, 2)}\n`)
} else if (command === 'check') {
  const info = JSON.parse(readFileSync(infoFile, 'utf8'))
  for (const file of files) {
    const expected = info.artefacts[path.basename(file)]
    if (expected === undefined || expected !== (await sha512(file))) {
      console.error(`${path.basename(file)} is not a package of this build`)
      process.exit(1)
    }
  }
  console.log(JSON.stringify(info.build))
} else {
  console.error('usage: release-info.mjs write | check <artefact>…')
  process.exit(64)
}
