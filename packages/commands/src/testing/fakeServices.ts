/**
 * commands/src/testing/fakeServices.ts — an in-memory `ServerServices` for
 * the command tests, so commands with the `server` effect run their
 * examples in the contract suite exactly like document commands do: the
 * examples call these fakes, and the output is validated against the
 * command's schema.
 *
 * The fakes model the fixture world, not the server's behaviour: the fixture
 * deck is `FIXTURE_DECK_ID`, it has one agent run `FIXTURE_RUN_ID` (runs are
 * kept per document, so a component master has its own), and the
 * calling user has one editor tab open on slide `s1` with `r1` selected.
 * Real behaviour (authorisation, Hocuspocus, Postgres) is tested in
 * apps/server against the real implementations.
 *
 * The runs and editor fakes live here; decks, folders, sharing, media,
 * components, PowerPoint and tokens in ./fakeDomainServices.ts. Every
 * domain has a fake, so every server command's examples run in the
 * contract suite; a new service method must get one too (the typecheck
 * insists, since the fakes implement the service interfaces).
 */

import type { ServerServices } from '../services.js'
import type {
  AgentRunService,
  AgentRunSummary,
  RevertRunResult,
  RunDocument,
} from '../services/runs.js'
import type { EditorService, EditorShowArgs, OpenEditorState } from '../services/editor.js'
import { CommandError } from '../errors.js'
import { createDomainFakes } from './fakeDomainServices.js'

export const FIXTURE_DECK_ID = 'deck_fixture'
export const FIXTURE_FOLDER_ID = 'folder_fixture'
export const FIXTURE_RUN_ID = 'run_fixture'
/** The fixture folder's component master (fakeDomainServices.ts seeds it). */
export const FIXTURE_COMPONENT_ID = 'cmp_headline'
export const FIXTURE_APP_ORIGIN = 'https://narrative.test'

export interface ServiceCall {
  service: keyof ServerServices
  method: string
  args: unknown
}

export interface FakeServices extends ServerServices {
  /** Every call the fakes received, in order. */
  readonly calls: ServiceCall[]
  /** A deep copy of the fakes' state (runs and every domain), for before/after comparisons. */
  snapshot(): Record<string, unknown>
}

function fixtureRun(): AgentRunSummary {
  return {
    id: FIXTURE_RUN_ID,
    userId: 'u1',
    userName: 'Fixture User',
    surface: 'mcp',
    clientName: 'claude-code',
    request: 'Shorten slide 3',
    status: 'open',
    createdAt: '2026-09-26T10:00:00.000Z',
    lastActivityAt: '2026-09-26T10:05:00.000Z',
    revertedAt: null,
    revertedBy: null,
    opCount: 4,
    changeCount: 3,
    revertibleChanges: 3,
    revertible: true,
    notRevertibleReason: null,
  }
}

function documentKey(target: RunDocument): string {
  return target.kind === 'deck' ? `deck:${target.deckId}` : `component:${target.componentId}`
}

function fakeRuns(
  record: (method: string, args: unknown) => void,
): AgentRunService & { snapshot(): unknown } {
  /** Runs by id, each with the document it works on. */
  const runs = new Map<string, { summary: AgentRunSummary; document: string }>([
    [
      FIXTURE_RUN_ID,
      { summary: fixtureRun(), document: documentKey({ kind: 'deck', deckId: FIXTURE_DECK_ID }) },
    ],
  ])
  let nextRun = 1
  return {
    snapshot: () => structuredClone({ runs: [...runs], nextRun }),
    async startRun(args) {
      record('startRun', args)
      const runId = `run_${nextRun++}`
      runs.set(runId, {
        summary: { ...fixtureRun(), id: runId, request: args.request, opCount: 0, changeCount: 0 },
        document: documentKey(args.target),
      })
      return { runId }
    },
    async listRuns(args) {
      record('listRuns', args)
      const key = documentKey(args.target)
      return [...runs.values()]
        .filter((r) => r.document === key)
        .map((r) => r.summary)
        .slice(0, args.limit)
    },
    async revertRun(args): Promise<RevertRunResult> {
      record('revertRun', args)
      const entry = runs.get(args.runId)
      if (entry === undefined || entry.document !== documentKey(args.target)) {
        throw new CommandError('not_found', `run '${args.runId}' does not exist on this document`)
      }
      const run = entry.summary
      if (!run.revertible) {
        throw new CommandError('conflict', `run '${args.runId}' can no longer be reverted`)
      }
      const reverted = Math.min(args.lastOps ?? run.revertibleChanges, run.revertibleChanges)
      const remaining = run.revertibleChanges - reverted
      return {
        runId: run.id,
        revertedChanges: reverted,
        remainingChanges: remaining,
        status: remaining === 0 ? 'reverted' : run.status,
      }
    },
  }
}

function fakeEditor(record: (method: string, args: unknown) => void): EditorService {
  const tab: OpenEditorState = {
    activeSlideId: 's1',
    activeSlideIndex: 0,
    selectedObjectIds: ['r1'],
    lastActiveAt: '2026-09-26T10:05:00.000Z',
  }
  return {
    async context(args) {
      record('context', args)
      return args.deckId === FIXTURE_DECK_ID && args.userId === 'u1' ? [tab] : []
    },
    async show(args: EditorShowArgs) {
      record('show', args)
      return { delivered: args.deckId === FIXTURE_DECK_ID && args.userId === 'u1' ? 1 : 0 }
    },
    presentUrl(args) {
      record('presentUrl', args)
      return `${FIXTURE_APP_ORIGIN}/deck/${encodeURIComponent(args.deckId)}/present?slide=${args.slideNumber}`
    },
  }
}

/** Fresh fakes (with their own call log) per test. */
export function createFakeServices(): FakeServices {
  const calls: ServiceCall[] = []
  const recorder =
    (service: keyof ServerServices) =>
    (method: string, args: unknown): void => {
      calls.push({ service, method, args })
    }
  const runs = fakeRuns(recorder('runs'))
  // decks, folders, sharing, media, components, pptx, tokens: ./fakeDomainServices.ts
  const { snapshot: domainSnapshot, ...domain } = createDomainFakes(
    { deckId: FIXTURE_DECK_ID, folderId: FIXTURE_FOLDER_ID, userId: 'u1' },
    recorder,
  )
  return {
    calls,
    runs,
    editor: fakeEditor(recorder('editor')),
    ...domain,
    snapshot: () => ({ runs: runs.snapshot(), ...domainSnapshot() }),
  }
}
