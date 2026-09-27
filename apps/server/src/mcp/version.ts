/**
 * mcp/version.ts — the server version the MCP initialize result reports.
 *
 * Read from apps/server/package.json (the version invariant: git tag =
 * package version = image tag, CLAUDE.md). The file sits at a different
 * depth in the source tree (src/mcp/) and in the image
 * (dist/apps/server/src/mcp/), so walk up to the nearest package.json named
 * @narrative/server instead of hard-coding a relative path.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function readServerVersion(
  start: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = start
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === '@narrative/server' && typeof pkg.version === 'string') return pkg.version
    } catch {
      // no package.json here; keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) return '0.0.0'
    dir = parent
  }
}
