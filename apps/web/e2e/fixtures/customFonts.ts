/**
 * fixtures/customFonts.ts — a folder with the e2e test fonts uploaded the way
 * a person uploads them (`folder.fonts.upload`), and decks in it.
 *
 * The fonts (all generated, no licence attached — make-block-font.py,
 * make-metrics-fonts.py): the block font (every letter a solid block), the
 * tall font (unusual vertical metrics) and the variable font (a `wght` axis
 * that changes advances). Used by the text position gates
 * (text-edit-parity.spec.ts, text-export-parity.spec.ts).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { APIRequestContext } from '@playwright/test'
import { expect } from './test'
import type { CustomFontFamilies } from './textCorpus'

const API = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'
const HERE = dirname(fileURLToPath(import.meta.url))

export const FONT_FILES = {
  block: join(HERE, 'block-font.ttf'),
  tall: join(HERE, 'tall-font.ttf'),
  variable: join(HERE, 'var-font.ttf'),
} as const

async function command<T>(
  request: APIRequestContext,
  name: string,
  input: unknown,
  target: Record<string, string>,
): Promise<T> {
  const res = await request.post(`${API}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target, command: name, input },
    timeout: 120_000,
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${name}: ${body.error?.message ?? res.status()}`).toBe(true)
  return body.result
}

/** A new folder with the three test fonts; the families as the upload named them. */
export async function seedFontFolder(
  request: APIRequestContext,
  name: string,
): Promise<{ folderId: string; families: CustomFontFamilies }> {
  const folderId = (await command<{ id: string }>(request, 'folder.create', { name }, {})).id
  const upload = async (file: string): Promise<string> =>
    (
      await command<{ family: string }>(
        request,
        'folder.fonts.upload',
        {
          file: { base64: readFileSync(file).toString('base64'), filename: file.split('/').pop() },
        },
        { folderId },
      )
    ).family
  const families: CustomFontFamilies = {
    block: await upload(FONT_FILES.block),
    tall: await upload(FONT_FILES.tall),
    variable: await upload(FONT_FILES.variable),
  }
  return { folderId, families }
}

/** A deck in `folderId`. */
export async function createDeckInFolder(
  request: APIRequestContext,
  folderId: string,
  title: string,
): Promise<string> {
  const res = await request.post(`${API}/decks`, { data: { title, folderId } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  return ((await res.json()) as { id: string }).id
}
