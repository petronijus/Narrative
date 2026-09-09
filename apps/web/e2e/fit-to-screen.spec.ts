/**
 * e2e/fit-to-screen.spec.ts
 *
 * Reproduces + verifies the "Fit to screen" zoom button offset bug.
 * After clicking Fit the artboard must be visually centered inside the
 * channel defined by the floating chrome insets (side panels, toolbar,
 * bottom panels). Tolerance: ≤ 2 px on both axes.
 */

import { test, expect } from '@playwright/test'

const API = 'http://localhost:3001'

test('Fit to screen centers artboard in the visible channel', async ({ page }) => {
  // Measure at a window the editor is actually laid out for.
  await page.setViewportSize({ width: 1920, height: 1080 })

  // ── 1. Create a fresh deck via API ──────────────────────────────────────
  const res = await page.request.post(`${API}/decks`, {
    data: { title: 'fit-test' },
  })
  expect(res.ok()).toBeTruthy()
  const { id } = await res.json()

  // ── 2. Open the editor ──────────────────────────────────────────────────
  await page.goto(`/deck/${id}`, { waitUntil: 'networkidle' })

  // Wait for the editor canvas to be ready
  await page.waitForSelector('.artboard', { timeout: 15_000 })

  // Give React a moment to finish all ResizeObserver callbacks
  await page.waitForTimeout(500)

  // ── 3. Capture baseline measurements ────────────────────────────────────
  const before = await page.evaluate(() => {
    const scroller = document.querySelector('[data-stage-scroll]') as HTMLElement | null
    const artboard = document.querySelector('.artboard') as HTMLElement | null
    if (!scroller || !artboard) return null

    const ab = artboard.getBoundingClientRect()

    // Read the scroller's computed padding (what the DOM actually shows)
    const cs = getComputedStyle(scroller)
    const scrollerPadding = {
      top: parseFloat(cs.paddingTop),
      bottom: parseFloat(cs.paddingBottom),
      left: parseFloat(cs.paddingLeft),
      right: parseFloat(cs.paddingRight),
    }

    // Measure via the floating chrome elements directly
    // The toolbar wrapper has paddingLeft/Right applied and is top-0
    // The bottom panels wrapper has paddingLeft/Right and is bottom-0
    const toolbarEl =
      scroller
        .closest('.relative')
        ?.parentElement?.querySelector('[class*="absolute"][class*="inset-x-0"][class*="top-0"]') ??
      null
    const bottomEl =
      scroller
        .closest('.relative')
        ?.parentElement?.querySelector(
          '[class*="absolute"][class*="inset-x-0"][class*="bottom-0"]',
        ) ?? null

    return {
      scrollerPadding,
      toolbarH: toolbarEl ? toolbarEl.getBoundingClientRect().height : null,
      bottomH: bottomEl ? bottomEl.getBoundingClientRect().height : null,
      artboard: {
        left: ab.left,
        top: ab.top,
        right: ab.right,
        bottom: ab.bottom,
        width: ab.width,
        height: ab.height,
      },
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    }
  })

  console.log('BEFORE FIT:', JSON.stringify(before, null, 2))

  // ── 4. Take screenshot BEFORE fit ───────────────────────────────────────
  await page.screenshot({
    path: 'test-results/fit-before.png',
    fullPage: false,
  })

  // ── 5. Click Fit to screen ───────────────────────────────────────────────
  // The zoom cluster keeps everything but the percentage collapsed
  // (`max-h-0`) until it is hovered, and the collapsed strip sits under the
  // "100%" button — so clicking straight at Fit is intercepted. Hover the
  // cluster open first, the way a user does.
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  const fitBtn = page.getByRole('button', { name: 'Fit to screen' })
  await expect(fitBtn).toBeVisible()
  await fitBtn.click()

  // Wait for the zoom state to propagate + scroller to settle
  // We need at least 2 animation frames + React re-render
  await page.waitForTimeout(1000)

  // Log the scroll position right after clicking
  const scrollState = await page.evaluate(() => {
    const scroller = document.querySelector('[data-stage-scroll]') as HTMLElement | null
    return scroller
      ? {
          scrollLeft: scroller.scrollLeft,
          scrollTop: scroller.scrollTop,
          scrollWidth: scroller.scrollWidth,
          scrollHeight: scroller.scrollHeight,
          clientWidth: scroller.clientWidth,
          clientHeight: scroller.clientHeight,
        }
      : null
  })
  console.log('SCROLL STATE:', JSON.stringify(scrollState, null, 2))

  // ── 6. Take screenshot AFTER fit ────────────────────────────────────────
  await page.screenshot({
    path: 'test-results/fit-after.png',
    fullPage: false,
  })

  // ── 7. Measure the offset ────────────────────────────────────────────────
  const after = await page.evaluate(() => {
    const scroller = document.querySelector('[data-stage-scroll]') as HTMLElement | null
    const artboard = document.querySelector('.artboard') as HTMLElement | null
    if (!scroller || !artboard) return null

    const ab = artboard.getBoundingClientRect()

    // Re-read computed padding to see if it changed
    const cs = getComputedStyle(scroller)
    const scrollerPadding = {
      top: parseFloat(cs.paddingTop),
      bottom: parseFloat(cs.paddingBottom),
      left: parseFloat(cs.paddingLeft),
      right: parseFloat(cs.paddingRight),
    }

    // Measure the floating chrome panels to get the true insets
    const editorRoot = scroller.closest('.relative.z-0')?.parentElement ?? document.body
    const allAbsolute = Array.from(
      editorRoot.querySelectorAll('[class*="absolute"][class*="inset-x-0"]'),
    )

    let topBarH = 0
    let bottomPanelsH = 0
    for (const el of allAbsolute) {
      const rect = el.getBoundingClientRect()
      const cls = el.className
      if (cls.includes('top-0') && !cls.includes('bottom-0')) {
        topBarH = Math.max(topBarH, rect.height)
      } else if (cls.includes('bottom-0') && !cls.includes('top-0')) {
        bottomPanelsH = Math.max(bottomPanelsH, rect.height)
      }
    }

    // Fallback: read from the scroller's style attributes
    // The ZoomControl passes viewportInsets from the live state,
    // so we can read slidesInset/inspectorInset from the padding
    const slidesInset = scrollerPadding.left
    const inspectorInset = scrollerPadding.right

    // Channel rect (visible area between panels)
    const channelLeft = slidesInset
    const channelTop = topBarH
    const channelRight = window.innerWidth - inspectorInset
    const channelBottom = window.innerHeight - bottomPanelsH
    const channelCenterX = (channelLeft + channelRight) / 2
    const channelCenterY = (channelTop + channelBottom) / 2

    const artCenterX = ab.left + ab.width / 2
    const artCenterY = ab.top + ab.height / 2

    return {
      scrollerPadding,
      topBarH,
      bottomPanelsH,
      slidesInset,
      inspectorInset,
      channelRect: {
        left: channelLeft,
        top: channelTop,
        right: channelRight,
        bottom: channelBottom,
      },
      channelCenter: { x: channelCenterX, y: channelCenterY },
      artboardRect: {
        left: ab.left,
        top: ab.top,
        right: ab.right,
        bottom: ab.bottom,
        width: ab.width,
        height: ab.height,
      },
      artboardCenter: { x: artCenterX, y: artCenterY },
      offsetX: artCenterX - channelCenterX,
      offsetY: artCenterY - channelCenterY,
    }
  })

  console.log('AFTER FIT:', JSON.stringify(after, null, 2))

  // ── 8. Assert centering ──────────────────────────────────────────────────
  expect(after).not.toBeNull()
  const offsetX = Math.abs(after!.offsetX)
  const offsetY = Math.abs(after!.offsetY)

  console.log(`Offset X: ${after!.offsetX.toFixed(1)} px, Y: ${after!.offsetY.toFixed(1)} px`)
  console.log(
    `Scroller padding: top=${after!.scrollerPadding.top} bottom=${after!.scrollerPadding.bottom}`,
  )
  console.log(
    `Actual panel heights: topBarH=${after!.topBarH} bottomPanelsH=${after!.bottomPanelsH}`,
  )

  // Tolerance: 2 px on each axis
  expect(
    offsetX,
    `Artboard X offset from channel center: ${after!.offsetX.toFixed(1)} px`,
  ).toBeLessThanOrEqual(2)
  expect(
    offsetY,
    `Artboard Y offset from channel center: ${after!.offsetY.toFixed(1)} px`,
  ).toBeLessThanOrEqual(2)
})
