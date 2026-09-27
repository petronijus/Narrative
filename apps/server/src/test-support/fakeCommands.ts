/**
 * test-support/fakeCommands.ts — the default registry plus commands that
 * exist only in tests, for host behaviour the real commands cannot show
 * without a database:
 *   share.fakeRevoke  an irreversible, confirm-always deck command that
 *                     succeeds without any service (confirmation paths);
 *   deck.fakeCrash    a command whose handler throws an internal error
 *                     carrying infrastructure details (error sanitising);
 *   media.fakeFetch   a deck command taking the shared file source, which
 *                     downloads a `{ url }` through the real SSRF guard
 *                     (URL-fetch confirmation, the fetch audit and the
 *                     allowlist's redirect rule). Tests point every host at
 *                     a local server with `setFakeFetchNetwork`.
 * Excluded from the build (tsconfig.build.json: src/test-support/**).
 */

import { z } from 'zod'
import {
  CommandError,
  FileSourceSchema,
  createDefaultRegistry,
  defineCommand,
  urlFetchConfirmation,
  type CommandRegistry,
} from '@narrative/commands'
import { UnsafeUrlError, guardedFetch } from '../net/ssrfGuard.js'

export const FAKE_INTERNAL_DETAIL = 'relation "secret_table" does not exist (host 10.0.0.5:5432)'

export const fakeRevoke = defineCommand({
  id: 'share.fakeRevoke',
  domain: 'share',
  title: 'Revoke a fake share',
  description:
    'Test-only irreversible command: revokes nothing, but needs confirmation like share.links.revoke.',
  input: z.strictObject({ linkId: z.string().min(1) }),
  output: z.object({ revoked: z.string() }),
  role: 'editor',
  scope: 'deck',
  effects: ['server'],
  undo: 'irreversible',
  confirm: 'always',
  hosts: ['server'],
  implementedWith: [],
  examples: [{ title: 'Revoke link l1', input: { linkId: 'l1' } }],
  handler(_ctx, input) {
    return { revoked: input.linkId }
  },
})

export const fakeCrash = defineCommand({
  id: 'deck.fakeCrash',
  domain: 'deck',
  title: 'Crash',
  description: 'Test-only command whose handler fails with an internal database error message.',
  input: z.strictObject({}),
  output: z.object({}),
  role: 'viewer',
  scope: 'user',
  effects: ['server'],
  undo: 'n/a',
  confirm: 'never',
  hosts: ['server'],
  implementedWith: [],
  examples: [{ title: 'Crash', input: {} }],
  handler() {
    throw new Error(FAKE_INTERNAL_DETAIL)
  },
})

/** Where `media.fakeFetch` really connects: every hostname resolves to 127.0.0.1:<port>. */
let fakeFetchPort: number | null = null

export function setFakeFetchNetwork(port: number | null): void {
  fakeFetchPort = port
}

export const fakeFetch = defineCommand({
  id: 'media.fakeFetch',
  domain: 'media',
  title: 'Fetch a fake file',
  description:
    'Test-only command: downloads the file (a URL goes through the SSRF guard) and returns its size.',
  input: z.strictObject({ file: FileSourceSchema }),
  output: z.object({ bytes: z.number(), finalUrl: z.string().nullable() }),
  role: 'editor',
  scope: 'deck',
  effects: ['server'],
  undo: 'undoable',
  undoneBy: 'media.delete',
  confirm: 'never',
  confirmWhen: urlFetchConfirmation((input) => [input.file]),
  hosts: ['server'],
  implementedWith: [],
  examples: [{ title: 'Fetch a file', input: { file: { url: 'https://files.example/a.png' } } }],
  async handler(_ctx, input) {
    if (!('url' in input.file)) return { bytes: input.file.base64.length, finalUrl: null }
    const port = fakeFetchPort
    if (port === null) throw new Error('setFakeFetchNetwork was not called')
    try {
      const res = await guardedFetch(input.file.url, {
        maxBytes: 1024,
        allowedPorts: [port],
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        isAllowedAddress: () => true,
      })
      return { bytes: res.bytes.length, finalUrl: res.finalUrl }
    } catch (e) {
      // As the real services map it (services/binarySource.ts).
      if (e instanceof UnsafeUrlError)
        throw new CommandError('invalid_input', `URL not allowed: ${e.message}`)
      throw e
    }
  },
})

export function registryWithFakes(): CommandRegistry {
  return createDefaultRegistry().register(fakeRevoke).register(fakeCrash).register(fakeFetch)
}
