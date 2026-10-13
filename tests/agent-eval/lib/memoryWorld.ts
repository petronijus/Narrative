/**
 * tests/agent-eval/lib/memoryWorld.ts — the World in memory: the real
 * command registry (`createDefaultRegistry`, `runCommand`) over in-memory
 * Yjs documents, with a small in-memory server behind the services the
 * replayable scenarios touch.
 *
 * What it models, and how closely:
 *   - decks, folders, deck.create / deck.list / folder.list — records in
 *     maps; a new deck is `createSlideDoc()` (one empty slide), as the
 *     server's `decks.create` seeds it;
 *   - runs — per (session, deck), opened by agent.startRun or automatically
 *     on the first write; every write of a run is tagged with
 *     `agentOrigin(runId)` and tracked by a `Y.UndoManager` on
 *     slides + guides, one stack item per command, which is how the server
 *     host implements per-run revert (apps/server/src/services/runs.ts);
 *   - agent.revert — undoes the run's last N (or all) stack items;
 *   - editor.context / editor.show — one fake tab whose state
 *     `openEditor` sets;
 *   - share links — a list per deck;
 *   - folder / deck font lists and folder component lists — always empty
 *     (nothing is ever uploaded or created there);
 *   - folder tokens — one folder document per folder, seeded with the
 *     default tokens when the folder is made (as the server does since
 *     A2.12); token.list / create / update / delete / seedDefaults through
 *     the same slide-model writers and field parsers as the server, and a
 *     token change carried into the folder's decks (`propagateTextStyles`,
 *     outside any run, as the server's propagation is);
 *   - folder style packs — in the folder document, set / update / delete
 *     through the same slide-model writers and parser as the server;
 *     compile writes the pack's tokens (component masters are not modelled:
 *     a layout draws a component's objects from the pack itself);
 *   - the ServerHost's confirmation gate — a `confirm: 'always'` command
 *     runs only with the harness's explicit `confirm: [id]` (like a script
 *     on POST /commands); an agent call is refused (`confirmation_required`,
 *     or `not_confirmed` with a `confirmationId`), because the memory world
 *     has no confirm page on which a person could approve it.
 * Everything else (media, PPTX, components, fonts, token usages, sharing by
 * email) throws `UnsupportedInWorld`: a recording that needs it is not
 * replayable, and the smoke test says so instead of faking an answer.
 *
 * Imports the commands package by relative path: the smoke test runs inside
 * packages/commands' vitest (whose aliases resolve @narrative/*), and the
 * live harness never loads this file.
 */

import * as Y from 'yjs'
import { z } from 'zod'
import {
  addFolderToken,
  agentOrigin,
  createSlideDoc,
  deleteFolderToken,
  deleteStylePack,
  hasNoTokens,
  mergeStylePackPatch,
  patchStylePack,
  readStylePack,
  setStylePack,
  migrateFolderTokens,
  readFolderTokens,
  seedDefaultTokens,
  updateFolderToken,
  type DeckMutationContext,
} from '@narrative/slide-model'
import {
  CommandError,
  InvalidTokenFields,
  parseNewTokenFields,
  parseTokenPatch,
  propagateTextStyles,
  stylesUsingColor,
  textStyleNameTaken,
  commandReadsFolderFonts,
  commandReadsFolderTokens,
  commandReadsStylePack,
  commandUsesDocument,
  compileStylePack,
  createDefaultRegistry,
  parseStylePack,
  previousOfUpdate,
  runCommand,
  type AgentRunSummary,
  type AnyCommandDef,
  type CommandContext,
  type CommandRegistry,
  type DeckWithRole,
  type FolderSummary,
  type OpenEditorState,
  type RunDocument,
  type ServerServices,
  type ShareLinkEntry,
} from '../../../packages/commands/src/index.js'
import type { StylePack } from '@narrative/shared'
import { createFakeServices } from '../../../packages/commands/src/testing/fakeServices.js'
import { splitToolArguments } from './mcpNames.js'
import {
  EvalCommandError,
  UnsupportedInWorld,
  type EvalTarget,
  type OpenEditorOptions,
  type Person,
  type World,
} from './types.js'

const USER_ID = 'eval-user'
const T0 = Date.parse('2026-09-27T10:00:00.000Z')
const HARNESS_SESSION = 'harness'
const AGENT_SESSION = 'agent'
const AUTOMATIC_RUN = '(automatic run)'
/** Origin of a token change carried into decks: no run's (the server's TOKEN_PROPAGATION_ORIGIN). */
const TOKEN_PROPAGATION = { kind: 'token-propagation' }

interface MemDeck {
  record: DeckWithRole
  doc: DeckMutationContext
}

interface MemRun {
  id: string
  deckId: string
  sessionKey: string
  request: string
  origin: unknown
  manager: Y.UndoManager
  status: 'open' | 'closed' | 'reverted'
  opCount: number
  changeCount: number
  createdAt: string
}

/** Every service method throws until the world overrides it with a model. */
function unsupportedServices(): ServerServices {
  const fake = createFakeServices() as unknown as Record<string, unknown>
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, service] of Object.entries(fake)) {
    if (typeof service !== 'object' || service === null || Array.isArray(service)) continue
    const wrapped: Record<string, unknown> = {}
    for (const method of Object.keys(service)) {
      wrapped[method] = () => {
        throw new UnsupportedInWorld(
          `services.${name}.${method} is not modelled by the memory world`,
        )
      }
    }
    out[name] = wrapped
  }
  return out as unknown as ServerServices
}

/** Top-level input keys of a command, from its JSON Schema (unions contribute every branch's keys). */
function schemaKeys(schema: unknown, into: Set<string>): void {
  if (typeof schema !== 'object' || schema === null) return
  const s = schema as Record<string, unknown>
  if (typeof s['properties'] === 'object' && s['properties'] !== null) {
    for (const k of Object.keys(s['properties'] as object)) into.add(k)
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(s[key])) for (const branch of s[key] as unknown[]) schemaKeys(branch, into)
  }
}

export interface MemoryWorldOptions {
  /** The live run's tag, so fixture titles and prompts match the recording. */
  tag: string
}

export class MemoryWorld implements World {
  readonly kind = 'memory' as const
  readonly tag: string
  readonly evalFolderId: string
  readonly registry: CommandRegistry = createDefaultRegistry()

  private readonly decks = new Map<string, MemDeck>()
  private readonly folders = new Map<string, FolderSummary>()
  /** Each folder's token document (`folder:<id>`). */
  private readonly folderDocs = new Map<string, Y.Doc>()
  private tokenCounter = 0
  private readonly links = new Map<string, ShareLinkEntry[]>()
  private readonly editors = new Map<string, OpenEditorState>()
  private readonly runs = new Map<string, MemRun>()
  private readonly currentRun = new Map<string, string>()
  private readonly keysCache = new Map<string, Set<string>>()
  private readonly services: ServerServices
  private readonly draftsId: string
  private counter = 0
  private clock = 0

  constructor(opts: MemoryWorldOptions) {
    this.tag = opts.tag
    this.services = this.buildServices()
    this.draftsId = this.addFolder('Drafts', true)
    this.evalFolderId = this.addFolder(`Agent eval ${opts.tag}`)
  }

  private nextId(prefix: string): string {
    this.counter++
    return `${prefix}_${this.counter}`
  }

  private now(): string {
    this.clock++
    return new Date(T0 + this.clock * 1000).toISOString()
  }

  private addFolder(name: string, isDrafts = false): string {
    const id = this.nextId('folder')
    this.folders.set(id, {
      id,
      name,
      createdAt: this.now(),
      deckCount: 0,
      role: 'owner',
      sharedBy: null,
      isDrafts,
    })
    // A new folder comes with the default tokens (services/folders.ts create).
    const doc = new Y.Doc()
    seedDefaultTokens(doc, () => this.newTokenId())
    this.folderDocs.set(id, doc)
    return id
  }

  private folderTokensOf(folderId: string | null) {
    const doc = folderId === null ? undefined : this.folderDocs.get(folderId)
    if (doc === undefined) return null
    const tokens = readFolderTokens(doc)
    return hasNoTokens(tokens) ? null : tokens
  }

  private newTokenId(): string {
    this.tokenCounter++
    return `tok_${this.tokenCounter}`
  }

  private folderDoc(folderId: string): Y.Doc {
    const doc = this.folderDocs.get(folderId)
    if (doc === undefined)
      throw new CommandError('not_found', `folder '${folderId}' does not exist`)
    return doc
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  private openRun(sessionKey: string, deckId: string, request: string): MemRun {
    const key = `${sessionKey}|${deckId}`
    const previous = this.currentRun.get(key)
    if (previous !== undefined) {
      const run = this.runs.get(previous)
      if (run !== undefined && run.status === 'open') run.status = 'closed'
    }
    const deck = this.decks.get(deckId)
    if (deck === undefined) throw new CommandError('not_found', `deck '${deckId}' does not exist`)
    const id = this.nextId('run')
    const origin = agentOrigin(id)
    const manager = new Y.UndoManager(
      [deck.doc.doc.getArray('slides'), deck.doc.doc.getArray('guides')],
      {
        trackedOrigins: new Set([origin]),
        captureTimeout: 0,
      },
    )
    const run: MemRun = {
      id,
      deckId,
      sessionKey,
      request,
      origin,
      manager,
      status: 'open',
      opCount: 0,
      changeCount: 0,
      createdAt: this.now(),
    }
    this.runs.set(id, run)
    this.currentRun.set(key, id)
    return run
  }

  private runFor(sessionKey: string, deckId: string, attach: string | undefined): MemRun {
    if (attach !== undefined) {
      const run = this.runs.get(attach)
      if (
        run === undefined ||
        run.status !== 'open' ||
        run.sessionKey !== sessionKey ||
        run.deckId !== deckId
      ) {
        throw new CommandError(
          'not_found',
          `run '${attach}' is not open (it was closed, reverted or never existed); start a new one with agent.startRun`,
        )
      }
      return run
    }
    const current = this.currentRun.get(`${sessionKey}|${deckId}`)
    const run = current === undefined ? undefined : this.runs.get(current)
    if (run !== undefined && run.status === 'open') return run
    return this.openRun(sessionKey, deckId, AUTOMATIC_RUN)
  }

  private summary(run: MemRun): AgentRunSummary {
    const revertible = run.status !== 'reverted' && run.manager.undoStack.length > 0
    const reason: AgentRunSummary['notRevertibleReason'] = revertible
      ? null
      : run.status === 'reverted'
        ? 'reverted'
        : 'nothing_to_revert'
    return {
      id: run.id,
      userId: USER_ID,
      userName: 'Eval User',
      surface: 'mcp',
      clientName: run.sessionKey === AGENT_SESSION ? 'claude-code (replay)' : 'agent-eval',
      request: run.request === AUTOMATIC_RUN ? null : run.request,
      status: run.status,
      createdAt: run.createdAt,
      lastActivityAt: run.createdAt,
      revertedAt: null,
      revertedBy: null,
      opCount: run.opCount,
      changeCount: run.changeCount,
      revertibleChanges: run.status === 'reverted' ? 0 : run.manager.undoStack.length,
      revertible,
      notRevertibleReason: reason,
    }
  }

  // -------------------------------------------------------------------------
  // Services (the modelled subset)
  // -------------------------------------------------------------------------

  private buildServices(): ServerServices {
    const s = unsupportedServices()

    const deckItem = (d: MemDeck) => ({
      id: d.record.id,
      title: d.record.title,
      folderId: d.record.folderId,
      updatedAt: d.record.updatedAt,
      role: d.record.viewerRole,
    })
    const folderSummary = (f: FolderSummary): FolderSummary => ({
      ...f,
      deckCount: [...this.decks.values()].filter((d) => d.record.folderId === f.id).length,
    })

    s.decks.create = async ({ title, folderId }) => {
      const folder = folderId ?? this.draftsId
      if (!this.folders.has(folder))
        throw new CommandError('not_found', `folder '${folder}' does not exist`)
      const id = this.nextId('deck')
      const at = this.now()
      const doc = createSlideDoc()
      const record: DeckWithRole = {
        id,
        title: title ?? 'Untitled deck',
        ownerUserId: USER_ID,
        folderId: folder,
        thumbnailKey: null,
        thumbnailUpdatedAt: null,
        thumbnailUrl: null,
        createdAt: at,
        updatedAt: at,
        viewerRole: 'owner',
      }
      this.decks.set(id, { record, doc })
      const { viewerRole: _role, ...rest } = record
      return { ...rest, firstSlideId: doc.slides.get(0).get('id') as string }
    }
    s.decks.get = async ({ deckId }) => {
      const deck = this.decks.get(deckId)
      if (deck === undefined) throw new CommandError('not_found', `deck '${deckId}' does not exist`)
      return deck.record
    }
    s.decks.list = async ({ folderId }) =>
      [...this.decks.values()]
        .filter((d) => folderId === undefined || d.record.folderId === folderId)
        .map((d) => d.record)
    s.decks.listPage = async ({ folderId, query, limit }) => {
      if (folderId !== undefined && !this.folders.has(folderId)) {
        throw new CommandError('not_found', `folder '${folderId}' does not exist`)
      }
      const q = query?.toLowerCase()
      const decks = [...this.decks.values()]
        .filter((d) => folderId === undefined || d.record.folderId === folderId)
        .filter((d) => q === undefined || d.record.title.toLowerCase().includes(q))
        .sort(
          (a, b) =>
            b.record.updatedAt.localeCompare(a.record.updatedAt) ||
            b.record.id.localeCompare(a.record.id),
        )
        .map(deckItem)
      if (decks.length > limit)
        throw new UnsupportedInWorld('deck.list paging is not modelled (more decks than one page)')
      return { decks, next: null }
    }
    s.folders.list = async () => [...this.folders.values()].map(folderSummary)
    s.folders.listPage = async ({ query, limit }) => {
      const q = query?.toLowerCase()
      const folders = [...this.folders.values()]
        .filter((f) => q === undefined || f.name.toLowerCase().includes(q))
        .sort(
          (a, b) =>
            a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
        )
        .map(folderSummary)
      if (folders.length > limit) throw new UnsupportedInWorld('folder.list paging is not modelled')
      return { folders, next: null }
    }
    s.folders.create = async ({ name }) => {
      const id = this.addFolder(name)
      const f = this.folders.get(id)!
      return {
        id,
        name: f.name,
        ownerUserId: USER_ID,
        createdAt: f.createdAt,
        deckCount: 0,
        role: 'owner',
        sharedBy: null,
        isDrafts: false,
      }
    }

    // No font is ever uploaded in the memory world, as in a fresh eval folder live.
    s.folders.listFonts = async ({ folderId }) => {
      if (!this.folders.has(folderId))
        throw new CommandError('not_found', `folder '${folderId}' does not exist`)
      return []
    }
    s.decks.listFonts = async () => []
    // Components cannot be created in the memory world, so every folder has none
    // (as a folder the harness just created has none live).
    s.components.list = async ({ folderId }) => {
      if (!this.folders.has(folderId))
        throw new CommandError('not_found', `folder '${folderId}' does not exist`)
      return []
    }

    // Folder tokens, as services/tokens.ts keeps them (owner = the eval user).
    const fields = <T>(parse: () => T): T => {
      try {
        return parse()
      } catch (err) {
        if (err instanceof InvalidTokenFields) throw new CommandError('invalid_input', err.message)
        throw err
      }
    }
    const own = (tokens: object, id: string) => Object.hasOwn(tokens, id)
    s.tokens.list = async ({ folderId }) => readFolderTokens(this.folderDoc(folderId))
    s.tokens.create = async ({ folderId, category, fields: raw }) => {
      const doc = this.folderDoc(folderId)
      const stored = fields(() => parseNewTokenFields(category, raw))
      if (category === 'textStyles') stored['builtin'] = false
      if (
        category === 'textStyles' &&
        textStyleNameTaken(readFolderTokens(doc), String(stored['name']))
      )
        throw new CommandError(
          'conflict',
          `the folder already has a text style named "${String(stored['name'])}"`,
        )
      const tokenId = this.newTokenId()
      addFolderToken(doc, category, tokenId, stored)
      return { tokenId }
    }
    s.tokens.update = async ({ folderId, category, tokenId, patch: raw }) => {
      const doc = this.folderDoc(folderId)
      const patch = fields(() => parseTokenPatch(category, raw))
      if (Object.keys(patch).length === 0)
        throw new CommandError('invalid_input', 'Pass at least one field to change')
      const before = readFolderTokens(doc)[category] as unknown as Record<
        string,
        Record<string, unknown>
      >
      if (!own(before, tokenId))
        throw new CommandError('not_found', `No ${category} token '${tokenId}' in this folder`)
      const token = before[tokenId]!
      if (
        category === 'textStyles' &&
        typeof patch['name'] === 'string' &&
        textStyleNameTaken(readFolderTokens(doc), patch['name'], tokenId)
      )
        throw new CommandError(
          'conflict',
          `the folder already has a text style named "${patch['name']}"`,
        )
      const previous = Object.fromEntries(Object.keys(patch).map((k) => [k, token[k] ?? null]))
      updateFolderToken(doc, category, tokenId, patch)
      const tokens = readFolderTokens(doc)
      const looks = Object.keys(patch).some((k) => k !== 'name')
      const styleIds = new Set(
        !looks ? [] : category === 'textStyles' ? [tokenId] : stylesUsingColor(tokens, tokenId),
      )
      const propagated = { decks: 0, components: 0, objects: 0, failed: [] as string[] }
      for (const deck of this.decks.values()) {
        if (deck.record.folderId !== folderId || styleIds.size === 0) continue
        let changed = 0
        deck.doc.doc.transact(() => {
          changed = propagateTextStyles(deck.doc, tokens, styleIds)
        }, TOKEN_PROPAGATION)
        if (changed > 0) {
          propagated.decks++
          propagated.objects += changed
        }
      }
      return { previous, propagated }
    }
    s.tokens.delete = async ({ folderId, category, tokenId }) => {
      const doc = this.folderDoc(folderId)
      const tokens = readFolderTokens(doc)[category] as unknown as Record<
        string,
        Record<string, unknown>
      >
      if (!own(tokens, tokenId))
        throw new CommandError('not_found', `No ${category} token '${tokenId}' in this folder`)
      const token = tokens[tokenId]!
      if (category === 'textStyles' && token['builtin'] === true)
        throw new CommandError('conflict', `"${String(token['name'])}" is a built-in text style`)
      deleteFolderToken(doc, category, tokenId)
      return { deleted: true as const, token }
    }
    s.tokens.seedDefaults = async ({ folderId }) => {
      const doc = this.folderDoc(folderId)
      const seeded = seedDefaultTokens(doc, () => this.newTokenId())
      const migrated = migrateFolderTokens(doc)
      return { seeded, migrated }
    }

    s.sharing.listLinks = async ({ deckId }) =>
      (this.links.get(deckId) ?? []).filter((l) => !l.revoked)
    s.sharing.createLink = async ({ deckId, userId, role, expiresAt }) => {
      const id = this.nextId('link')
      const list = this.links.get(deckId) ?? []
      list.push({
        id,
        role,
        createdAt: this.now(),
        expiresAt: expiresAt ?? null,
        createdBy: userId,
        revoked: false,
      })
      this.links.set(deckId, list)
      return { id, url: `https://narrative.memory/s/${id}` }
    }

    s.editor.context = async ({ deckId }) => {
      const state = this.editors.get(deckId)
      return state === undefined ? [] : [state]
    }
    s.editor.show = async ({ deckId }) => ({ delivered: this.editors.has(deckId) ? 1 : 0 })
    s.editor.presentUrl = ({ deckId, slideNumber }) =>
      `https://narrative.memory/deck/${deckId}/present?slide=${slideNumber}`

    // Component masters never reach a service here (`execute` refuses them),
    // so a run target is always a deck.
    const runDeck = (target: RunDocument): string => {
      if (target.kind !== 'deck')
        throw new CommandError(
          'wrong_host',
          'component master documents are not modelled by the memory world',
        )
      return target.deckId
    }
    s.runs.startRun = async ({ session, target, request }) => ({
      runId: this.openRun(session.key, runDeck(target), request).id,
    })
    s.runs.listRuns = async ({ target, limit }) =>
      [...this.runs.values()]
        .filter((r) => r.deckId === runDeck(target))
        .reverse()
        .slice(0, limit)
        .map((r) => this.summary(r))
    s.runs.revertRun = async ({ target, runId, lastOps }) => {
      const run = this.runs.get(runId)
      if (run === undefined || run.deckId !== runDeck(target)) {
        throw new CommandError('not_found', `run '${runId}' does not exist on this deck`)
      }
      if (run.status === 'reverted' || run.manager.undoStack.length === 0) {
        throw new CommandError(
          'conflict',
          `run '${runId}' can no longer be reverted (${run.status === 'reverted' ? 'reverted' : 'no changes'})`,
        )
      }
      const available = run.manager.undoStack.length
      const count = Math.min(lastOps ?? available, available)
      for (let i = 0; i < count; i++) run.manager.undo()
      const remaining = run.manager.undoStack.length
      if (remaining === 0) run.status = 'reverted'
      return {
        runId,
        revertedChanges: count,
        remainingChanges: remaining,
        status: remaining === 0 ? 'reverted' : run.status,
      }
    }
    // Folder style packs, as services/stylePacks.ts keeps them.
    s.stylePacks.get = async ({ folderId }) =>
      readStylePack(this.folderDoc(folderId)) as StylePack | null
    const packInput = <T>(parse: () => T): T => fields(parse)
    s.stylePacks.set = async ({ folderId, pack }) => {
      const doc = this.folderDoc(folderId)
      const parsed = packInput(() => parseStylePack(pack))
      const previous = readStylePack(doc)
      setStylePack(doc, parsed as unknown as Record<string, unknown>)
      return { previous }
    }
    s.stylePacks.update = async ({ folderId, patch }) => {
      const doc = this.folderDoc(folderId)
      const current = readStylePack(doc)
      if (current === null)
        throw new CommandError('not_found', 'The folder has no style pack; set one first')
      packInput(() => parseStylePack(mergeStylePackPatch(current, patch)))
      patchStylePack(doc, patch)
      return { previous: previousOfUpdate(current, patch) }
    }
    s.stylePacks.delete = async ({ folderId }) => {
      const doc = this.folderDoc(folderId)
      const previous = readStylePack(doc)
      if (previous !== null) deleteStylePack(doc)
      return { previous }
    }
    s.stylePacks.compile = async ({ folderId }) => {
      const doc = this.folderDoc(folderId)
      const pack = readStylePack(doc) as StylePack | null
      if (pack === null)
        throw new CommandError('not_found', 'The folder has no style pack to compile')
      const plan = compileStylePack(pack, { tokens: readFolderTokens(doc), fonts: [] })
      const counts = { colors: { created: 0, updated: 0 }, textStyles: { created: 0, updated: 0 } }
      for (const category of ['colors', 'textStyles'] as const)
        for (const t of plan[category]) {
          const parsed = fields(() => parseNewTokenFields(category, t.fields))
          if (category === 'textStyles') parsed['builtin'] = false
          parsed['origin'] = t.origin
          if (t.exists) updateFolderToken(doc, category, t.id, parsed)
          else addFolderToken(doc, category, t.id, parsed)
          counts[category][t.exists ? 'updated' : 'created']++
        }
      return { ...counts, components: { created: 0, updated: 0 }, missingFonts: plan.missingFonts }
    }
    return s
  }

  // -------------------------------------------------------------------------
  // Invocation
  // -------------------------------------------------------------------------

  /** Top-level keys of a command's own input (what an MCP argument of that name is). */
  inputKeys(command: string): Set<string> {
    let keys = this.keysCache.get(command)
    if (keys === undefined) {
      keys = new Set<string>()
      const def = this.registry.get(command)
      if (def !== undefined) {
        schemaKeys(
          z.toJSONSchema(def.input as z.ZodType, { io: 'input', unrepresentable: 'any' }),
          keys,
        )
      }
      this.keysCache.set(command, keys)
    }
    return keys
  }

  /** Run one invocation as `sessionKey`, the way the ServerHost does. Throws CommandError / UnsupportedInWorld. */
  async invoke(args: {
    sessionKey: string
    command: string
    target: EvalTarget
    input: unknown
    /**
     * Out-of-band confirmation id. The memory world has no confirm page, so
     * no id is ever approved here: confirm-always commands are refused, as
     * the server refuses them until a person approves.
     */
    confirmationId?: string
    /**
     * The harness's own explicit confirmation — the equivalent of a script's
     * `confirm: [commandId]` list on `POST /commands`. Never set for agent
     * calls.
     */
    explicitConfirm?: boolean
    attachRunId?: string
  }): Promise<unknown> {
    const def: AnyCommandDef | undefined = this.registry.get(args.command)
    if (def === undefined)
      throw new CommandError('unknown_command', `unknown command '${args.command}'`)
    if (def.confirm === 'always' && args.explicitConfirm !== true) {
      throw new CommandError(
        args.confirmationId === undefined ? 'confirmation_required' : 'not_confirmed',
        `${args.command} is irreversible and needs the user's confirmation on Narrative's confirm page`,
      )
    }
    if (args.target.componentId !== undefined) {
      throw new UnsupportedInWorld(
        'component master documents are not modelled by the memory world',
      )
    }
    if (args.target.folderId !== undefined && !this.folders.has(args.target.folderId)) {
      throw new CommandError('not_found', `folder '${args.target.folderId}' does not exist`)
    }
    let deck: MemDeck | undefined
    if (args.target.deckId !== undefined) {
      deck = this.decks.get(args.target.deckId)
      if (deck === undefined)
        throw new CommandError('not_found', `deck '${args.target.deckId}' does not exist`)
    }
    const writes = def.effects.includes('doc')
    // A named run must be this session's open run on this target, as the
    // server checks for every agent call (services/runs.ts runFor).
    if (args.attachRunId !== undefined && !(writes && deck !== undefined)) {
      const named = this.runs.get(args.attachRunId)
      if (named === undefined || named.status !== 'open' || named.sessionKey !== args.sessionKey)
        throw new CommandError(
          'conflict',
          `run '${args.attachRunId}' is not open (it was closed, reverted or never existed); start a new one with agent.startRun`,
        )
      if (deck === undefined)
        throw new CommandError(
          'conflict',
          `run '${args.attachRunId}' works on deck:${named.deckId}; this command changes no deck or master (a folder or account change, not part of that run): call it without runId`,
        )
      if (named.deckId !== deck.record.id)
        throw new CommandError(
          'conflict',
          `run '${args.attachRunId}' works on deck:${named.deckId}, not deck:${deck.record.id}`,
        )
    }
    const run =
      writes && deck !== undefined
        ? this.runFor(args.sessionKey, deck.record.id, args.attachRunId)
        : undefined
    const ctx: CommandContext = {
      actor: { userId: USER_ID, role: 'owner', kind: 'agent' },
      host: 'server',
      target: args.target,
      services: this.services,
      session: { key: args.sessionKey, surface: 'mcp', clientName: 'agent-eval memory world' },
      origin: run?.origin ?? { kind: 'agent-eval-read' },
      ...(run !== undefined ? { run: { runId: run.id, surface: 'mcp' as const } } : {}),
      ...(deck !== undefined && (commandUsesDocument(def) || writes) ? { deck: deck.doc } : {}),
      // The deck's folder tokens, as the server reads them (agent/folderTokens.ts).
      ...(deck !== undefined && commandReadsFolderTokens(this.registry, args.command, args.input)
        ? { folderTokens: this.folderTokensOf(deck.record.folderId) }
        : {}),
      // The deck's folder style pack, as the server reads it (agent/folderStylePack.ts).
      ...(deck !== undefined && commandReadsStylePack(this.registry, args.command, args.input)
        ? {
            stylePack:
              deck.record.folderId === null
                ? null
                : (readStylePack(this.folderDoc(deck.record.folderId)) as StylePack | null),
          }
        : {}),
      // Nor did anyone upload fonts to them.
      ...(deck !== undefined && commandReadsFolderFonts(this.registry, args.command, args.input)
        ? { folderFonts: null }
        : {}),
    }
    const stackBefore = run?.manager.undoStack.length ?? 0
    const result = await runCommand(this.registry, ctx, args.command, args.input)
    if (run !== undefined) {
      run.opCount++
      if (run.manager.undoStack.length > stackBefore) run.changeCount++
      deck!.record.updatedAt = this.now()
    }
    return result
  }

  /** One MCP tool call of the agent (tool name + arguments, as recorded). */
  agentCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const command = tool.replace(/_/g, '.')
    const split = splitToolArguments(tool, args, this.inputKeys(command))
    return this.invoke({
      sessionKey: AGENT_SESSION,
      command: split.command,
      target: split.target,
      input: split.input,
      ...(split.confirmationId !== undefined ? { confirmationId: split.confirmationId } : {}),
      ...(split.runId !== undefined ? { attachRunId: split.runId } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // World
  // -------------------------------------------------------------------------

  async run<T = Record<string, unknown>>(
    target: EvalTarget,
    command: string,
    input: unknown = {},
    options: { confirm?: string[] } = {},
  ): Promise<T> {
    try {
      return (await this.invoke({
        sessionKey: HARNESS_SESSION,
        command,
        target,
        input,
        explicitConfirm: options.confirm?.includes(command) ?? false,
      })) as T
    } catch (err) {
      if (err instanceof CommandError) throw new EvalCommandError(command, err.code, err.message)
      throw err
    }
  }

  async batch(
    target: EvalTarget,
    ops: ReadonlyArray<{ command: string; input: unknown }>,
  ): Promise<unknown[]> {
    const out = await this.run<{ results: unknown[] }>(target, 'ops.apply', { ops, atomic: true })
    return out.results
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
    return folder.id
  }

  async uploadImage(deckId: string): Promise<string> {
    if (!this.decks.has(deckId))
      throw new EvalCommandError('media.upload', 'not_found', `deck '${deckId}' does not exist`)
    // The document only stores the asset id; there is no media store here.
    return this.nextId('asset')
  }

  async createComponent(): Promise<string> {
    throw new UnsupportedInWorld('components are not modelled by the memory world')
  }

  async openEditor(deckId: string, options: OpenEditorOptions): Promise<void> {
    const deck = this.decks.get(deckId)
    if (deck === undefined) throw new Error(`openEditor: deck '${deckId}' does not exist`)
    let index: number | null = null
    for (let i = 0; i < deck.doc.slides.length; i++) {
      if (deck.doc.slides.get(i).get('id') === options.slideId) index = i
    }
    this.editors.set(deckId, {
      activeSlideId: options.slideId,
      activeSlideIndex: index,
      selectedObjectIds: [...options.selectedObjectIds],
      lastActiveAt: this.now(),
    })
  }

  async fetchBinary(): Promise<Uint8Array> {
    throw new UnsupportedInWorld('the memory world has no file storage to download from')
  }

  async person(): Promise<Person> {
    throw new UnsupportedInWorld('the memory world has one user; sharing is live only')
  }

  async userEmail(): Promise<string> {
    throw new UnsupportedInWorld('the memory world has one user; sharing is live only')
  }

  async runAs<T>(): Promise<T> {
    throw new UnsupportedInWorld('the memory world has one user; sharing is live only')
  }

  async createFolderAs(): Promise<string> {
    throw new UnsupportedInWorld('the memory world has one user; sharing is live only')
  }

  async approveConfirmation(): Promise<void> {
    throw new UnsupportedInWorld('the memory world has no confirmation page to approve on')
  }
}
