/**
 * e2e/component-promote-stamp.spec.ts
 *
 * Components on the server (A2.12b), through the editor:
 *
 *   - promote: right-click a picture → "Promote to component" → the server
 *     builds the master (`component.promote`) and copies the picture into
 *     the component, which owns it; the slide keeps its object;
 *   - stamp: "Add component" → pick it → the server stamps the master onto
 *     the slide (`component.stamp`); the stamp LINKS the master's picture
 *     (folder sharing step 2: a deck shows its folder's component media),
 *     and keeps showing it after the component is deleted (the folder takes
 *     the component's media over);
 *   - paste: a picture copied in a deck and pasted in the master editor is
 *     copied into the component (`object.insertFromDeck` into a master).
 *
 * Read back through the command API and the media URL route.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** A 1×1 red PNG. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

type Obj = Record<string, unknown> & { id: string; type: string }

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

function objectsOn(request: APIRequestContext, deckId: string): Promise<Obj[]> {
  return command<{ objects: Obj[] }>(request, { deckId }, 'query.slide', {
    slide: { index: 0 },
  }).then((s) => s.objects)
}

/** Open a deck fitted to the screen; returns the viewport point of a slide point. */
async function openDeck(page: Page, deckId: string) {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('[data-slide-index]')).toHaveCount(1, { timeout: 30_000 })
  const artboard = page.locator('.artboard')
  await expect(artboard).toBeVisible()
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  await page.waitForTimeout(400)
  const box = (await artboard.boundingBox())!
  return (x: number, y: number) => ({
    x: box.x + (x / 1920) * box.width,
    y: box.y + (y / 1080) * box.height,
  })
}

/** The media URL route answers for the signed-in user (the folder owner). */
async function mediaServes(request: APIRequestContext, assetId: string): Promise<number> {
  return (await request.get(`${API_BASE}/api/media/${assetId}/url`)).status()
}

test('promote a picture to a component, stamp it back linked, and keep it after the component goes', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const { id: folderId } = (await (
    await page.request.post(`${API_BASE}/folders`, {
      data: { name: `E2E promote stamp ${Date.now()}` },
    })
  ).json()) as { id: string }

  try {
    const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', {
      title: 'Promote and stamp',
      folderId,
    })
    const { assetId } = await command<{ assetId: string }>(
      page.request,
      { deckId },
      'media.upload',
      { file: { base64: PNG_1PX, filename: 'red.png' } },
    )
    await command(page.request, { deckId }, 'object.create', {
      slide: { index: 0 },
      object: { type: 'image', assetId, x: 400, y: 200, width: 400, height: 400 },
    })

    // Promote through the context menu.
    const at = await openDeck(page, deckId)
    const img = at(600, 400)
    await page.mouse.click(img.x, img.y)
    await page.mouse.click(img.x, img.y, { button: 'right' })
    await page.getByTestId('promote-to-component').click()
    await page.locator('#promote-component-name').fill('Red square')
    await page.getByTestId('promote-component-confirm').click()

    let componentId = ''
    await expect
      .poll(async () => {
        const { components } = await command<{ components: Array<{ id: string; name: string }> }>(
          page.request,
          { folderId },
          'component.list',
          {},
        )
        componentId = components.find((c) => c.name === 'Red square')?.id ?? ''
        return componentId
      })
      .not.toBe('')

    const master = await command<{ objects: Obj[] }>(page.request, { folderId }, 'component.get', {
      componentId,
    })
    expect(master.objects).toHaveLength(1)
    const masterAsset = master.objects[0]!['assetId'] as string
    // The component owns a copy of the picture, and serves it.
    expect(masterAsset).not.toBe(assetId)
    expect(await mediaServes(page.request, masterAsset)).toBe(200)
    // The slide is unchanged.
    expect(await objectsOn(page.request, deckId)).toHaveLength(1)

    // Stamp it from the picker.
    await page.getByTestId('toolbar-add-component').click()
    await page.getByTestId(`component-picker-row-${componentId}`).click()
    await expect.poll(async () => (await objectsOn(page.request, deckId)).length).toBe(2)
    const stamped = (await objectsOn(page.request, deckId))[1]!
    expect(stamped).toMatchObject({ type: 'image', x: 400, y: 200 })
    // Linked: the stamp shows the master's own picture, nothing was copied.
    expect(stamped['assetId']).toBe(masterAsset)
    const media = await command<{ url: string }>(page.request, { deckId }, 'media.url', {
      assetId: masterAsset,
    })
    expect(media.url).toBeTruthy()

    // The component goes; its picture stays with the folder, and the stamp
    // keeps showing it.
    // (The editor's route: component.delete asks an agent to confirm.)
    const removed = await page.request.delete(`${API_BASE}/components/${componentId}`)
    expect(removed.status()).toBe(204)
    expect(await mediaServes(page.request, masterAsset)).toBe(200)
    const after = await command<{ url: string }>(page.request, { deckId }, 'media.url', {
      assetId: masterAsset,
    })
    expect(after.url).toBeTruthy()
    expect(errors).toEqual([])
  } finally {
    await page.request.delete(`${API_BASE}/folders/${folderId}`)
  }
})

test("a picture pasted from a deck into a master editor becomes the component's", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const { id: folderId } = (await (
    await page.request.post(`${API_BASE}/folders`, {
      data: { name: `E2E master paste ${Date.now()}` },
    })
  ).json()) as { id: string }

  try {
    const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', {
      title: 'Paste into a master',
      folderId,
    })
    const { assetId } = await command<{ assetId: string }>(
      page.request,
      { deckId },
      'media.upload',
      { file: { base64: PNG_1PX, filename: 'red.png' } },
    )
    await command(page.request, { deckId }, 'object.create', {
      slide: { index: 0 },
      object: { type: 'image', assetId, x: 400, y: 200, width: 400, height: 400 },
    })
    const componentRes = await page.request.post(`${API_BASE}/folders/${folderId}/components`, {
      data: { name: 'Empty master' },
    })
    expect(componentRes.status()).toBe(201)
    const { id: componentId } = (await componentRes.json()) as { id: string }

    const at = await openDeck(page, deckId)
    const img = at(600, 400)
    await page.mouse.click(img.x, img.y)
    await page.keyboard.press('ControlOrMeta+c')

    // The master editor: the same editor on the component's document.
    await page.goto(`/folder/${folderId}/component/${componentId}`)
    const artboard = page.locator('.artboard')
    await expect(artboard).toBeVisible({ timeout: 30_000 })
    const box = (await artboard.boundingBox())!
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9)
    await page.keyboard.press('ControlOrMeta+v')

    let pasted: Obj | undefined
    await expect
      .poll(async () => {
        const master = await command<{ objects: Obj[] }>(
          page.request,
          { folderId },
          'component.get',
          { componentId },
        )
        pasted = master.objects[0]
        return master.objects.length
      })
      .toBe(1)
    expect(pasted).toMatchObject({ type: 'image' })
    const masterAsset = pasted!['assetId'] as string
    expect(masterAsset).not.toBe(assetId)
    expect(await mediaServes(page.request, masterAsset)).toBe(200)
  } finally {
    await page.request.delete(`${API_BASE}/folders/${folderId}`)
  }
})
