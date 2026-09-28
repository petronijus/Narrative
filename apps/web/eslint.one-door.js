/**
 * apps/web/eslint.one-door.js — "one door" lint rule for the editor (ADR 0010).
 *
 * The editor changes the document only by dispatching commands through
 * `useCommand()` (the BrowserHost), so every gesture a user has is a
 * registered command an agent gets too. This module is the rule that keeps a
 * second door from opening:
 *
 *   - no import of a slide-model WRITER in `apps/web/src` (the list is the
 *     `writer` entries of the parity table, packages/commands/src/parity/
 *     slideModelExports.ts — a writer is banned here the moment it is
 *     classified, nobody maintains a second list);
 *   - no `.transact(…)` call: opening a transaction on a document is what a
 *     command runner does, not a component.
 *
 * Read-side exports (readers, subscriptions, origins, undo) stay allowed.
 *
 * Files the A2 extraction has not migrated yet are listed in
 * `ONE_DOOR_PENDING` with the step (docs/plans/a2-extraction.md) that
 * migrates them. The list only shrinks: `oneDoor.test.ts` fails when a listed
 * file no longer breaks the rule (take it off the list) or no longer exists.
 */

import { SLIDE_MODEL_EXPORTS } from '../../packages/commands/src/parity/slideModelExports.ts'

/** Every slide-model export classified as a document writer. */
export const SLIDE_MODEL_WRITERS = Object.entries(SLIDE_MODEL_EXPORTS)
  .filter(([, kind]) => kind === 'writer')
  .map(([name]) => name)
  .sort()

/** Where the rule applies (globs relative to the repository root). */
export const ONE_DOOR_FILES = ['apps/web/src/**/*.{ts,tsx}']

/** Tests may build fixtures with writers directly; they are not a door. */
export const ONE_DOOR_IGNORES = [
  'apps/web/src/**/*.{test,spec}.{ts,tsx}',
  'apps/web/src/**/__tests__/**',
  'apps/web/src/test/**',
]

export const ONE_DOOR_RULES = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: '@narrative/slide-model',
          importNames: SLIDE_MODEL_WRITERS,
          message:
            'The editor writes the document only through commands (ADR 0010): dispatch the command with ' +
            'useCommand() instead of calling the slide-model writer.',
        },
      ],
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='transact']",
      message:
        'Only the command runner opens document transactions (ADR 0010): dispatch a command with ' +
        'useCommand(), or several at once with its batch().',
    },
  ],
}

/**
 * Files not migrated yet, with the A2 step that migrates them. Paths are
 * relative to the repository root. Only ever remove entries.
 */
export const ONE_DOOR_PENDING = [
  // A2.4 moved object creation, delete, duplicate, group, layer, nudge and
  // the context menu's table / lock / mask actions onto commands. What each
  // file still writes directly, and the step that removes it:
  //   drag / resize writes (A2.5), the pen (A2.6), clipboard paste (A2.7)
  { file: 'apps/web/src/components/EditorLayout.tsx', step: 'A2.7' },
  //   clipboard paste
  { file: 'apps/web/src/ui/EditorContextMenu.tsx', step: 'A2.7' },
  //   component stamping
  { file: 'apps/web/src/ui/Toolbar.tsx', step: 'A2.12' },
  { file: 'apps/web/src/ui/UploadDropZone.tsx', step: 'A2.12' },
  //   text-style propagation to linked objects (moves server-side)
  { file: 'apps/web/src/components/DeckShell.tsx', step: 'A2.12' },
  //   re-exports the applyShapeMask writer; only the Inspector still uses it
  { file: 'apps/web/src/state/applyShapeMask.ts', step: 'A2.5' },
  // A2.5 — transforms
  { file: 'apps/web/src/ui/TransformHandles.tsx', step: 'A2.5' },
  { file: 'apps/web/src/ui/CropOverlay.tsx', step: 'A2.5' },
  { file: 'apps/web/src/ui/Inspector.tsx', step: 'A2.5' },
  // A2.6 — paths and lines
  { file: 'apps/web/src/ui/PathPointsOverlay.tsx', step: 'A2.6' },
  { file: 'apps/web/src/ui/LineEndpointHandles.tsx', step: 'A2.6' },
  // A2.9 — animation
  { file: 'apps/web/src/ui/AnimationTimeline.tsx', step: 'A2.9' },
  { file: 'apps/web/src/ui/MoveToTargetOverlay.tsx', step: 'A2.9' },
  // A2.10 — tables
  { file: 'apps/web/src/ui/TableChrome.tsx', step: 'A2.10' },
  { file: 'apps/web/src/ui/TableInspector.tsx', step: 'A2.10' },
  { file: 'apps/web/src/ui/TableCellEditor.tsx', step: 'A2.10' },
  // A2.11 — text
  { file: 'apps/web/src/ui/TextEditOverlay.tsx', step: 'A2.11' },
  { file: 'apps/web/src/ui/textEditSelection.ts', step: 'A2.11' },
  { file: 'apps/web/src/ui/textListOps.ts', step: 'A2.11' },
  // A2.12 — tokens, components, server propagation
  { file: 'apps/web/src/state/FolderDocProvider.tsx', step: 'A2.12' },
  { file: 'apps/web/src/state/writeComponentMasterTree.ts', step: 'A2.12' },
  // A2.13 — close: the dev/e2e test hooks go through commands too
  { file: 'apps/web/src/state/testApi.ts', step: 'A2.13' },
]
