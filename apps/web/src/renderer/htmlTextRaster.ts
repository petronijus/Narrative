/**
 * renderer/htmlTextRaster.ts
 *
 * Pixi v8's HTMLText rasterises its SVG asynchronously: the first render of a
 * text node starts that work, and its texture stays empty until the promise
 * Pixi keeps on the node's per-renderer GPU data (`_gpuData[uid].texturePromise`)
 * settles. A one-shot render (thumbnails.ts) or a "fully painted" check (the
 * render page, agentic A3) awaits these, then renders again.
 */

import type { Container } from 'pixi.js'

/** The raster promises of every HTMLText under `root` for renderer `rendererUid`. */
export function collectHtmlTextRasters(root: Container, rendererUid: number): Promise<unknown>[] {
  const out: Promise<unknown>[] = []
  const walk = (c: Container): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi keeps per-renderer GPU data untyped
    const p = (c as any)._gpuData?.[rendererUid]?.texturePromise
    if (p && typeof p.then === 'function') out.push(p as Promise<unknown>)
    for (const child of c.children) walk(child as Container)
  }
  walk(root)
  return out
}
