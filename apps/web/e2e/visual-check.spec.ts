import { test, type Page } from '@playwright/test'

/**
 * P1 visual check — capture a screenshot of the editor with one rectangle
 * already on the slide so both sidebars + toolbar + inspector + animation
 * timeline + speaker notes panel all show populated chrome.
 *
 * Not an assertion — just a snapshot the human can look at.
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

test('visual — editor with one rectangle', async ({ page }) => {
  test.setTimeout(60_000)

  await createDeckAndOpen(page)

  // Create a rectangle via the toolbar.
  const rectBtn = page.getByRole('button', { name: /^Rectangle/i })
  await rectBtn.click()
  const canvas = page.locator('canvas').first()
  await canvas.click({ position: { x: 400, y: 260 } })

  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/p1-editor.png', fullPage: true })
})
