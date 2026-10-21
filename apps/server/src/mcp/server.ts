/**
 * mcp/server.ts — one MCP protocol server per session (the SDK's low-level
 * `Server`: the tool list is generated JSON Schema, not zod shapes, so the
 * high-level `McpServer.registerTool` does not fit).
 *
 * tools/call runs every command through the ServerHost (agent/serverHost.ts)
 * — the one execution path, which authorises per target, opens runs, logs
 * ops and attributes writes — with `surface: 'mcp'`, the session's user and
 * the session's key. Nothing here writes a document.
 *
 * A timed request (observability/phases.ts) whose call the host authorised
 * gets the call's phases in the result's `_meta["narrative/serverTiming"]`:
 * the SDK's transport has written its headers before the tool runs, so
 * there is no Server-Timing. A refused call carries none.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { commandIdForToolName } from '@narrative/commands'
import type { AgentConfirmations } from '../agent/confirmations.js'
import type { HostConfirmation, ServerHost } from '../agent/serverHost.js'
import {
  MCP_TIMING_META_KEY,
  currentClock,
  phaseLap,
  reportablePhases,
} from '../observability/phases.js'
import { clientElicitation, obtainConfirmation } from './confirm.js'
import { GuidanceError, type Guidance } from './guidance.js'
import { errorResult, hostResultToToolResult } from './results.js'
import { ArgumentError, confirmationModeOf, splitArguments, type ToolCatalog } from './tools.js'

export const SERVER_NAME = 'narrative'

/** What a session knows about itself; filled in as the session is established. */
export interface SessionIdentity {
  /** Set once the transport has assigned the session id. */
  sessionId: string | null
  userId: string
  /** The credential the session authenticated with (mcp/auth.ts `credentialKey`). */
  credentialKey?: string
}

export interface SessionServerDeps {
  host: ServerHost
  catalog: ToolCatalog
  guidance: Guidance
  version: string
  /** Pending out-of-band confirmations (agent/confirmations.ts), shared with the host and the web page. */
  confirmations: AgentConfirmations
  /** The Narrative page of a confirmation (`<SPA>/confirm/<id>`). */
  confirmUrl: (id: string) => string
  /** Called at the start of every tool call (session activity). */
  onActivity?: () => void
  /** Called once the client finished `initialize` (its name and declared capabilities). */
  onInitialized?: (client: { clientName: string | undefined; capabilities: unknown }) => void
}

const MAX_CLIENT_NAME = 80

/** A folder's style pack as a resource (A4.3): summary and layouts, sized for a model. */
export const PACK_RESOURCE_TEMPLATE = 'narrative://folders/{folderId}/pack'

/** The folder of a pack resource URI, or null for any other URI. */
export function packResourceFolder(uri: string): string | null {
  const m = /^narrative:\/\/folders\/([A-Za-z0-9_-]{1,64})\/pack$/.exec(uri)
  return m === null ? null : m[1]!
}

/** The client's name as recorded on runs (`clientInfo` from initialize). */
export function clientNameOf(server: Server): string | undefined {
  const info = server.getClientVersion()
  if (info === undefined) return undefined
  const name = `${info.name}${info.version ? ` ${info.version}` : ''}`
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return name === '' ? undefined : name.slice(0, MAX_CLIENT_NAME)
}

/**
 * Inside `ops.apply`, accept tool names (`object_move`) as well as command
 * ids (`object.move`): the model sees tool names everywhere else. Ids never
 * contain `_`, so the translation is unambiguous; unknown names pass through
 * for the runner to report.
 */
export function opsWithCommandIds(input: Record<string, unknown>): Record<string, unknown> {
  const ops = input['ops']
  if (!Array.isArray(ops)) return input
  return {
    ...input,
    ops: ops.map((op: unknown) => {
      if (typeof op !== 'object' || op === null) return op
      const command = (op as { command?: unknown }).command
      if (typeof command !== 'string' || command.includes('.')) return op
      const id = commandIdForToolName(command)
      return id === null ? op : { ...op, command: id }
    }),
  }
}

export function createSessionServer(identity: SessionIdentity, deps: SessionServerDeps): Server {
  const server = new Server(
    { name: SERVER_NAME, title: 'Narrative', version: deps.version },
    {
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false },
      },
      instructions: deps.guidance.instructions(),
    },
  )
  const elicitation = () => clientElicitation(server.getClientCapabilities())
  server.oninitialized = () => {
    deps.onInitialized?.({
      clientName: clientNameOf(server),
      capabilities: server.getClientCapabilities() ?? null,
    })
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.catalog.list(confirmationModeOf(elicitation())),
  }))

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      // Session lookup, the SDK's JSON-RPC dispatch (a no-op unless timed).
      phaseLap('mcp.dispatch')
      deps.onActivity?.()
      const entry = deps.catalog.get(request.params.name)
      if (entry === undefined)
        throw new McpError(ErrorCode.InvalidParams, `unknown tool '${request.params.name}'`)
      let split
      try {
        split = splitArguments(entry, request.params.arguments ?? {})
      } catch (e) {
        if (e instanceof ArgumentError)
          return errorResult({ code: 'invalid_input', message: e.message })
        throw e
      }
      const input = entry.def.id === 'ops.apply' ? opsWithCommandIds(split.input) : split.input
      phaseLap('mcp.args')

      const sessionId = identity.sessionId ?? extra.sessionId ?? null
      const sessionKey = sessionId === null ? undefined : `mcp:${sessionId}`
      const clientName = clientNameOf(server)
      const actor = { userId: identity.userId, kind: 'agent' as const }

      // Ask the user first when this call needs it. A call the host refuses
      // outright (unknown target, no access, invalid input) is not put to the
      // user: it goes on to `execute`, which reports and logs the refusal.
      let confirmation: HostConfirmation | undefined
      if (entry.mayNeedConfirmation) {
        const check = await deps.host.confirmationFor({
          actor,
          surface: 'mcp',
          ...(sessionKey === undefined ? {} : { sessionKey }),
          ...(clientName === undefined ? {} : { clientName }),
          target: split.target,
          invocation: { command: entry.def.id, input },
        })
        if (check.status === 'required') {
          const outcome = await obtainConfirmation({
            server,
            support: elicitation(),
            def: entry.def,
            requirement: check.requirement,
            confirmations: deps.confirmations,
            confirmUrl: deps.confirmUrl,
            ...(split.confirmationId === undefined ? {} : { confirmationId: split.confirmationId }),
            relatedRequestId: extra.requestId,
            signal: extra.signal,
          })
          if (!outcome.ok) return errorResult(outcome.error)
          confirmation = outcome.confirmation
        }
      }

      phaseLap('mcp.confirm')

      const outcome = await deps.host.execute({
        actor,
        surface: 'mcp',
        ...(sessionKey === undefined ? {} : { sessionKey }),
        ...(clientName === undefined ? {} : { clientName }),
        ...(identity.credentialKey === undefined ? {} : { credentialKey: identity.credentialKey }),
        target: split.target,
        invocation: { command: entry.def.id, input },
        ...(split.runId === undefined ? {} : { runId: split.runId }),
        ...(confirmation === undefined ? {} : { confirmation }),
      })
      phaseLap('host')
      const result = hostResultToToolResult(outcome, { write: entry.def.undo !== 'n/a' })
      const clock = currentClock()
      clock?.lap('mcp.result')
      const phases = reportablePhases(clock)
      if (phases === null) return result
      return { ...result, _meta: { ...result._meta, [MCP_TIMING_META_KEY]: phases } }
    },
  )

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: deps.guidance.listPrompts(),
  }))
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    try {
      return deps.guidance.getPrompt(request.params.name, request.params.arguments ?? {})
    } catch (e) {
      if (e instanceof GuidanceError) throw new McpError(ErrorCode.InvalidParams, e.message)
      throw e
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: deps.guidance.listResources(),
  }))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: PACK_RESOURCE_TEMPLATE,
        name: 'Folder style pack',
        description:
          "A folder's style pack for a model: its variants, colours, fonts, text styles, rules and every layout " +
          "with its purpose and slots (style.pack.get reads parts of it; a deck's folder is its folderId).",
        mimeType: 'application/json',
      },
    ],
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const folderId = packResourceFolder(request.params.uri)
    if (folderId !== null) {
      // As the command reads it, with this session's user's access to the folder.
      const read = async (part: 'summary' | 'layouts'): Promise<unknown> => {
        const outcome = await deps.host.execute({
          actor: { userId: identity.userId, kind: 'agent' },
          surface: 'mcp',
          target: { folderId },
          invocation: { command: 'style.pack.get', input: { part } },
        })
        if (!outcome.ok)
          throw new McpError(-32002, outcome.error.message, { uri: request.params.uri })
        return (outcome.result as { value: unknown }).value
      }
      const summary = await read('summary')
      const layouts = summary === null ? [] : await read('layouts')
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'application/json',
            text: JSON.stringify({ pack: summary, layouts }),
          },
        ],
      }
    }
    try {
      return deps.guidance.readResource(request.params.uri)
    } catch (e) {
      // -32002 is the spec's "resource not found".
      if (e instanceof GuidanceError)
        throw new McpError(-32002, e.message, { uri: request.params.uri })
      throw e
    }
  })

  return server
}
