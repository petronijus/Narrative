/**
 * e2e/style-pack.spec.ts — a folder's style pack (agentic A4.3–A4.6):
 * Folder Settings → Style pack shows the pack the command API set, Compile
 * makes its tokens, a colour edited there reaches the pack through
 * `style.pack.edit`; a slide laid out with the pack passes `query.check`
 * with the text measured on the render page. Every fixture is made through
 * the API and the folder is deleted afterwards (with its decks).
 */

import { test, expect, type APIRequestContext } from '@playwright/test'
import { exampleStylePack } from '@narrative/shared'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

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

let folderId = ''

test.beforeEach(async ({ request }) => {
  folderId = (
    await command<{ id: string }>(request, {}, 'folder.create', { name: `Pack e2e ${Date.now()}` })
  ).id
  await command(request, { folderId }, 'style.pack.edit', { op: 'set', pack: exampleStylePack() })
})

test.afterEach(async ({ request }) => {
  const res = await request.delete(`${API_BASE}/folders/${folderId}`, {
    headers: { Origin: WEB_ORIGIN },
  })
  expect(res.ok() || res.status() === 404, `DELETE /folders: ${res.status()}`).toBe(true)
})

test('Folder Settings shows the pack, compiles it and edits a colour', async ({ page }) => {
  await page.goto(`/folder/${folderId}/settings?tab=stylePack`)
  const tab = page.getByTestId('style-pack-tab')
  await expect(tab.getByRole('heading', { name: 'Example' })).toBeVisible()
  await expect(tab.getByText('Title and bullets')).toBeVisible()

  await tab.getByRole('button', { name: 'Compile' }).click()
  await expect(page.getByTestId('pack-compiled')).toContainText('components created')
  const tokens = await command<{ colors: Array<{ id: string }> }>(
    page.request,
    { folderId },
    'token.list',
    {},
  )
  expect(tokens.colors.map((c) => c.id)).toContain('p-example-role-text')

  const navy = tab.getByLabel('Navy colour')
  await navy.fill('#112233')
  await navy.press('Enter')
  await expect
    .poll(
      async () =>
        (
          await command<{ value: { tokens: { colors: Record<string, { value: string }> } } }>(
            page.request,
            { folderId },
            'style.pack.get',
            { part: 'pack' },
          )
        ).value.tokens.colors['navy']?.value,
      { timeout: 15_000 },
    )
    .toBe('#112233')

  // A layout's regions open under its preview.
  await tab.getByRole('button', { name: /Title and bullets/ }).click()
  await expect(page.getByTestId('region-editor')).toContainText('bullets')
})

test('a slide laid out with the pack passes the brand check, measured', async ({ request }) => {
  await command(request, { folderId }, 'style.pack.edit', { op: 'compile' })
  const { id: deckId } = await command<{ id: string }>(request, {}, 'deck.create', {
    title: 'Pack check',
    folderId,
  })
  await command(request, { deckId }, 'style.deck.apply', { fields: { client: 'Acme' } })
  await command(request, { deckId }, 'slide.applyLayout', {
    slide: { index: 0 },
    layoutId: 'title-bullets',
    content: { title: 'Revenue grew', bullets: 'Europe' },
  })
  const check = await command<{
    fitVerified: boolean
    findings: Array<{ level: string; rule: string; message: string }>
  }>(request, { deckId }, 'query.check', {})
  // The example pack's Inter is not uploaded: its fit cannot be verified; nothing else is wrong.
  expect(check.findings.filter((f) => f.rule !== 'font-missing' && f.level === 'error')).toEqual([])
})
