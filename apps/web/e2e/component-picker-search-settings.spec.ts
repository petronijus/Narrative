/**
 * E2E: ComponentPickerDrawer — search field + settings navigation.
 *
 * Verifies:
 *   1. Drawer opens with "Components" title, Settings icon, Close X.
 *   2. Search input is visible with placeholder "Search components".
 *   3. Typing in the search field filters rows live (case-insensitive substring).
 *   4. Clearing the search restores all rows.
 *   5. A query that matches nothing shows the "No components match" state.
 *   6. Clicking the Settings icon closes the drawer and navigates to
 *      /folder/<folderId>/settings?tab=components.
 *
 * The spec seeds its own folder with a deck and two components, "new
 * component" and "sdfsdfsdf" (POST /folders/:id/components makes an empty
 * master), and deletes the folder afterwards — it depends on nothing in the
 * developer's database.
 */

import { test, expect } from '@playwright/test'

const API = 'http://localhost:3001'
let folderId: string
let deckId: string

test.describe('ComponentPickerDrawer — search + settings', () => {
  test.beforeAll(async ({ request }) => {
    const folder = await request.post(`${API}/folders`, {
      data: { name: `E2E picker ${Date.now()}` },
    })
    expect(folder.ok(), `POST /folders: ${folder.status()}`).toBe(true)
    folderId = ((await folder.json()) as { id: string }).id
    for (const name of ['new component', 'sdfsdfsdf']) {
      const res = await request.post(`${API}/folders/${folderId}/components`, { data: { name } })
      expect(res.status(), `POST components ${name}`).toBe(201)
    }
    const res = await request.post(`${API}/decks`, {
      data: { title: 'Picker drawer test deck', folderId },
    })
    expect([200, 201]).toContain(res.status())
    deckId = ((await res.json()) as { id: string }).id
  })

  test.afterAll(async ({ request }) => {
    // Takes the deck and the components with it.
    await request.delete(`${API}/folders/${folderId}`).catch(() => {})
  })

  test('drawer header renders title, settings icon, close button, and search input', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto(`/deck/${deckId}`)
    // Wait for the editor toolbar to mount.
    await expect(page.getByRole('button', { name: 'Add component' })).toBeVisible({
      timeout: 15_000,
    })

    // Take a screenshot before opening for baseline reference.
    await page.screenshot({
      path: 'test-results/picker-drawer-before-open.png',
      fullPage: false,
    })

    // Open the picker.
    await page.getByRole('button', { name: 'Add component' }).click()

    // Drawer itself.
    const drawer = page.getByTestId('component-picker-drawer')
    await expect(drawer).toBeVisible({ timeout: 5_000 })

    // Title (the h2 heading specifically, not any row text containing the word).
    await expect(drawer.getByRole('heading', { name: 'Components', exact: true })).toBeVisible()

    // Settings icon button.
    await expect(page.getByTestId('component-picker-open-settings')).toBeVisible()

    // Close button (X).
    await expect(drawer.getByRole('button', { name: 'Close component picker' })).toBeVisible()

    // Search input.
    const searchInput = page.getByTestId('component-picker-search')
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toHaveAttribute('placeholder', 'Search components')

    // Capture the drawer with all elements visible.
    await page.screenshot({
      path: 'test-results/picker-drawer-header.png',
      fullPage: false,
    })

    expect(errors).toHaveLength(0)
  })

  test('search field filters rows live, clearing restores all rows', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto(`/deck/${deckId}`)
    await expect(page.getByRole('button', { name: 'Add component' })).toBeVisible({
      timeout: 15_000,
    })
    await page.getByRole('button', { name: 'Add component' }).click()

    const drawer = page.getByTestId('component-picker-drawer')
    await expect(drawer).toBeVisible({ timeout: 5_000 })

    // Wait for both components to appear (loading should settle).
    await expect(page.getByText('new component')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('sdfsdfsdf')).toBeVisible({ timeout: 8_000 })

    const searchInput = page.getByTestId('component-picker-search')

    // Type "new" — should keep "new component", hide "sdfsdfsdf".
    await searchInput.fill('new')
    await expect(page.getByText('new component')).toBeVisible()
    await expect(page.getByText('sdfsdfsdf')).not.toBeVisible()

    // Case-insensitive: "NEW" should also match "new component".
    await searchInput.fill('NEW')
    await expect(page.getByText('new component')).toBeVisible()
    await expect(page.getByText('sdfsdfsdf')).not.toBeVisible()

    // Partial match "comp" still matches "new component".
    await searchInput.fill('comp')
    await expect(page.getByText('new component')).toBeVisible()

    // Clear — all rows return.
    await searchInput.fill('')
    await expect(page.getByText('new component')).toBeVisible()
    await expect(page.getByText('sdfsdfsdf')).toBeVisible()

    await page.screenshot({
      path: 'test-results/picker-drawer-search-clear.png',
      fullPage: false,
    })

    expect(errors).toHaveLength(0)
  })

  test('"No components match" state appears when no rows match the query', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto(`/deck/${deckId}`)
    await expect(page.getByRole('button', { name: 'Add component' })).toBeVisible({
      timeout: 15_000,
    })
    await page.getByRole('button', { name: 'Add component' }).click()

    const drawer = page.getByTestId('component-picker-drawer')
    await expect(drawer).toBeVisible({ timeout: 5_000 })

    // Wait for components to load.
    await expect(page.getByText('new component')).toBeVisible({ timeout: 8_000 })

    const searchInput = page.getByTestId('component-picker-search')
    // Type a string that certainly won't match either component name.
    await searchInput.fill('zzz_no_match_zzz')

    // "No components match" copy should appear.
    await expect(page.getByText(/No components match/i)).toBeVisible({ timeout: 3_000 })

    await page.screenshot({
      path: 'test-results/picker-drawer-no-matches.png',
      fullPage: false,
    })

    expect(errors).toHaveLength(0)
  })

  test('Settings icon closes drawer and navigates to folder settings components tab', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto(`/deck/${deckId}`)
    await expect(page.getByRole('button', { name: 'Add component' })).toBeVisible({
      timeout: 15_000,
    })
    await page.getByRole('button', { name: 'Add component' }).click()

    const drawer = page.getByTestId('component-picker-drawer')
    await expect(drawer).toBeVisible({ timeout: 5_000 })

    // Click Settings.
    await page.getByTestId('component-picker-open-settings').click()

    // Drawer should be gone.
    await expect(drawer).not.toBeVisible({ timeout: 3_000 })

    // URL should point to folder settings with tab=components.
    await expect(page).toHaveURL(new RegExp(`/folder/${folderId}/settings\\?tab=components`), {
      timeout: 5_000,
    })

    // The Components tab on the settings page should be active / visible.
    await expect(page.getByRole('tab', { name: 'Components' })).toBeVisible({ timeout: 8_000 })

    await page.screenshot({
      path: 'test-results/picker-drawer-settings-nav.png',
      fullPage: false,
    })

    expect(errors).toHaveLength(0)
  })
})
