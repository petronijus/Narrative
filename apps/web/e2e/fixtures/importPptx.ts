/**
 * fixtures/importPptx.ts — a .pptx imported as a person imports it, for the
 * text position gates (text-edit-parity.spec.ts with TEXT_EDIT_PPTX,
 * text-import-parity.spec.ts).
 *
 * Small files go through `deck.importPptx` into the given folder; a file over
 * the command API's body limit (the real decks under tests/fixtures/pptx/,
 * ~50 MB) through the home page's "Import PowerPoint" dialog into Drafts, as
 * pptx-import-fidelity.spec.ts does — Playwright streams a file given by path.
 */

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { APIRequestContext, Browser } from '@playwright/test'
import { applyOps, command } from '../perf/lib/seed'
import { createDeckInFolder } from './customFonts'
import { expect } from './test'
import { customFontSlide, textCorpusOps, type CustomFontFamilies } from './textCorpus'

const API = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'
/** What the command API takes inline comfortably (its body limit is lower than base64 of 50 MB). */
const INLINE_LIMIT = 8 * 1024 * 1024

export async function importPptx(
  request: APIRequestContext,
  browser: Browser,
  folderId: string,
  file: string | Buffer,
  title: string,
): Promise<{ deckId: string; slideCount: number }> {
  const size = typeof file === 'string' ? statSync(file).size : file.length
  if (size <= INLINE_LIMIT) {
    const bytes = typeof file === 'string' ? readFileSync(file) : file
    const res = await request.post(`${API}/commands`, {
      headers: { Origin: WEB_ORIGIN },
      data: {
        target: { folderId },
        command: 'deck.importPptx',
        input: { file: { base64: bytes.toString('base64'), filename: `${title}.pptx` }, title },
      },
      timeout: 600_000,
    })
    const body = (await res.json()) as {
      ok: boolean
      result: { deckId: string; slideCount: number }
      error?: { message: string }
    }
    expect(body.ok, `deck.importPptx: ${body.error?.message ?? res.status()}`).toBe(true)
    return body.result
  }
  expect(typeof file, 'a large deck is imported from its path').toBe('string')
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  try {
    await page.goto('/')
    await expect(page.getByRole('button', { name: /Import PowerPoint/i })).toBeVisible({
      timeout: 15_000,
    })
    await page
      .locator('input[type="file"][accept*="pptx"]')
      .first()
      .setInputFiles(file as string)
    const dialog = page.getByRole('dialog', { name: /Import PowerPoint deck/i })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole('button', { name: /^Drafts/ }).click()
    await dialog.getByRole('button', { name: /^Import$/ }).click()
    const done = dialog.getByText(/Imported \d+ slides/i)
    await expect(done, `import of ${basename(file as string)}`).toBeVisible({ timeout: 600_000 })
    const slideCount = Number(/Imported (\d+) slides/.exec((await done.textContent()) ?? '')?.[1])
    const open = dialog.getByRole('button', { name: /^(Open deck|Skip & open deck)$/ })
    if (await open.isVisible().catch(() => false)) await open.click()
    await page.waitForURL(/\/deck\/[^/?#]+/, { timeout: 60_000 })
    const deckId = /\/deck\/([^/?#]+)/.exec(page.url())![1]!
    return { deckId, slideCount }
  } finally {
    await context.close()
  }
}

/** The text corpus with its custom-font slide, in a deck of `folderId`, exported with `deck.exportPptx`. */
export async function exportedCorpusPptx(
  request: APIRequestContext,
  folderId: string,
  families: CustomFontFamilies,
): Promise<Buffer> {
  const deckId = await createDeckInFolder(request, folderId, `text corpus export ${Date.now()}`)
  const { ops, slides } = textCorpusOps()
  const fonts = customFontSlide(slides.length, families)
  await applyOps(request, deckId, [...ops, { command: 'slide.add', input: {} }, ...fonts.ops])
  const out = await command<{ url: string }>(request, deckId, 'deck.exportPptx', {})
  const res = await request.get(out.url)
  expect(res.ok(), 'the exported .pptx downloads').toBe(true)
  return await res.body()
}
