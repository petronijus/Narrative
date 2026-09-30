/**
 * e2e/agent-activity.spec.ts
 *
 * Agentic A1, the web side: what a person sees while an agent works on
 * their deck through the command API (the same ServerHost MCP uses).
 *
 *   1. Agent activity popover: an agent edit shows up as a run and as a
 *      "Claude"/script peer; Revert (with its confirm step) undoes the
 *      edit in the live document and the run turns Reverted.
 *   2. `editor.show` through the server: the agent points the editor at
 *      another slide and an object — the editor switches, selects it and
 *      flashes it; the slide the editor publishes in awareness is what
 *      `editor.context` reports.
 *   3. `editor.show` handling in the editor, fed through the DEV
 *      `narrative:test-stateless` hook (the same parse → bus path the socket
 *      uses): slide-only shows, and a show parked while the user types.
 *   4. Present mode `?slide=N` starts at slide N (clamped past the end).
 *
 * The agent is played by `page.request.post(<api>/commands)`: in dev
 * (BYPASS_AUTH) that is the same user as the page, which is what
 * `editor.show` / `editor.context` need — they address the caller's own
 * open editors.
 */

import { test, expect, type Page } from '@playwright/test'

const API = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

interface CommandResponse<T> {
  ok: boolean
  result?: T
  runId: string | null
  error?: { code: string; message: string }
}

async function command<T>(
  page: Page,
  deckId: string,
  name: string,
  input: unknown,
): Promise<CommandResponse<T>> {
  return commandOn<T>(page, { deckId }, name, input)
}

/** Run a command on any target: a deck, or a component master. */
async function commandOn<T>(
  page: Page,
  target: { deckId: string } | { componentId: string },
  name: string,
  input: unknown,
): Promise<CommandResponse<T>> {
  const res = await page.request.post(`${API}/commands`, {
    data: { target, command: name, input, client: 'e2e-agent' },
  })
  return (await res.json()) as CommandResponse<T>
}

/**
 * Run a command until it succeeds. The page's local writes (test API seeds)
 * reach the server document asynchronously, so the first agent command
 * naming a freshly seeded object can legitimately answer `not_found`.
 */
async function commandWhenSynced<T>(
  page: Page,
  deckId: string,
  name: string,
  input: unknown,
): Promise<CommandResponse<T>> {
  let last: CommandResponse<T> | null = null
  await expect
    .poll(
      async () => {
        last = await command<T>(page, deckId, name, input)
        return last.ok ? 'ok' : `${last.error?.code}: ${last.error?.message}`
      },
      { timeout: 15_000 },
    )
    .toBe('ok')
  return last!
}

async function openNewDeck(
  page: Page,
  title: string,
): Promise<{ deckId: string; slideId: string }> {
  const res = await page.request.post(`${API}/decks`, { data: { title } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }
  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api?.listSlideIds()[0] ?? null), {
      timeout: 30_000,
    })
    .not.toBeNull()
  const slideId = await page.evaluate(() => window.__narrative_test_api!.listSlideIds()[0]!)
  // The canvas is up (Pixi initialised) before the spec starts acting.
  await expect
    .poll(() => page.evaluate(() => window.__narrative_scene_graph !== undefined), {
      timeout: 30_000,
    })
    .toBe(true)
  return { deckId, slideId }
}

/**
 * Precondition: the RENDERED editor lists this slide. The test API writes to
 * the live Y.Doc; if the slides panel never shows the slide, the spec is
 * talking to a different document than the one on screen (a harness race),
 * which must not be reported as a feature failure further down.
 */
async function expectRenderedSlide(page: Page, slideId: string): Promise<void> {
  await expect(
    page.locator(`[role="option"][data-slide-id="${slideId}"]`),
    `the slides panel never listed seeded slide ${slideId}`,
  ).toHaveCount(1, { timeout: 15_000 })
}

/** Seed a rectangle through the dev test API, retrying across the StrictMode doc swap. */
async function seedRect(page: Page, id: string, slideId: string, x: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ id, slideId, x }) => {
            const api = window.__narrative_test_api
            if (api === undefined) return false
            if (!api.objectIds(slideId).includes(id)) {
              api.addRect({ id, x, y: 200, w: 300, h: 200, fill: 0x3b82f6 }, slideId)
            }
            return api.objectIds(slideId).includes(id)
          },
          { id, slideId, x },
        ),
      { timeout: 15_000 },
    )
    .toBe(true)
}

function objectX(page: Page, id: string, slideId: string): Promise<number | null> {
  return page.evaluate(
    ({ id, slideId }) => {
      const obj = window.__narrative_test_api?.getObject(id, slideId)
      return typeof obj?.['x'] === 'number' ? obj['x'] : null
    },
    { id, slideId },
  )
}

test.describe('agent activity (agentic A1)', () => {
  test('popover lists an agent run and Revert undoes it', async ({ page }) => {
    test.setTimeout(90_000)
    const { deckId, slideId } = await openNewDeck(page, 'e2e agent activity')
    await seedRect(page, 'agent-rect', slideId, 200)

    // The agent moves the rectangle.
    const update = await commandWhenSynced<{ updated: string[] }>(page, deckId, 'object.update', {
      slide: slideId,
      object: 'agent-rect',
      patch: { x: 900 },
    })
    const runId = update.runId
    expect(runId, 'an agent write opens a run').not.toBeNull()
    await expect.poll(() => objectX(page, 'agent-rect', slideId), { timeout: 10_000 }).toBe(900)

    // The agent is a peer: a bot chip that says whom it works for, and the
    // toolbar button signals that an agent is working.
    await expect(page.locator(`[data-agent-peer="${runId}"]`)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(`[data-agent-peer="${runId}"] [aria-label]`)).toHaveAttribute(
      'aria-label',
      /working for you$/,
    )
    const button = page.getByRole('button', { name: /^Agent activity/ })
    await expect(button).toHaveAttribute('data-agent-working', 'true')

    // The run is listed.
    await button.click()
    const row = page.locator(`li[data-run-id="${runId}"]`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toHaveAttribute('data-run-status', 'open')
    await expect(row).toContainText('Automatic run')
    await expect(row).toContainText('e2e-agent (API)')
    await expect(row).toContainText('1 change')

    // Revert asks first; Escape backs out of the confirm step only.
    await row.getByRole('button', { name: 'Revert: Automatic run' }).click()
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(row.getByRole('button', { name: 'Confirm revert' })).toHaveCount(0)
    await expect(row).toBeVisible()
    expect(await objectX(page, 'agent-rect', slideId)).toBe(900)

    await row.getByRole('button', { name: 'Revert: Automatic run' }).click()
    await row.getByRole('button', { name: 'Confirm revert' }).click()

    // The document is back where the person left it, and the run says so.
    await expect.poll(() => objectX(page, 'agent-rect', slideId), { timeout: 10_000 }).toBe(200)
    await expect(row).toHaveAttribute('data-run-status', 'reverted', { timeout: 10_000 })
    await expect(row).toContainText('Reverted by you')
    await expect(row.getByRole('button', { name: /^Revert/ })).toHaveCount(0)

    // A second revert is refused by the server; the list no longer offers it,
    // so check the contract through the API the button uses.
    const again = await page.request.post(`${API}/agent-runs/${runId}/revert`, { data: {} })
    expect(again.status()).toBe(409)
  })

  test('component master editor: the popover lists an agent run and Revert undoes it', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const folderRes = await page.request.post(`${API}/folders`, {
      data: { name: 'e2e agent master' },
    })
    expect(folderRes.ok(), `folder creation failed: ${folderRes.status()}`).toBe(true)
    const { id: folderId } = (await folderRes.json()) as { id: string }
    const componentRes = await page.request.post(`${API}/folders/${folderId}/components`, {
      data: { name: 'e2e agent master' },
    })
    expect(componentRes.status(), 'component creation failed').toBe(201)
    const { id: componentId } = (await componentRes.json()) as { id: string }
    const target = { componentId }
    await page.goto(`/folder/${folderId}/component/${componentId}`)

    // The server writes a new component's one master slide. The agent sets
    // the master up in one run (a label), then — in a second run, the one
    // under test — adds a rectangle.
    const outline = await commandOn<{ slides: Array<{ id: string }> }>(
      page,
      target,
      'query.deck',
      {},
    )
    const slideId = outline.result?.slides[0]?.id
    expect(slideId, 'the master has its slide').toBeDefined()
    const setup = await commandOn<{ runId: string }>(page, target, 'agent.startRun', {
      request: 'Set up the master',
    })
    expect(setup.ok, setup.error?.message).toBe(true)
    const label = await commandOn<{ objectId: string }>(page, target, 'object.create', {
      slide: slideId,
      object: { type: 'text', x: 100, y: 20, width: 400, height: 60, text: 'Master label' },
    })
    expect(label.ok, label.error?.message).toBe(true)

    const started = await commandOn<{ runId: string }>(page, target, 'agent.startRun', {
      request: 'Add a blue box to the master',
    })
    expect(started.ok, started.error?.message).toBe(true)
    const runId = started.result!.runId
    const created = await commandOn<{ objectId: string }>(page, target, 'object.create', {
      slide: slideId,
      object: { type: 'rectangle', x: 100, y: 100, width: 200, height: 120, fill: '#3b82f6' },
    })
    expect(created.ok, created.error?.message).toBe(true)
    expect(created.runId, 'the write joins the run just started').toBe(runId)
    const objectId = created.result!.objectId

    // The master editor has the popover too, and lists both runs.
    const button = page.getByRole('button', { name: /^Agent activity/ })
    await button.click()
    await expect(page.getByText('Changes AI agents made to this component master.')).toBeVisible()
    const row = page.locator(`li[data-run-id="${runId}"]`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toContainText('Add a blue box to the master')
    await expect(row).toContainText('1 change')
    const setupRow = page.locator(`li[data-run-id="${setup.result!.runId}"]`)
    await expect(setupRow).toBeVisible()

    await row.getByRole('button', { name: 'Revert: Add a blue box to the master' }).click()
    await row.getByRole('button', { name: 'Confirm revert' }).click()
    await expect(row).toHaveAttribute('data-run-status', 'reverted', { timeout: 10_000 })

    // The rectangle is gone from the master; the setup run (its label) stays.
    const after = await commandOn(page, target, 'query.object', {
      slide: slideId,
      object: objectId,
    })
    expect(after.ok).toBe(false)
    expect(after.error?.code).toBe('not_found')
    const still = await commandOn<{ slideCount: number }>(page, target, 'query.deck', {})
    expect(still.result?.slideCount).toBe(1)
    const kept = await commandOn(page, target, 'query.object', {
      slide: slideId,
      object: label.result!.objectId,
    })
    expect(kept.ok, 'the setup run is untouched').toBe(true)
    await expect(setupRow).not.toHaveAttribute('data-run-status', 'reverted')
  })

  test('editor.show switches slide, selects and flashes the object', async ({ page }) => {
    test.setTimeout(90_000)
    const { deckId, slideId: firstSlideId } = await openNewDeck(page, 'e2e editor.show')
    const secondSlideId = await page.evaluate(() => window.__narrative_test_api!.addSlide())
    await seedRect(page, 'show-rect', secondSlideId, 400)
    await expectRenderedSlide(page, secondSlideId)

    // The server must find this tab as one of the caller's open editors;
    // `delivered: 0` means it matched no connection of the user at all.
    const probe = await commandWhenSynced<{ delivered: number }>(page, deckId, 'editor.show', {
      slide: firstSlideId,
    })
    expect(
      probe.result?.delivered,
      "editor.show reached none of the caller's editor connections (server-side connection lookup)",
    ).toBeGreaterThanOrEqual(1)

    // The editor publishes the slide it shows: editor.context sees slide 1.
    await expect
      .poll(
        async () =>
          (await command<{ activeSlideId: string | null }>(page, deckId, 'editor.context', {}))
            .result?.activeSlideId ?? null,
        { timeout: 15_000 },
      )
      .toBe(firstSlideId)

    const shown = await commandWhenSynced<{ delivered: number }>(page, deckId, 'editor.show', {
      slide: secondSlideId,
      objects: ['show-rect'],
    })
    expect(shown.result?.delivered).toBeGreaterThanOrEqual(1)

    // Switched to slide 2 …
    await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveAttribute(
      'data-slide-id',
      secondSlideId,
      { timeout: 10_000 },
    )
    // … selected the object …
    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.getSelection()), {
        timeout: 10_000,
      })
      .toEqual(['show-rect'])
    // … and flashed it (the outline goes away on its own).
    const highlight = page.getByTestId('editor-show-highlight')
    await expect(highlight).toHaveAttribute('data-object-ids', 'show-rect')
    await expect(highlight).toHaveCount(0, { timeout: 5_000 })

    // The switch is published too: editor.context now reports slide 2 and
    // the selection.
    await expect
      .poll(
        async () => {
          const ctx = await command<{ activeSlideId: string | null; selectedObjectIds: string[] }>(
            page,
            deckId,
            'editor.context',
            {},
          )
          return { slide: ctx.result?.activeSlideId, selected: ctx.result?.selectedObjectIds }
        },
        { timeout: 10_000 },
      )
      .toEqual({ slide: secondSlideId, selected: ['show-rect'] })
  })

  test('editor.show handling: slide-only shows, and a show parked while typing', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const { slideId: firstSlideId } = await openNewDeck(page, 'e2e editor.show client')
    await page.evaluate(
      (slideId) =>
        window.__narrative_test_api!.addText(
          { id: 'edit-text', x: 200, y: 200, w: 600, h: 200, text: 'Typing here' },
          slideId,
        ),
      firstSlideId,
    )
    const secondSlideId = await page.evaluate(() => window.__narrative_test_api!.addSlide())
    await seedRect(page, 'show-rect', secondSlideId, 400)
    await expectRenderedSlide(page, secondSlideId)

    const show = (slideId: string, objectIds: string[]): Promise<void> =>
      page.evaluate(
        ({ slideId, objectIds }) => {
          window.dispatchEvent(
            new CustomEvent('narrative:test-stateless', {
              detail: {
                payload: JSON.stringify({ type: 'narrative.editor.show', slideId, objectIds }),
              },
            }),
          )
        },
        { slideId, objectIds },
      )
    const activeSlide = page.locator('[role="option"][aria-selected="true"]')
    const selection = (): Promise<string[]> =>
      page.evaluate(() => window.__narrative_test_api!.getSelection())

    // Show an object on slide 2: switch, select, flash.
    await show(secondSlideId, ['show-rect'])
    await expect(activeSlide).toHaveAttribute('data-slide-id', secondSlideId, { timeout: 10_000 })
    await expect.poll(selection, { timeout: 10_000 }).toEqual(['show-rect'])
    await expect(page.getByTestId('editor-show-highlight')).toHaveAttribute(
      'data-object-ids',
      'show-rect',
    )

    // A slide-only show switches and leaves nothing selected; an unknown
    // slide is ignored.
    await show(firstSlideId, [])
    await expect(activeSlide).toHaveAttribute('data-slide-id', firstSlideId, { timeout: 10_000 })
    await expect.poll(selection).toEqual([])
    await show('no-such-slide', [])
    await page.waitForTimeout(300)
    await expect(activeSlide).toHaveAttribute('data-slide-id', firstSlideId)

    // While the user types, nothing moves: the show is parked in a notice.
    await page.evaluate(() => window.__narrative_test_api!.beginTextEdit('edit-text'))
    // The inline text editor on the canvas (not the slide-notes editor).
    const editable = page.locator('[data-shortcut-scope="canvas"] [contenteditable="true"]')
    await expect(editable).toBeVisible({ timeout: 10_000 })
    await show(secondSlideId, ['show-rect'])
    const notice = page.getByRole('status').filter({ hasText: 'wants to show you slide 2' })
    await expect(notice).toBeVisible({ timeout: 10_000 })
    await expect(activeSlide).toHaveAttribute('data-slide-id', firstSlideId)
    await expect(editable).toBeVisible()

    // "Show" leaves text editing and goes there.
    await notice.getByRole('button', { name: 'Show' }).click()
    await expect(editable).toHaveCount(0)
    await expect(activeSlide).toHaveAttribute('data-slide-id', secondSlideId, { timeout: 10_000 })
    await expect.poll(selection, { timeout: 10_000 }).toEqual(['show-rect'])
    await expect(notice).toHaveCount(0)
  })

  test('present mode starts at ?slide=N and clamps past the end', async ({ page }) => {
    test.setTimeout(90_000)
    const { deckId, slideId: firstSlideId } = await openNewDeck(page, 'e2e present slide param')
    const [secondSlideId, thirdSlideId] = await page.evaluate(() => {
      const api = window.__narrative_test_api!
      return [api.addSlide(), api.addSlide()]
    })
    // The slides must be on the server before a fresh page load reads them.
    await expect
      .poll(
        async () =>
          (await command<{ slideCount: number }>(page, deckId, 'query.deck', {})).result
            ?.slideCount ?? 0,
        { timeout: 15_000 },
      )
      .toBe(3)

    const container = page.getByTestId('slide-container')

    await page.goto(`/deck/${deckId}/present?slide=2`)
    await expect(container).toHaveAttribute('data-active-slide-id', secondSlideId!, {
      timeout: 15_000,
    })

    await page.goto(`/deck/${deckId}/present?slide=99`)
    await expect(container).toHaveAttribute('data-active-slide-id', thirdSlideId!, {
      timeout: 15_000,
    })

    // An invalid number is ignored: present mode starts at the active slide
    // (the last one shown, persisted per deck) — here slide 3 from above.
    await page.goto(`/deck/${deckId}/present?slide=0`)
    await expect(container).toHaveAttribute('data-active-slide-id', thirdSlideId!, {
      timeout: 15_000,
    })

    await page.goto(`/deck/${deckId}/present?slide=1`)
    await expect(container).toHaveAttribute('data-active-slide-id', firstSlideId, {
      timeout: 15_000,
    })
  })
})
