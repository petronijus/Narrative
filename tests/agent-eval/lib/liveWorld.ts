/**
 * tests/agent-eval/lib/liveWorld.ts — the World on the local dev stack.
 *
 * Everything goes through the public command API (`POST /commands`, the
 * surface scripts use) with a personal access token of scope `api`; the
 * agent gets its own token of scope `mcp` (lib/claude.ts). Two exceptions,
 * both because no command exists for them:
 *   - access tokens are minted and revoked through `/access-tokens`, which
 *     only a browser session may call — in the BYPASS_AUTH dev stack a
 *     request without credentials is that session (the synthetic dev
 *     user); otherwise pass tokens in NARRATIVE_EVAL_API_TOKEN /
 *     NARRATIVE_EVAL_MCP_TOKEN;
 *   - an empty component is created through the web app's REST route
 *     (`POST /folders/:id/components`) until A4 adds `component.create`.
 *
 * Cleanup: every fixture lives in folders this world created; deleting the
 * folders (`folder.delete`, confirmed explicitly) removes their decks,
 * components and media.
 */

import { EditorBrowser } from './browser.js'
import {
  EvalCommandError,
  SkipScenario,
  type EvalTarget,
  type OpenEditorOptions,
  type Person,
  type World,
} from './types.js'

export const DEFAULT_API_URL = 'http://localhost:3001'
export const DEFAULT_WEB_URL = 'http://localhost:5173'
const CLIENT_NAME = 'agent-eval'
const EDITOR_CONTEXT_TIMEOUT_MS = 20_000

/** The dev stack is not reachable (stopped, or restarting under `tsx watch`). */
export class InfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'InfraError'
  }
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    throw new InfraError(`${init.method ?? 'GET'} ${url} failed: ${(err as Error).message}`, {
      cause: err,
    })
  }
}

/** Wait until the API answers `/health` (after a server restart). */
export async function waitForHealth(apiUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/health`)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export interface MintedToken {
  id: string
  /** The secret. Never logged, never written to disk. */
  token: string
}

/** Is the dev stack in BYPASS_AUTH mode (a credential-less request is the dev user's session)? */
export async function isBypassAuth(apiUrl: string): Promise<boolean> {
  const res = await request(`${apiUrl}/access-tokens`, { method: 'GET' })
  return res.ok
}

export async function mintToken(
  apiUrl: string,
  name: string,
  scopes: string[],
): Promise<MintedToken> {
  const res = await request(`${apiUrl}/access-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, scopes, expiresInDays: 30 }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    token?: string
    accessToken?: { id?: string }
    error?: string
    message?: string
  }
  if (!res.ok || typeof body.token !== 'string' || typeof body.accessToken?.id !== 'string') {
    throw new Error(
      `could not create an access token (${res.status} ${body.error ?? ''} ${body.message ?? ''}). ` +
        'Creating tokens needs the BYPASS_AUTH dev stack; otherwise create one `api` and one `mcp` token ' +
        'in Narrative (account menu > Access tokens) and pass them as NARRATIVE_EVAL_API_TOKEN / NARRATIVE_EVAL_MCP_TOKEN.',
    )
  }
  return { id: body.accessToken.id, token: body.token }
}

export async function revokeToken(apiUrl: string, id: string): Promise<boolean> {
  const res = await request(`${apiUrl}/access-tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  return res.status === 204 || res.status === 404
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface LiveWorldOptions {
  apiUrl: string
  webUrl: string
  apiToken: string
  tag: string
  /** BYPASS_AUTH dev stack: the REST routes a component and the browser need are open. */
  bypass: boolean
}

interface CommandResponse {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; issues?: unknown[] }
}

export class LiveWorld implements World {
  readonly kind = 'live' as const
  readonly tag: string
  evalFolderId = ''
  /** Folders this run created (the eval folder first). */
  readonly createdFolders: string[] = []
  /** Folders a second person created for a scenario (deleted as them). */
  private readonly foreignFolders: Array<{ person: Person; folderId: string }> = []
  private readonly browser: EditorBrowser

  constructor(private readonly opts: LiveWorldOptions) {
    this.tag = opts.tag
    this.browser = new EditorBrowser(opts.webUrl)
  }

  /** Create the run's eval folder. */
  async init(): Promise<void> {
    this.evalFolderId = await this.createFolder(`Agent eval ${this.tag}`)
  }

  /**
   * POST /commands as the harness (its `api` token) or, on the dev stack, as
   * a second person (their `narrative_dev_as` cookie; the session path of
   * the command API, which wants a same-origin request).
   */
  private async post(body: Record<string, unknown>, what: string, as?: Person): Promise<unknown> {
    const res = await request(`${this.opts.apiUrl}/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(as === undefined
          ? { authorization: `Bearer ${this.opts.apiToken}` }
          : { cookie: `narrative_dev_as=${as.userId}`, origin: this.opts.webUrl }),
      },
      body: JSON.stringify({ ...body, client: CLIENT_NAME }),
    })
    if (res.status === 502 || res.status === 503)
      throw new InfraError(`${what}: HTTP ${res.status}`)
    const parsed = (await res.json().catch(() => null)) as CommandResponse | null
    if (parsed === null)
      throw new EvalCommandError(what, 'failed', `HTTP ${res.status} without a JSON body`)
    if (!parsed.ok) {
      const issues = parsed.error?.issues?.length ? ` ${JSON.stringify(parsed.error.issues)}` : ''
      throw new EvalCommandError(
        what,
        parsed.error?.code ?? 'failed',
        `${parsed.error?.message ?? `HTTP ${res.status}`}${issues}`,
      )
    }
    return parsed.result
  }

  async run<T = Record<string, unknown>>(
    target: EvalTarget,
    command: string,
    input: unknown = {},
    options: { confirm?: string[] } = {},
  ): Promise<T> {
    return (await this.post(
      { target, command, input, ...(options.confirm ? { confirm: options.confirm } : {}) },
      command,
    )) as T
  }

  async person(name: string): Promise<Person> {
    const userId = `dev-eval-${name}`
    if (!this.opts.bypass || !/^dev-[a-z0-9-]{1,60}$/.test(userId)) {
      throw new SkipScenario(
        'a second person needs the BYPASS_AUTH dev stack (a synthetic identity, auth/devIdentity.ts)',
      )
    }
    // Their first request writes their directory entry, as a first sign-in would.
    const res = await request(`${this.opts.apiUrl}/folders`, {
      headers: { cookie: `narrative_dev_as=${userId}` },
    })
    if (!res.ok) throw new Error(`GET /folders as ${userId}: HTTP ${res.status}`)
    return { userId, email: `${userId}@dev.narrative.test` }
  }

  async userEmail(): Promise<string> {
    if (!this.opts.bypass) {
      throw new SkipScenario("the agent's user address is known only on the BYPASS_AUTH dev stack")
    }
    // The harness mints its tokens as BYPASS_AUTH's dev-user (see "What a run does").
    return 'dev-user@dev.narrative.test'
  }

  async runAs<T = Record<string, unknown>>(
    person: Person,
    target: EvalTarget,
    command: string,
    input: unknown = {},
    options: { confirm?: string[] } = {},
  ): Promise<T> {
    return (await this.post(
      { target, command, input, ...(options.confirm ? { confirm: options.confirm } : {}) },
      `${command} as ${person.userId}`,
      person,
    )) as T
  }

  async createFolderAs(person: Person, name: string): Promise<string> {
    const folder = await this.runAs<{ id: string }>(person, {}, 'folder.create', { name })
    this.foreignFolders.push({ person, folderId: folder.id })
    return folder.id
  }

  async batch(
    target: EvalTarget,
    ops: ReadonlyArray<{ command: string; input: unknown }>,
  ): Promise<unknown[]> {
    const result = (await this.post({ target, ops, atomic: true }, 'ops.apply')) as {
      results: unknown[]
    }
    return result.results
  }

  async createDeck(
    title: string,
    folderId?: string,
  ): Promise<{ deckId: string; firstSlideId: string }> {
    const deck = await this.run<{ id: string; firstSlideId: string }>({}, 'deck.create', {
      title,
      folderId: folderId ?? this.evalFolderId,
    })
    return { deckId: deck.id, firstSlideId: deck.firstSlideId }
  }

  async createFolder(name: string): Promise<string> {
    const folder = await this.run<{ id: string }>({}, 'folder.create', { name })
    this.createdFolders.push(folder.id)
    return folder.id
  }

  async uploadImage(deckId: string, png: Uint8Array, filename: string): Promise<string> {
    const out = await this.run<{ assetId: string }>({ deckId }, 'media.upload', {
      file: { base64: Buffer.from(png).toString('base64'), filename },
    })
    return out.assetId
  }

  async createComponent(folderId: string, name: string): Promise<string> {
    if (!this.opts.bypass) {
      throw new SkipScenario(
        'creating a component needs the web app REST route, which needs the BYPASS_AUTH dev session (component.create arrives in A4)',
      )
    }
    const res = await request(
      `${this.opts.apiUrl}/folders/${encodeURIComponent(folderId)}/components`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    )
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
    if (res.status !== 201 || typeof body.id !== 'string') {
      throw new Error(`creating the component failed: HTTP ${res.status} ${body.error ?? ''}`)
    }
    return body.id
  }

  async openEditor(deckId: string, options: OpenEditorOptions): Promise<void> {
    if (!this.opts.bypass) {
      throw new SkipScenario(
        'opening the editor headlessly needs the BYPASS_AUTH dev web app (no sign-in)',
      )
    }
    await this.browser.open(deckId, options.slideId, options.selectedObjectIds)
    // The editor publishes its slide and selection through awareness; wait
    // until the server reads the same, or the agent would race the tab.
    const deadline = Date.now() + EDITOR_CONTEXT_TIMEOUT_MS
    let last: unknown = null
    while (Date.now() < deadline) {
      last = await this.run<{ activeSlideId: string | null; selectedObjectIds: string[] }>(
        { deckId },
        'editor.context',
        {},
      )
      const ctx = last as { activeSlideId: string | null; selectedObjectIds: string[] }
      if (
        ctx.activeSlideId === options.slideId &&
        ctx.selectedObjectIds.length === options.selectedObjectIds.length &&
        options.selectedObjectIds.every((id) => ctx.selectedObjectIds.includes(id))
      ) {
        return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error(
      `the server never saw the editor state (last editor.context: ${JSON.stringify(last)})`,
    )
  }

  async fetchBinary(url: string): Promise<Uint8Array> {
    const res = await request(url, { method: 'GET' })
    if (!res.ok) throw new Error(`GET ${url.split('?')[0]} answered HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async approveConfirmation(confirmationId: string): Promise<void> {
    if (!this.opts.bypass) {
      throw new SkipScenario(
        "approving a confirmation needs the BYPASS_AUTH dev session (otherwise a person approves it on Narrative's page)",
      )
    }
    // No token: the confirmation routes take the browser session only, which
    // a request without credentials is under BYPASS_AUTH (the dev user).
    const res = await request(
      `${this.opts.apiUrl}/agent-confirmations/${encodeURIComponent(confirmationId)}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: this.opts.webUrl },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(`approving confirmation failed: HTTP ${res.status} ${body.error ?? ''}`)
    }
  }

  /** After each scenario: close its editor tabs. */
  async endScenario(): Promise<void> {
    await this.browser.closePages()
  }

  /**
   * Delete every folder this run created, with their decks, components and
   * media. Returns what could not be deleted (reported, never retried
   * silently).
   */
  async cleanup(): Promise<string[]> {
    await this.browser.close()
    const left: string[] = []
    for (const { person, folderId } of this.foreignFolders) {
      try {
        await this.runAs(person, { folderId }, 'folder.delete', {}, { confirm: ['folder.delete'] })
      } catch (err) {
        if (err instanceof EvalCommandError && err.code === 'not_found') continue
        left.push(`folder ${folderId} of ${person.userId}: ${(err as Error).message}`)
      }
    }
    for (const folderId of [...this.createdFolders].reverse()) {
      try {
        await this.run({ folderId }, 'folder.delete', {}, { confirm: ['folder.delete'] })
      } catch (err) {
        if (err instanceof EvalCommandError && err.code === 'not_found') continue
        left.push(`folder ${folderId}: ${(err as Error).message}`)
      }
    }
    return left
  }

  /** Decks outside the run's folders whose title carries the run tag (an agent created them elsewhere). */
  async strayDecks(): Promise<Array<{ id: string; title: string; folderId: string | null }>> {
    const out = await this.run<{
      decks: Array<{ id: string; title: string; folderId: string | null }>
    }>({}, 'deck.list', {
      query: this.tag,
      limit: 200,
    })
    return out.decks.filter((d) => d.folderId === null || !this.createdFolders.includes(d.folderId))
  }

  async deleteDeck(deckId: string): Promise<void> {
    await this.run({ deckId }, 'deck.delete', {}, { confirm: ['deck.delete'] })
  }
}
