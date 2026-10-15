/**
 * E2E: folder font preview regression — M16 P3.
 *
 * Verifies that after a page refresh the font preview rows in FolderSettings
 * (Fonts tab) and FolderDecks (styleguide strip) render in the uploaded face,
 * not the system-ui fallback.
 *
 * Root cause guarded against: React 18 strict-mode double-invoke drops all
 * in-flight FontFace.load() calls because the cleanup sets `cancelled=true`
 * while leaving stale placeholder slots in `installedRef`. The second effect
 * invocation then skips every font (already-in-map), and the cancelled
 * async IIFEs bail before `document.fonts.add()`. Fix: cleanup deletes
 * pending (not-yet-fully-installed) slots so the next invocation retries.
 *
 * Arrange: a folder of the spec's own with one uploaded face (the codicon
 *   fixture, family "codicon", through `folder.fonts.upload`), deleted
 *   afterwards. It used to read a developer's Drafts folder by id — which
 *   exists on one machine only, and whose deck list other specs change while
 *   they run alongside this one.
 * Act: navigate to each page, wait for FontFace.load() to settle.
 * Assert: document.fonts has the uploaded face loaded, and
 *   [FolderFontLoader] emits no install failures.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext, type Page } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'
const FONT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codicon.ttf')

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

/** A new folder holding one uploaded font; returns its id and the face's family. */
async function folderWithFont(
  request: APIRequestContext,
): Promise<{ folderId: string; family: string }> {
  const { id: folderId } = await command<{ id: string }>(request, {}, 'folder.create', {
    name: `Font preview e2e ${Date.now()}`,
  })
  createdFolders.push(folderId)
  const { family } = await command<{ family: string }>(
    request,
    { folderId },
    'folder.fonts.upload',
    { file: { base64: readFileSync(FONT).toString('base64'), filename: 'codicon.ttf' } },
  )
  return { folderId, family }
}

/** Folders this file created, deleted after each test even when it failed halfway. */
const createdFolders: string[] = []

test.afterEach(async ({ request }) => {
  for (const folderId of createdFolders.splice(0)) {
    const res = await request.delete(`${API_BASE}/folders/${folderId}`)
    expect(res.ok() || res.status() === 404, `DELETE /folders/${folderId}`).toBe(true)
  }
})

/** Every face in document.fonts, with its load status. */
function installedFaces(page: Page): Promise<{ family: string; status: string }[]> {
  return page.evaluate(() =>
    [...document.fonts].map((f) => ({ family: f.family, status: f.status })),
  )
}

/**
 * Wait until `family` is loaded in the page. The regression left the face
 * out of document.fonts for good, so a poll that times out still catches it;
 * a fixed settle time would also fail a load that is merely slow.
 */
async function expectFaceLoaded(page: Page, family: string): Promise<void> {
  // Retried as a whole, so a time-out reports the faces of the last try.
  await expect(async () => {
    const faces = await installedFaces(page)
    expect(
      faces.some((f) => f.family === family && f.status === 'loaded'),
      `"${family}" never loaded; installed: ${JSON.stringify(faces)}`,
    ).toBe(true)
  }).toPass({ timeout: 15_000 })
}

test.describe('folder font preview', () => {
  test('FolderSettings Fonts tab — uploaded fonts install into document.fonts on refresh', async ({
    page,
  }) => {
    const { folderId, family } = await folderWithFont(page.request)
    const fontLoaderWarnings: string[] = []
    const failedRequests: string[] = []

    page.on('console', (msg) => {
      if (msg.text().includes('[FolderFontLoader] failed to install')) {
        fontLoaderWarnings.push(msg.text())
      }
    })
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? '?'}`)
    })
    page.on('response', (r) => {
      if (r.status() >= 400) {
        failedRequests.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`)
      }
    })

    await page.goto(`/folder/${folderId}/settings`)

    // Click the Fonts tab (default tab is Colors)
    const fontsTab = page.getByRole('tab', { name: /fonts/i })
    await fontsTab.waitFor({ state: 'visible', timeout: 10_000 })
    await fontsTab.click()

    await expectFaceLoaded(page, family)

    expect(
      fontLoaderWarnings,
      `[FolderFontLoader] reported failures: ${fontLoaderWarnings.join(' | ')}`,
    ).toHaveLength(0)
    expect(failedRequests, `Network failures: ${failedRequests.join(' | ')}`).toHaveLength(0)
  })

  test('FolderDecks styleguide strip — uploaded fonts install into document.fonts on refresh', async ({
    page,
  }) => {
    const { folderId, family } = await folderWithFont(page.request)
    const fontLoaderWarnings: string[] = []
    const failedRequests: string[] = []

    page.on('console', (msg) => {
      if (msg.text().includes('[FolderFontLoader] failed to install')) {
        fontLoaderWarnings.push(msg.text())
      }
    })
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? '?'}`)
    })

    await page.goto(`/folder/${folderId}`)

    await expectFaceLoaded(page, family)

    expect(
      fontLoaderWarnings,
      `[FolderFontLoader] reported failures: ${fontLoaderWarnings.join(' | ')}`,
    ).toHaveLength(0)
    expect(failedRequests, `Network failures: ${failedRequests.join(' | ')}`).toHaveLength(0)
  })
})
