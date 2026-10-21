/**
 * e2e/perf/lib/seed.ts — the scenes of the perf scenarios, seeded through the
 * dev backend's command API (POST /commands), never the dev-only test hooks:
 * the same seeding works for a dev page, a production preview and either side
 * of an A/B, and it is what an agent does (ops.apply, one transaction per
 * batch). The page receives the objects over the sync connection.
 *
 * Scenes are deterministic: positions and sizes from a fixed hash, words from
 * a fixed list, photos generated with a fixed seed.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { Op } from '@narrative/perf'
import { expect } from '../../fixtures/test'

export { photoFiles } from '@narrative/perf/node'
export {
  crowdedSlideOps,
  deckOps,
  lightSlideOps,
  rnd,
  tableSlideOps,
  TABLE_SCENE,
  type Box,
  type CrowdedScene,
  type Op,
} from '@narrative/perf'

export const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
/** The origin the API admits (CORS_ORIGIN); the command API checks it on writes. */
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** ops.apply takes at most 500 ops per call. */
const OPS_PER_BATCH = 400

export async function command<T>(
  api: APIRequestContext,
  deckId: string,
  name: string,
  input: unknown,
): Promise<T> {
  const res = await api.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target: { deckId }, command: name, input },
    timeout: 120_000,
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${name}: ${body.error?.message ?? res.status()}`).toBe(true)
  return body.result
}

/** Run ops in batches of one transaction each. */
export async function applyOps(
  api: APIRequestContext,
  deckId: string,
  ops: readonly Op[],
): Promise<void> {
  for (let i = 0; i < ops.length; i += OPS_PER_BATCH)
    await command(api, deckId, 'ops.apply', { ops: ops.slice(i, i + OPS_PER_BATCH) })
}

export async function createDeck(api: APIRequestContext, title: string): Promise<string> {
  const res = await api.post(`${API_BASE}/decks`, { data: { title } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  return ((await res.json()) as { id: string }).id
}

export async function uploadPhotos(
  api: APIRequestContext,
  deckId: string,
  files: readonly string[],
): Promise<string[]> {
  const ids: string[] = []
  for (const file of files) {
    const r = await command<{ assetId: string }>(api, deckId, 'media.upload', {
      file: { base64: readFileSync(file).toString('base64'), filename: path.basename(file) },
    })
    ids.push(r.assetId)
  }
  return ids
}
