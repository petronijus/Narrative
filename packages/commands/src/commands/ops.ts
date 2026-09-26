/**
 * commands/src/commands/ops.ts — `ops.apply`, the batch command agents use
 * most: many document edits as one atomic change and one undo step.
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import type { CommandRegistry } from '../registry.js'
import { runBatch } from '../run.js'

export function createOpsApply(registry: CommandRegistry) {
  return defineCommand({
    id: 'ops.apply',
    domain: 'ops',
    title: 'Apply several edits at once',
    description:
      'Run a list of document commands on one deck as ONE change: collaborators receive one update and it is ' +
      'one step to revert. With `atomic: true` (default) either every op succeeds or nothing changes — all inputs ' +
      'are validated first, then the ops run in order, each seeing the result of the previous ones. ' +
      'With `atomic: false` failing ops are reported in `results` and skipped. Only commands that edit the deck ' +
      'document can be batched (not export, share, media upload or other server-side commands). ' +
      'Prefer this over many single calls whenever you make more than one edit.',
    input: z
      .object({
        ops: z
          .array(z.object({ command: z.string().min(1), input: z.unknown() }).strict())
          .min(1)
          .max(500),
        atomic: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ results: z.array(z.unknown()) }),
    role: 'editor',
    effects: ['doc'],
    undo: 'undoable',
    confirm: 'never',
    hosts: ['browser', 'server'],
    transaction: 'self',
    implementedWith: [],
    examples: [
      {
        title: 'Add a slide and rename it in one step',
        input: {
          ops: [
            { command: 'slide.add', input: {} },
            { command: 'slide.rename', input: { slide: { index: 3 }, name: 'Summary' } },
          ],
        },
      },
    ],
    handler(ctx, input) {
      const ops = input.ops.map((op) => ({ command: op.command, input: op.input }))
      return runBatch(
        registry,
        ctx,
        ops,
        input.atomic === undefined ? {} : { atomic: input.atomic },
      )
    },
  })
}
