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
 * Arrange: folder with known font rows (SF Pro Display, Google Sans,
 *   Playwrite NO) already uploaded to MinIO.
 * Act: navigate to each page, wait for FontFace.load() to settle.
 * Assert: document.fonts contains at least one face beyond Inter (the
 *   app's own web font), and [FolderFontLoader] emits no install failures.
 */

import { test, expect } from '@playwright/test'

const FOLDER_ID = 'drafts-958e2b33e6952467a1fbe3c71fc802e6'
const SETTINGS_URL = `/folder/${FOLDER_ID}/settings`
const DECKS_URL = `/folder/${FOLDER_ID}`

// How long to wait for FontFace.load() promises to settle after page load.
const FONT_SETTLE_MS = 3000

test.describe('folder font preview', () => {
  test('FolderSettings Fonts tab — uploaded fonts install into document.fonts on refresh', async ({
    page,
  }) => {
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

    await page.goto(SETTINGS_URL)

    // Click the Fonts tab (default tab is Colors)
    const fontsTab = page.getByRole('tab', { name: /fonts/i })
    await fontsTab.waitFor({ state: 'visible', timeout: 10_000 })
    await fontsTab.click()

    // Wait for FontFace.load() promises to settle
    await page.waitForTimeout(FONT_SETTLE_MS)

    const installedFaces = await page.evaluate(
      async (): Promise<{ family: string; status: string }[]> => {
        await document.fonts.ready
        const faces: { family: string; status: string }[] = []
        for (const face of document.fonts) {
          faces.push({ family: face.family, status: face.status })
        }
        return faces
      },
    )

    // No install failures
    expect(
      fontLoaderWarnings,
      `[FolderFontLoader] reported failures: ${fontLoaderWarnings.join(' | ')}`,
    ).toHaveLength(0)

    // No network errors
    expect(failedRequests, `Network failures: ${failedRequests.join(' | ')}`).toHaveLength(0)

    // At least one custom (non-Inter) font face must be fully loaded.
    // The test fixture has SF Pro Display, Google Sans, and Playwrite NO.
    const customFaces = installedFaces.filter(
      (f) => !f.family.toLowerCase().includes('inter') && f.status === 'loaded',
    )
    expect(
      customFaces,
      `No custom font faces loaded. Installed faces: ${JSON.stringify(installedFaces)}`,
    ).not.toHaveLength(0)
  })

  test('FolderDecks styleguide strip — uploaded fonts install into document.fonts on refresh', async ({
    page,
  }) => {
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

    await page.goto(DECKS_URL)
    await page.waitForTimeout(FONT_SETTLE_MS)

    const installedFaces = await page.evaluate(
      async (): Promise<{ family: string; status: string }[]> => {
        await document.fonts.ready
        const faces: { family: string; status: string }[] = []
        for (const face of document.fonts) {
          faces.push({ family: face.family, status: face.status })
        }
        return faces
      },
    )

    expect(
      fontLoaderWarnings,
      `[FolderFontLoader] reported failures: ${fontLoaderWarnings.join(' | ')}`,
    ).toHaveLength(0)

    expect(failedRequests, `Network failures: ${failedRequests.join(' | ')}`).toHaveLength(0)

    const customFaces = installedFaces.filter(
      (f) => !f.family.toLowerCase().includes('inter') && f.status === 'loaded',
    )
    expect(
      customFaces,
      `No custom font faces loaded on decks page. Installed faces: ${JSON.stringify(installedFaces)}`,
    ).not.toHaveLength(0)
  })
})
