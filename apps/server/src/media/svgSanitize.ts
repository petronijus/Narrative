/**
 * media/svgSanitize.ts
 *
 * Server-side SVG content sanitization (XSS-3 defense-in-depth).
 *
 * The Caddy storage headers (Content-Disposition: attachment + sandbox CSP +
 * nosniff on /storage/*) already neuter the "SVG served as a document"
 * exploit chain. This module is the belt-and-suspenders layer: it strips
 * active content from SVG bytes *at upload time*, so a stored SVG can never
 * carry script/event-handlers/external-doc references even if it's ever
 * served somewhere that lacks those headers (an <img src> reference, a CDN
 * mirror, a future feature, etc).
 *
 * Design notes:
 *   - jsdom is the largest module graph the server has (~1,100 of the
 *     ~2,700 modules a boot loaded, css-tree, parse5 and undici included),
 *     and only SVG uploads need it: it is required on the first
 *     `sanitizeSvg` call, not at boot (performance plan D3). The jsdom Window
 *     is expensive to construct too, so that first call builds ONE DOMPurify
 *     instance bound to a single jsdom window and every later upload reuses
 *     it. DOMPurify itself is stateless across `.sanitize()` calls.
 *   - SVG/XML is text, so it can't be identified by a fixed magic-byte
 *     signature the way raster formats can — `sniffIsSvg` does a lightweight
 *     leading-bytes scan for `<svg`/`<?xml` so a `.png`-renamed SVG is still
 *     caught and routed through sanitization.
 *   - Raster formats DO have stable magic bytes; `magicBytesMatch` rejects a
 *     declared image/png|jpeg|gif|webp|avif whose actual signature disagrees
 *     (e.g. a PE binary or shell script wearing a .png coat).
 */

import { createRequire } from 'node:module'
import type { JSDOM as JSDOMClass } from 'jsdom'
import type createDOMPurifyFn from 'dompurify'
import type { DOMPurify as DOMPurifyInstance, WindowLike } from 'dompurify'

// Both are CommonJS-loadable; a synchronous require keeps `sanitizeSvg`
// synchronous for its caller while deferring the load to the first SVG.
const require = createRequire(import.meta.url)

const SAFE_HREF = /^(#|data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[,;])/i

function isSafeHref(value: string): boolean {
  // Strip whitespace and C0 control chars (0x00-0x20) that browsers ignore
  // inside URIs, so `java\nscript:` / `java\tscript:` obfuscation can't slip
  // past the prefix test. Use a hex range so this regex is copy-paste safe.
  const cleaned = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  if (cleaned === '') return true
  return SAFE_HREF.test(value.trim()) || SAFE_HREF.test(cleaned)
}

let purifier: DOMPurifyInstance | null = null

/**
 * The one jsdom window + DOMPurify instance, built on first use.
 *
 * Hardening hook: belt-and-suspenders on top of USE_PROFILES.svg.
 * DOMPurify's SVG profile already drops <script> and on* handlers, but we add
 * an explicit afterSanitizeAttributes hook to also clamp href / xlink:href to
 * safe values (only `#fragment` internal refs and `data:image/...` are kept).
 * This blocks `javascript:` URIs and external-document references (which can
 * be used for data exfiltration / SSRF-ish fetches) that some renderers honor
 * on <a>, <use>, <image>, <feImage>, etc.
 */
function domPurify(): DOMPurifyInstance {
  if (purifier !== null) return purifier
  const { JSDOM } = require('jsdom') as { JSDOM: typeof JSDOMClass }
  const createDOMPurify = require('dompurify') as typeof createDOMPurifyFn
  const window = new JSDOM('').window
  // jsdom's DOMWindow provides every DOM constructor DOMPurify's WindowLike
  // needs; the structural cast bridges the two nominal window types.
  const instance = createDOMPurify(window as unknown as WindowLike)
  instance.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (typeof el.getAttribute !== 'function') return
    for (const attr of ['href', 'xlink:href']) {
      const val = el.getAttribute(attr)
      if (val !== null && !isSafeHref(val)) {
        el.removeAttribute(attr)
      }
    }
  })
  purifier = instance
  return instance
}

// ---------------------------------------------------------------------------
// SVG sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitizes SVG bytes. Returns the cleaned SVG as a Buffer, or `null` if the
 * input is not usable SVG (empty after sanitization, or no <svg> survived) so
 * the caller can reject the upload.
 *
 * Forbidden / stripped:
 *   - <script> (active code)
 *   - <foreignObject> (HTML/script injection surface inside SVG)
 *   - all on* event-handler attributes (onload, onclick, …)
 *   - href / xlink:href values that aren't `#fragment` or `data:image/…`
 *     (blocks `javascript:` and external-document refs)
 *
 * Note on <use>: DOMPurify's default SVG profile already drops <use> (it's an
 * external-reference / billion-laughs amplification vector). We deliberately do
 * NOT re-allow it — internal-only `<use>` is uncommon enough in uploaded art
 * that the safety win outweighs the loss.
 */
export function sanitizeSvg(bytes: Buffer): Buffer | null {
  const input = bytes.toString('utf8')
  if (input.trim() === '') return null

  const clean = domPurify().sanitize(input, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Belt over the hook: forbid these outright even if a profile would allow.
    FORBID_TAGS: ['script', 'foreignObject'],
    // on* handlers are dropped by the profile, but name them explicitly so the
    // intent is auditable and a profile change can't silently re-admit them.
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onbegin', 'onend'],
  })

  const trimmed = clean.trim()
  // Reject if nothing meaningful survived — an SVG that sanitizes down to empty
  // or loses its root <svg> is either malformed or was pure payload.
  if (trimmed === '' || !/<svg[\s>]/i.test(trimmed)) return null

  return Buffer.from(trimmed, 'utf8')
}

// ---------------------------------------------------------------------------
// SVG sniffing (declared-MIME-independent)
// ---------------------------------------------------------------------------

/**
 * Sniffs whether the leading bytes look like SVG/XML, regardless of the
 * declared MIME. Catches a `.png`/`image/png`-renamed SVG so it still gets
 * routed through `sanitizeSvg`. Scans only the first ~1 KB.
 */
export function sniffIsSvg(bytes: Buffer): boolean {
  // SVG can be preceded by a UTF-8 BOM, an XML prolog, a DOCTYPE, comments, or
  // whitespace before the root <svg>. A simple substring scan of the head is
  // robust enough and cheap.
  const head = bytes.subarray(0, 1024).toString('utf8').toLowerCase()
  if (head.includes('<svg')) return true
  // `<?xml ...?>` prolog followed (within the window) by svg, or a standalone
  // xml declaration where the <svg> is just past our window — treat an xml
  // prolog as SVG-suspect so we sanitize rather than store raw active XML.
  if (head.includes('<?xml')) return true
  return false
}

// ---------------------------------------------------------------------------
// Raster magic-byte validation
// ---------------------------------------------------------------------------

/**
 * Returns true if `bytes` carries a signature consistent with `declaredMime`.
 * Only the raster formats we accept are checked; anything else returns true
 * (not our concern here — SVG/XML is handled by the sniff+sanitize path, and
 * fonts/video/pptx have their own validation downstream).
 */
export function magicBytesMatch(declaredMime: string, bytes: Buffer): boolean {
  const mime = declaredMime.toLowerCase()
  switch (mime) {
    case 'image/png':
      // 89 50 4E 47 0D 0A 1A 0A
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      )
    case 'image/jpeg':
    case 'image/jpg':
      // FF D8 FF
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'image/gif':
      // "GIF87a" or "GIF89a"
      return (
        bytes.length >= 6 &&
        bytes.subarray(0, 4).toString('latin1') === 'GIF8' &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
      )
    case 'image/webp':
      // "RIFF" .... "WEBP"
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
        bytes.subarray(8, 12).toString('latin1') === 'WEBP'
      )
    case 'image/avif':
      // ISO-BMFF: bytes 4..8 = "ftyp", brand (bytes 8..12) is avif/avis (and
      // some encoders emit mif1/msf1 with avif in the compatible-brand list).
      if (bytes.length < 12 || bytes.subarray(4, 8).toString('latin1') !== 'ftyp') return false
      {
        const brandWindow = bytes.subarray(8, Math.min(bytes.length, 64)).toString('latin1')
        return /avif|avis|mif1|msf1/.test(brandWindow)
      }
    default:
      // Not a format we magic-check here.
      return true
  }
}

/** The set of declared MIME types `magicBytesMatch` meaningfully validates. */
export const MAGIC_CHECKED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
])
