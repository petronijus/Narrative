/**
 * mcp/server.ts — one MCP protocol server per session (the SDK's low-level
 * `Server`: the tool list is generated JSON Schema, not zod shapes, so the
 * high-level `McpServer.registerTool` does not fit).
 *
 * tools/call runs every command through the ServerHost (agent/serverHost.ts)
 * — the one execution path, which authorises per target, opens runs, logs
 * ops and attributes writes — with `surface: 'mcp'`, the session's user and
 * the session's key. Nothing here writes a document.
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
      return hostResultToToolResult(outcome, { write: entry.def.undo !== 'n/a' })
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
    resourceTemplates: [],
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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
