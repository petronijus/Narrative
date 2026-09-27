/**
 * tests/agent-eval/lib/types.ts — the contracts of the agent eval suite.
 *
 * A scenario is data plus three functions: `setup` builds a fixture through
 * a `World`, `steps` are the user's prompts, `grade` reads the resulting
 * document back through the same `World` and checks it deterministically.
 * The same scenario runs in two worlds:
 *
 *   - the live world (lib/liveWorld.ts): the local dev stack, driven over the
 *     public command API, with headless Claude Code as the agent;
 *   - the memory world (lib/memoryWorld.ts): the command registry on
 *     in-memory Yjs documents, with a recorded transcript replayed as the
 *     agent (lib/replay.ts) — the free smoke subset `pnpm -r test` runs.
 *
 * Graders must therefore only use `World` methods, never HTTP or the
 * registry directly.
 */

/** What a command acts on (the `target` of `POST /commands`). */
export interface EvalTarget {
  deckId?: string
  componentId?: string
  folderId?: string
}

/** A command failure, as the command API / MCP reports it. */
export class EvalCommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: string,
    message: string,
  ) {
    super(`${command} failed (${code}): ${message}`)
    this.name = 'EvalCommandError'
  }
}

/** A world cannot do what a scenario needs (e.g. no browser in memory). */
export class UnsupportedInWorld extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedInWorld'
  }
}

/** A scenario cannot run in this environment; the runner reports it as skipped. */
export class SkipScenario extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'SkipScenario'
  }
}

export interface OpenEditorOptions {
  /** The slide the user is looking at. */
  slideId: string
  /** What the user has selected on it. */
  selectedObjectIds: string[]
}

export interface World {
  readonly kind: 'live' | 'memory'
  /** Short unique tag of this suite run; scenarios put it in titles so names never collide. */
  readonly tag: string
  /** The folder fixture decks are created in (deleted as a whole at the end of a live run). */
  readonly evalFolderId: string

  /** Run one command. Irreversible commands need their id in `confirm`. Throws EvalCommandError. */
  run<T = Record<string, unknown>>(
    target: EvalTarget,
    command: string,
    input?: unknown,
    options?: { confirm?: string[] },
  ): Promise<T>
  /** Run several document commands as one atomic change (`ops.apply`); returns each op's result. */
  batch(
    target: EvalTarget,
    ops: ReadonlyArray<{ command: string; input: unknown }>,
  ): Promise<unknown[]>

  /** A new deck (one empty slide) in `folderId`, default the eval folder. */
  createDeck(title: string, folderId?: string): Promise<{ deckId: string; firstSlideId: string }>
  /** A new folder, deleted with everything in it when the run cleans up. */
  createFolder(name: string): Promise<string>
  /** Upload an image to a deck; returns its asset id. */
  uploadImage(deckId: string, png: Uint8Array, filename: string): Promise<string>
  /**
   * An empty component in a folder (its master has no slide yet). There is
   * no agent command for it before A4 (`component.create`); the live world
   * uses the web app's REST route, which needs the BYPASS_AUTH dev session.
   */
  createComponent(folderId: string, name: string): Promise<string>
  /** Make the user's editor show `slideId` with `selectedObjectIds` selected (what editor.context reads). */
  openEditor(deckId: string, options: OpenEditorOptions): Promise<void>
  /** Download a URL (export links). Live only. */
  fetchBinary(url: string): Promise<Uint8Array>
}

/** One tool call the agent made, parsed from the transcript. */
export interface ToolCall {
  /** The MCP tool name without the `mcp__<server>__` prefix (`slide_duplicate`), or a built-in tool name. */
  tool: string
  /** The Narrative command id (`slide.duplicate`), or null for non-Narrative tools (resource reads). */
  command: string | null
  input: Record<string, unknown>
  isError: boolean
  /** The error code for Narrative errors (`not_found`, `confirmation_required`, …). */
  errorCode: string | null
  /** The command's output (parsed JSON) for successful Narrative calls, else null. */
  result: unknown
  /** The raw text the model saw, truncated. */
  text: string
}

/** One user message and what the agent did with it. */
export interface TranscriptStep {
  prompt: string
  calls: ToolCall[]
  /** The agent's final answer to this message. */
  finalText: string
  turns: number
  isError: boolean
  /** Why the step ended (`success`, `error_max_turns`, `timeout`, …). */
  stopReason: string
}

export interface Transcript {
  steps: TranscriptStep[]
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface Check {
  name: string
  pass: boolean
  detail?: string
}

export interface Grade {
  pass: boolean
  checks: Check[]
}

/** Values a scenario keeps between its hooks (snapshots between steps, …). Never recorded. */
export type Notes = Record<string, unknown>

export interface GradeContext<F> {
  world: World
  fixture: F
  transcript: Transcript
  notes: Notes
}

export type Requirement = 'browser' | 'componentRoute' | 'binaryFetch'

/**
 * A fixture must be plain JSON (ids, names, titles): recordings store it,
 * and replay rebinds the recorded ids to the ones the memory world created
 * by walking the two fixtures side by side (lib/replay.ts).
 */
export type Fixture = object

export interface Scenario<F extends Fixture = Fixture> {
  /** kebab-case, unique; the recording file name. */
  id: string
  /** One line for the report. */
  title: string
  /** The command ids this scenario is about (the parity agent checks new commands get one). */
  covers: readonly string[]
  /** `--max-turns` for each step. */
  maxTurns: number
  /** Wall-clock limit per step (default: lib/claude.ts DEFAULT_STEP_TIMEOUT_MS). */
  stepTimeoutMs?: number
  /** Capabilities of the live environment the scenario needs; missing ones skip it. */
  requires?: readonly Requirement[]
  /**
   * Whether the scenario's recording can be replayed in the memory world
   * (`true`), or why not. Scenarios that lean on server features the memory
   * world does not model (PPTX export, cross-deck copies, components) are
   * live-only.
   */
  replay: true | { reason: string }
  setup(world: World): Promise<F>
  /** After setup, before the first prompt (e.g. open the editor). */
  prepare?(world: World, fixture: F, notes: Notes): Promise<void>
  /** The user's messages, sent one after another in one conversation. */
  steps(fixture: F): readonly string[]
  /** Between steps (after step `index` finished, before the next is sent). */
  afterStep?(world: World, fixture: F, index: number, notes: Notes): Promise<void>
  grade(ctx: GradeContext<F>): Promise<Grade>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a heterogeneous scenario list
export type AnyScenario = Scenario<any>

/** Define a scenario with its fixture type inferred from `setup`. */
export function defineScenario<F extends Fixture>(scenario: Scenario<F>): Scenario<F> {
  return scenario
}
