/**
 * The committed manifest files and their expected content. Shared by the
 * generator script and the freshness test so both agree byte for byte.
 *
 * The content is run through Prettier with the repo's own config: the
 * pre-commit hook formats every staged .json/.md file, so an unformatted
 * generator output would be rewritten on commit and the freshness test
 * would then fail on the committed tree.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'
import { createDefaultRegistry } from '../src/catalog.js'
import { buildManifest, renderManifestMarkdown } from '../src/manifest.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '../..')

export interface CapabilityFile {
  path: string
  content: string
}

async function formatted(filePath: string, raw: string): Promise<string> {
  const config = (await prettier.resolveConfig(filePath)) ?? {}
  return prettier.format(raw, { ...config, filepath: filePath })
}

export async function capabilityFiles(): Promise<CapabilityFile[]> {
  const manifest = buildManifest(createDefaultRegistry())
  const jsonPath = path.join(packageRoot, 'capabilities.json')
  const mdPath = path.join(repoRoot, 'docs', 'capabilities.md')
  return [
    { path: jsonPath, content: await formatted(jsonPath, JSON.stringify(manifest, null, 2)) },
    { path: mdPath, content: await formatted(mdPath, renderManifestMarkdown(manifest)) },
  ]
}
