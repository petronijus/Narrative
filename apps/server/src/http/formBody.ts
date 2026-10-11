/**
 * http/formBody.ts
 *
 * A strict `application/x-www-form-urlencoded` parser for the routes that
 * take credentials in a form body (the MCP OAuth endpoints, the desktop
 * sign-in redeem). The root instance maps that type to a passthrough stream
 * for tus (media/tus.ts), so such routes live in their own scope and install
 * this parser there.
 */

/**
 * Parse a form body. Parameters must not repeat (RFC 6749 §3.1): a request
 * that sends one twice is refused (400) rather than silently resolved.
 */
export function parseStrictForm(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(body)) {
    if (Object.hasOwn(out, key)) {
      const err = new Error(`parameter ${key} is repeated`) as Error & { statusCode: number }
      err.statusCode = 400
      throw err
    }
    out[key] = value
  }
  return out
}
