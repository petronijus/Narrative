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

test('visual — editor in forced DARK theme', async ({ page }) => {
  test.setTimeout(60_000)
  // Force dark via the toggle's localStorage key before any page load.
  await page.addInitScript(() => {
    localStorage.setItem('narrative:theme', 'dark')
  })

  await createDeckAndOpen(page)
  await page.keyboard.press('r')
  const canvas = page.locator('.canvas-backdrop').first()
  await canvas.click({ position: { x: 400, y: 260 } })
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'test-results/p1-editor-dark.png', fullPage: true })
})

test('visual — editor with one rectangle', async ({ page }) => {
  test.setTimeout(60_000)

  await createDeckAndOpen(page)

  await page.keyboard.press('r')
  const canvas = page.locator('.canvas-backdrop').first()
  await canvas.click({ position: { x: 400, y: 260 } })

  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/p1-editor.png', fullPage: true })

  // Now click back on the rectangle so the Inspector shows Position /
  // Size / Transform / Appearance — the sections with NumberField and
  // color picker chrome the user actually inspects.
  await page.keyboard.press('v')
  await canvas.click({ position: { x: 400, y: 260 } })
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/p1-editor-selected.png', fullPage: true })
})
