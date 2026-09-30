import { Buffer } from 'node:buffer'
import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'

/**
 * E2E (A2.12b): a picture uploaded into a component master belongs to the
 * component and renders in the master editor.
 *
 * Before A2.12b the master editor sent tus a synthetic deckId
 * `component:<id>`, which the server refused — no upload into a master ever
 * worked. Now the upload carries `componentId`, the server stores it under
 * components/<id>/ as a row owned by the component, and the folder owner can
 * resolve its signed URL.
 *
 * The component is created through the API, which writes its empty master
 * slide on the server (slide-model `writeComponentMaster`).
 */

const API = 'http://localhost:3001'

/** A solid-blue PNG large enough to clear the coloured-pixel threshold on the master canvas. */
function makeBluePng(width = 480, height = 320): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    const idx = i << 2
    png.data[idx] = 30
    png.data[idx + 1] = 90
    png.data[idx + 2] = 230
    png.data[idx + 3] = 255
  }
  return PNG.sync.write(png)
}

/** Pixels with visible saturation (non-grey, non-near-black/white). */
function countColouredPixelsInPng(pngBuffer: Buffer): number {
  const png = PNG.sync.read(pngBuffer)
  const d = png.data
  let count = 0
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!,
      g = d[i + 1]!,
      b = d[i + 2]!,
      a = d[i + 3]!
    if (a < 200) continue
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max - min > 30 && max > 20 && min < 235) count++
  }
  return count
}

/** The key → value pairs of a tus Upload-Metadata header (values are base64). */
function decodeTusMetadata(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of header.split(',')) {
    const [key, value = ''] = pair.trim().split(' ')
    if (key) out[key] = Buffer.from(value, 'base64').toString('utf8')
  }
  return out
}

test('component master upload: a picture uploaded into a master is owned by the component and renders', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`)
  })

  // A folder of our own, and a component in it.
  const folderRes = await page.request.post(`${API}/folders`, {
    data: { name: `E2E component media ${Date.now()}` },
  })
  expect(folderRes.ok(), `POST /folders: ${folderRes.status()}`).toBe(true)
  const { id: folderId } = (await folderRes.json()) as { id: string }

  try {
    const componentRes = await page.request.post(`${API}/folders/${folderId}/components`, {
      data: { name: 'Media master' },
    })
    expect(componentRes.ok(), `POST components: ${componentRes.status()}`).toBe(true)
    const { id: componentId } = (await componentRes.json()) as { id: string }

    await page.goto(`/folder/${folderId}`)

    // Watch the tus creation request and the signed-URL lookups.
    const tusCreation = page.waitForRequest(
      (r) => r.method() === 'POST' && /\/api\/uploads\/?$/.test(new URL(r.url()).pathname),
    )
    const mediaUrlOk = page.waitForResponse(
      (r) => /\/api\/media\/[^/]+\/url/.test(r.url()) && r.status() === 200,
      { timeout: 45_000 },
    )

    await page.goto(`/folder/${folderId}/component/${componentId}`)
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1500)

    const baseline = countColouredPixelsInPng(await page.screenshot({ fullPage: true }))

    await page
      .locator('input[type="file"][accept^="image"]')
      .first()
      .setInputFiles({ name: 'blue.png', mimeType: 'image/png', buffer: makeBluePng() })

    // tus is told the owner is the component — never a deck.
    const creation = await tusCreation
    const metadata = decodeTusMetadata((await creation.headerValue('upload-metadata')) ?? '')
    expect(metadata).toMatchObject({ componentId, 'content-type': 'image/png' })
    expect(metadata).not.toHaveProperty('deckId')
    const created = await creation.response()
    expect(created?.status(), `tus create: ${errors.join(' | ')}`).toBe(201)

    // The renderer resolves the stored picture through /api/media/:id/url.
    const urlResponse = await mediaUrlOk
    const assetId = new URL(urlResponse.url()).pathname.split('/').at(-2)!

    let after = baseline
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await page.waitForTimeout(500)
      after = countColouredPixelsInPng(await page.screenshot({ fullPage: true }))
      if (after > baseline + 2_000) break
    }
    expect(
      after,
      `the picture never painted in the master — baseline=${baseline}, after=${after}. ` +
        `errors: ${errors.join(' | ') || 'none'}`,
    ).toBeGreaterThan(baseline + 2_000)

    // The folder owner resolves the component's picture directly too.
    const direct = await page.request.get(`${API}/api/media/${assetId}/url?variant=thumb`)
    expect(direct.status()).toBe(200)

    // Deleting the folder takes the component and its media with it.
    const deleted = await page.request.delete(`${API}/folders/${folderId}`)
    expect(deleted.status()).toBe(200)
    const gone = await page.request.get(`${API}/api/media/${assetId}/url`)
    expect(gone.status()).toBe(404)
  } finally {
    await page.request.delete(`${API}/folders/${folderId}`).catch(() => undefined)
  }
})
