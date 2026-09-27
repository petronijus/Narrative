/**
 * net/fetchAudit.ts — which hosts an agent command made the server contact,
 * and which it may contact, without threading a parameter through every
 * service between the command and the SSRF guard.
 *
 * Why
 * ---
 * A command that takes a `{ url }` file source (media.upload,
 * folder.fonts.upload, deck.importPptx, deck.insertFrom) makes the server
 * fetch a URL the model chose. The URL itself is an exfiltration channel —
 * its path and query can carry anything the model read — so:
 *   - the audit log records every host actually contacted, the requested
 *     one and each redirect hop (`agent_ops.fetched_hosts`, migration 0023);
 *   - when a fetch ran WITHOUT the user confirming its host, because the host
 *     is on the operator's allowlist (AGENT_URL_FETCH_ALLOWED_HOSTS), a
 *     redirect may only lead to another allowlisted host. Otherwise an open
 *     redirect on a trusted host (`https://trusted/redirect?to=https://evil/?data`)
 *     would carry the data past the allowlist without anyone being asked.
 *     When the user confirmed the host, redirects are the confirmed host's
 *     own doing and are followed as usual (still under every SSRF rule).
 *
 * How
 * ---
 * The server host runs each agent invocation inside `runWithFetchAudit`
 * (an AsyncLocalStorage scope); the SSRF guard calls `beforeFetchHop` for
 * every hop it is about to request. Outside a scope (browser uploads, the
 * OAuth client-metadata fetch) both are no-ops.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface FetchAuditPolicy {
  /**
   * When set, every hop must go to one of these hostnames (lower-case, no
   * port) — the allowlisted-without-confirmation case in the header.
   */
  restrictToHostnames?: ReadonlySet<string>
}

interface FetchAuditScope {
  hosts: string[]
  policy: FetchAuditPolicy
}

const storage = new AsyncLocalStorage<FetchAuditScope>()

/**
 * Run `fn` in an audit scope. Resolves to its result and the hosts every
 * guarded fetch inside it contacted (in order, without repeats) — also when
 * `fn` throws, through `onSettled`, so a failed download is still audited.
 */
export async function runWithFetchAudit<T>(
  policy: FetchAuditPolicy,
  fn: () => Promise<T>,
  onSettled: (hosts: readonly string[]) => void,
): Promise<T> {
  const scope: FetchAuditScope = { hosts: [], policy }
  try {
    return await storage.run(scope, fn)
  } finally {
    onSettled([...scope.hosts])
  }
}

/**
 * Called by the SSRF guard before it requests `url` (the first hop and each
 * redirect). Records the host, or returns why the scope's policy refuses it
 * (the guard then throws its UnsafeUrlError with that reason, so callers map
 * it like any other refused address). Null = go ahead.
 */
export function beforeFetchHop(url: URL): string | null {
  const scope = storage.getStore()
  if (scope === undefined) return null
  const host = url.host.toLowerCase()
  const allowed = scope.policy.restrictToHostnames
  if (allowed !== undefined && !allowed.has(url.hostname.toLowerCase())) {
    return (
      `it leads to ${host}, which is not on the hosts allowed without confirmation; ` +
      'call again so the user can confirm the download'
    )
  }
  if (!scope.hosts.includes(host)) scope.hosts.push(host)
  return null
}
