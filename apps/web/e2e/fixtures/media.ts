/**
 * e2e/fixtures/media.ts — a picture a spec can place: uploaded into the deck
 * through the command API (`media.upload`), as an agent would, so an image
 * object shows a real asset of its deck.
 */

import { expect, type APIRequestContext } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** A 1×1 red PNG. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

/** Upload a small PNG into `deckId`; returns its asset id. */
export async function uploadTestPicture(
  request: APIRequestContext,
  deckId: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: {
      target: { deckId },
      command: 'media.upload',
      input: { file: { base64: PNG_1PX, filename: 'e2e.png' } },
    },
  })
  const body = (await res.json()) as {
    ok: boolean
    result: { assetId: string }
    error?: { message: string }
  }
  expect(body.ok, `media.upload: ${body.error?.message}`).toBe(true)
  return body.result.assetId
}
