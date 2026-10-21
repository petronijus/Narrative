/**
 * e2e/local-doc-copies.spec.ts — the browser's local copies of documents
 * (ADR 0017, docs/plans/performance.md → L4), end to end against the dev
 * stack:
 *
 *   - a repeat open paints the deck from its local copy before the sync
 *     server has answered (the WebSocket is held, so nothing can sync);
 *   - a deck whose share was revoked shows nothing once the server refuses
 *     it, and its copy is deleted;
 *   - notes changed on the server while the tab was away show in the editor
 *     and in present mode, over the copy's older notes;
 *   - a share-link visit keeps no copy;
 *   - another person signing in in the same browser deletes the previous
 *     person's copies, and a tab still open for the previous person stops
 *     and reloads (the `narrative-auth` broadcast).
 *
 * Two people in one dev stack as in folder-sharing.spec.ts: the
 * `narrative_dev_as` cookie makes a browser context another synthetic
 * identity (BYPASS_AUTH only). Each test seeds its decks through the API.
 */

import { expect, test, type Browser, type Page } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'
const INDEX_PREFIX = 'narrative:local-docs:v2:'

async function personPage(browser: Browser, sub: string): Promise<Page> {
  const context = await browser.newContext()
  await context.addCookies([
    { name: 'narrative_dev_as', value: sub, domain: 'localhost', path: '/' },
  ])
  return context.newPage()
}

/** A deck of `slides` slides, created by the page's person. */
async function seedDeck(page: Page, slides: number): Promise<string> {
  const res = await page.request.post(`${API_BASE}/decks`, {
    data: { title: `local copy ${Date.now().toString(36)}` },
  })
  expect(res.ok(), `POST /decks: ${res.status()}`).toBe(true)
  const { id } = (await res.json()) as { id: string }
  for (let i = 0; i < slides; i++) {
    const r = await page.request.post(`${API_BASE}/commands`, {
      headers: { Origin: WEB_ORIGIN },
      data: { target: { deckId: id }, command: 'slide.add', input: {} },
    })
    expect(((await r.json()) as { ok: boolean }).ok, 'slide.add').toBe(true)
  }
  return id
}

/** Replace a slide's speaker notes on the server (the `slide.notes.set` command). */
async function setNotesOnServer(
  page: Page,
  deckId: string,
  slideId: string,
  markdown: string,
): Promise<void> {
  const r = await page.request.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target: { deckId }, command: 'slide.notes.set', input: { slide: slideId, markdown } },
  })
  expect(((await r.json()) as { ok: boolean }).ok, 'slide.notes.set').toBe(true)
}

function notesPanel(page: Page) {
  return page.locator('.panel', { hasText: 'Speaker notes' })
}

function rows(page: Page) {
  return page.locator('[role="option"][data-slide-id]')
}

/** The document names the page's index lists for `sub`. */
async function indexed(page: Page, sub: string): Promise<string[]> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw === null ? [] : (JSON.parse(raw) as string[])
  }, INDEX_PREFIX + sub)
}

/** The keys of the stored copies (`<sub> NUL <document>`), without creating the database. */
async function storedCopies(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === 'narrative-local-docs')) return []
    return new Promise<string[]>((resolve) => {
      const req = indexedDB.open('narrative-local-docs')
      req.onsuccess = () => {
        const db = req.result
        const keys = db.transaction('meta').objectStore('meta').getAllKeys()
        keys.onsuccess = () => {
          db.close()
          resolve(keys.result as string[])
        }
      }
      req.onerror = () => resolve([])
    })
  })
}

/** Open the deck and wait until its copy is written (debounce + idle). */
async function openAndKeep(page: Page, sub: string, deckId: string, slides: number): Promise<void> {
  await page.goto(`/deck/${deckId}`)
  await expect(rows(page)).toHaveCount(slides, { timeout: 30_000 })
  await expect.poll(() => indexed(page, sub), { timeout: 15_000 }).toContain(deckId)
}

test.describe('local document copies', () => {
  test('a repeat open paints the deck from its copy before the server answers', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const deckId = await seedDeck(page, 3)
    await page.goto(`/deck/${deckId}`)
    await expect(rows(page)).not.toHaveCount(0, { timeout: 30_000 })
    const slides = await rows(page).count()
    await expect.poll(() => indexed(page, 'dev-user'), { timeout: 15_000 }).toContain(deckId)

    // Hold every sync-server socket: it opens, but nothing reaches the server.
    await page.routeWebSocket(
      (url) => url.port === '3002' || url.pathname.startsWith('/ws'),
      () => undefined,
    )
    await page.reload()
    await expect(rows(page)).toHaveCount(slides, { timeout: 15_000 })
  })

  test('a revoked deck shows nothing once the server refuses it, and its copy is gone', async ({
    browser,
  }, info) => {
    test.setTimeout(120_000)
    const slot = info.parallelIndex
    const ownerSub = `dev-e2e-l4-owner-${slot}`
    const memberSub = `dev-e2e-l4-member-${slot}`
    const owner = await personPage(browser, ownerSub)
    const member = await personPage(browser, memberSub)
    try {
      // The member's first request gives them a directory entry.
      expect((await member.request.get(`${API_BASE}/folders`)).ok()).toBe(true)
      const deckId = await seedDeck(owner, 2)
      const invite = await owner.request.post(`${API_BASE}/decks/${deckId}/permissions`, {
        data: { email: `${memberSub}@dev.narrative.test`, role: 'viewer' },
      })
      expect(invite.ok(), `invite: ${invite.status()}`).toBe(true)

      await member.goto(`/deck/${deckId}`)
      await expect(rows(member)).not.toHaveCount(0, { timeout: 30_000 })
      const slides = await rows(member).count()
      await openAndKeep(member, memberSub, deckId, slides)
      expect(await storedCopies(member)).toContain(`${memberSub}\u0000${deckId}`)

      await member.goto('/')
      const revoke = await owner.request.delete(
        `${API_BASE}/decks/${deckId}/permissions/${encodeURIComponent(memberSub)}`,
      )
      expect(revoke.ok() || revoke.status() === 204, `revoke: ${revoke.status()}`).toBe(true)

      await member.goto(`/deck/${deckId}`)
      // The server refuses the connection: the copy is deleted and the deck
      // opened again, empty — as a refused deck looked before local copies.
      await expect.poll(() => indexed(member, memberSub), { timeout: 15_000 }).not.toContain(deckId)
      await expect(rows(member)).toHaveCount(0, { timeout: 15_000 })
      await expect.poll(() => storedCopies(member)).not.toContain(`${memberSub}\u0000${deckId}`)
    } finally {
      await owner.context().close()
      await member.context().close()
    }
  })

  test('notes changed on the server while the tab was away show over the copy, in the editor and in present mode', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const deckId = await seedDeck(page, 1)
    await page.goto(`/deck/${deckId}`)
    await expect(rows(page)).not.toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => indexed(page, 'dev-user'), { timeout: 15_000 }).toContain(deckId)
    const slideId = await rows(page).first().getAttribute('data-slide-id')
    expect(slideId, 'the slide row names its slide').not.toBeNull()

    // The copy holds the slide with its notes: written while the editor is open.
    await setNotesOnServer(page, deckId, slideId!, 'Notes in the copy')
    await expect(notesPanel(page).getByLabel('Speaker notes editor').first()).toContainText(
      'Notes in the copy',
      { timeout: 15_000 },
    )
    // Past the copy's debounce and an idle callback: the notes are in it.
    await page.waitForTimeout(3_000)

    // The tab goes elsewhere; the notes change on the server meanwhile.
    await page.goto('/')
    await setNotesOnServer(page, deckId, slideId!, 'Notes from the server')

    // The editor paints the copy, then syncs: the server's notes win.
    await page.goto(`/deck/${deckId}`)
    await expect(notesPanel(page).getByLabel('Speaker notes editor').first()).toContainText(
      'Notes from the server',
      { timeout: 15_000 },
    )
    await page.waitForTimeout(3_000)

    // And present mode, from a copy that is older again.
    await page.goto('/')
    await setNotesOnServer(page, deckId, slideId!, 'Notes for the presenter')
    await page.goto(`/deck/${deckId}/present`)
    await page.waitForSelector('[data-testid="slide-container"]', { timeout: 30_000 })
    await page.keyboard.press('n')
    const presenter = page.getByRole('region', { name: 'Presenter view' })
    await expect(presenter).toContainText('Notes for the presenter', { timeout: 15_000 })
    await expect(presenter).not.toContainText('No notes')
  })

  test('the presenter notes follow their slide when someone else moves it', async ({ page }) => {
    // A move replaces the slide's map (and its notes fragment) under the same
    // id: the notes shown must come from the new one, as later edits do.
    test.setTimeout(120_000)
    const deckId = await seedDeck(page, 1)
    await page.goto(`/deck/${deckId}`)
    await expect(rows(page)).toHaveCount(2, { timeout: 30_000 })
    const slideId = await rows(page).first().getAttribute('data-slide-id')
    expect(slideId, 'the slide row names its slide').not.toBeNull()
    await setNotesOnServer(page, deckId, slideId!, 'Notes before the move')

    await page.goto(`/deck/${deckId}/present`)
    await page.waitForSelector('[data-testid="slide-container"]', { timeout: 30_000 })
    await page.keyboard.press('n')
    const presenter = page.getByRole('region', { name: 'Presenter view' })
    await expect(presenter).toContainText('Notes before the move', { timeout: 15_000 })

    const move = await page.request.post(`${API_BASE}/commands`, {
      headers: { Origin: WEB_ORIGIN },
      data: { target: { deckId }, command: 'slide.move', input: { slides: [slideId], toIndex: 2 } },
    })
    expect(((await move.json()) as { ok: boolean }).ok, 'slide.move').toBe(true)
    await setNotesOnServer(page, deckId, slideId!, 'Notes after the move')
    await expect(presenter).toContainText('Notes after the move', { timeout: 15_000 })
  })

  test('a share-link visit keeps no copy', async ({ page, browser }) => {
    test.setTimeout(90_000)
    const deckId = await seedDeck(page, 2)
    const link = await page.request.post(`${API_BASE}/decks/${deckId}/share-links`, {
      data: { role: 'viewer' },
    })
    expect(link.status()).toBe(201)
    const { id: token } = (await link.json()) as { id: string }

    const visitor = await browser.newContext()
    try {
      const view = await visitor.newPage()
      await view.goto(`/deck/${deckId}?share_token=${encodeURIComponent(token)}`)
      await expect(rows(view)).not.toHaveCount(0, { timeout: 30_000 })
      // Past the debounce and an idle callback: nothing was written.
      await view.waitForTimeout(3_000)
      const keys = await view.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith('narrative:local-docs:')),
      )
      expect(keys).toEqual([])
      expect(await storedCopies(view)).toEqual([])
    } finally {
      await visitor.close()
    }
  })

  test("another person signing in deletes the previous person's copies", async ({
    browser,
  }, info) => {
    test.setTimeout(90_000)
    const first = `dev-e2e-l4-first-${info.parallelIndex}`
    const second = `dev-e2e-l4-second-${info.parallelIndex}`
    const page = await personPage(browser, first)
    try {
      const deckId = await seedDeck(page, 1)
      await page.goto(`/deck/${deckId}`)
      await expect(rows(page)).not.toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => indexed(page, first), { timeout: 15_000 }).toContain(deckId)

      await page
        .context()
        .addCookies([{ name: 'narrative_dev_as', value: second, domain: 'localhost', path: '/' }])
      await page.goto('/')
      await expect.poll(() => indexed(page, first)).toEqual([])
      await expect
        .poll(async () => (await storedCopies(page)).filter((k) => k.startsWith(`${first}\u0000`)))
        .toEqual([])
    } finally {
      await page.context().close()
    }
  })

  test('a tab open for the previous person reloads when another tab changes the session', async ({
    browser,
  }, info) => {
    test.setTimeout(90_000)
    const first = `dev-e2e-l4-tab-a-${info.parallelIndex}`
    const second = `dev-e2e-l4-tab-b-${info.parallelIndex}`
    const page = await personPage(browser, first)
    try {
      const deckId = await seedDeck(page, 1)
      await page.goto(`/deck/${deckId}`)
      await expect(rows(page)).not.toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => indexed(page, first), { timeout: 15_000 }).toContain(deckId)

      // The same browser, another tab, now signed in as someone else.
      await page
        .context()
        .addCookies([{ name: 'narrative_dev_as', value: second, domain: 'localhost', path: '/' }])
      const reloaded = page.waitForEvent('framenavigated', { timeout: 15_000 })
      const other = await page.context().newPage()
      await other.goto('/')
      await reloaded
      // After its reload the first tab runs as the second person: the first
      // person's copies are gone and none is written for them again.
      await expect.poll(() => indexed(page, first)).toEqual([])
      await page.waitForTimeout(2_500)
      expect(await indexed(page, first)).toEqual([])
    } finally {
      await page.context().close()
    }
  })
})
