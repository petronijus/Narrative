/**
 * e2e/agent-upload-session.spec.ts
 *
 * `media.uploadSession` end to end against the running stack (agentic
 * A2.7a): the command's ready `curl` line is run as an agent with a shell
 * would run it — in the directory that holds the file — and its JSON answer
 * names an asset of this deck that an image object can show. The one-time
 * token is spent by that upload: running the same line again fails.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** A 2×2 red PNG. */
const PNG_2PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANCQED0pRKZAAAAABJRU5ErkJggg=='

async function command<T>(
  request: APIRequestContext,
  target: Record<string, string>,
  commandId: string,
  input: unknown,
): Promise<T> {
  const res = await request.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target, command: commandId, input },
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${commandId}: ${body.error?.message}`).toBe(true)
  return body.result
}

function runShell(line: string, cwd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('bash', ['-c', line], { cwd, encoding: 'utf8' }) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('an agent uploads a local picture with the session curl line, once', async ({ request }) => {
  const png = Buffer.from(PNG_2PX, 'base64')
  const { id: deckId } = await command<{ id: string }>(request, {}, 'deck.create', {
    title: `upload session ${Date.now()}`,
  })
  const session = await command<{ curl: string; kind: string }>(
    request,
    { deckId },
    'media.uploadSession',
    { filename: 'logo.png', sizeBytes: png.length },
  )
  expect(session.kind).toBe('image')

  const dir = mkdtempSync(join(tmpdir(), 'narrative-upload-'))
  writeFileSync(join(dir, 'logo.png'), png)

  const first = runShell(session.curl, dir)
  expect(first.ok, first.out).toBe(true)
  const uploaded = JSON.parse(first.out) as { assetId: string; width: number; height: number }
  expect(uploaded).toMatchObject({ width: 2, height: 2 })

  // An asset of this deck: it serves, and an image object can show it.
  const media = await command<{ url: string }>(request, { deckId }, 'media.url', {
    assetId: uploaded.assetId,
  })
  expect(media.url).toBeTruthy()
  await command(request, { deckId }, 'object.create', {
    slide: { index: 0 },
    object: { type: 'image', assetId: uploaded.assetId, width: 200, height: 200 },
  })

  // The token was for one upload.
  const again = runShell(session.curl, dir)
  expect(again.ok).toBe(false)
  expect(again.out).toMatch(/already used|expired|Forbidden/)
})
