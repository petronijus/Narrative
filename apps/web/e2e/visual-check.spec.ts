import { test, type Page } from '@playwright/test'

/**
 * P1 visual check — captures the home page + the editor with one
 * rectangle so both screens' chrome is visible.
 */

async function createDeckAndOpen(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'P1 visual check' },
  })
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/deck/${id}`)
  await page.waitForTimeout(1200)
  return id
}

test('visual — home page (deck list)', async ({ page }) => {
  test.setTimeout(30_000)
  await page.goto('/')
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/p1-home.png', fullPage: true })
})

test('visual — editor with one rectangle', async ({ page }) => {
  test.setTimeout(60_000)

  await createDeckAndOpen(page)

  const rectBtn = page.getByRole('button', { name: /^Rectangle/i })
  await rectBtn.click()
  const canvas = page.locator('canvas').first()
  await canvas.click({ position: { x: 400, y: 260 } })

  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/p1-editor.png', fullPage: true })

  // Now click back on the rectangle so the Inspector shows Position /
  // Size / Transform / Appearance — the sections with NumberField and
  // color picker chrome the user actually inspects.
  const selectBtn = page.getByRole('button', { name: /^Select/i })
  await selectBtn.click()
  await canvas.click({ position: { x: 400, y: 260 } })
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/p1-editor-selected.png', fullPage: true })
})
