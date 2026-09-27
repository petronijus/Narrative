/**
 * commands/src/agentSurface.ts
 *
 * How the registry is named and referenced on the agent surface (MCP tools,
 * MCP prompts, the generated `narrative` Claude Code skill). Pure helpers,
 * shared by the MCP server, the playbook loader, the skill generator and the
 * parity guards, so all of them agree on one mapping.
 *
 * Tool names
 * ----------
 * A command id is `<domain>.<verb>` or `<domain>.<noun>.<verb>` in lower
 * camelCase segments (registry.ts ID_PATTERN). MCP allows dots in tool names
 * (spec 2025-11-25: `[A-Za-z0-9_.-]`, 1–128 chars), but the Anthropic API —
 * and therefore every Claude client — only accepts `^[a-zA-Z0-9_-]{1,64}$`.
 * So a tool name is the command id with every `.` replaced by `_`
 * (`object.path.setAnchors` → `object_path_setAnchors`). Command ids never
 * contain `_`, so the mapping is reversible and injective. Claude Code adds
 * `mcp__<server>__` in front; the ids are short enough (≤ 25 characters
 * today, `TOOL_NAME_MAX` enforced by a test) to stay under 64 with any
 * reasonable server name.
 */

import type { CommandRegistry } from './registry.js'
import type { AnyCommandDef } from './registry.js'
import { z } from 'zod'
import { FileSourceSchema } from './commands/serverShared.js'

/** Longest tool name we allow: leaves room for Claude Code's `mcp__<server>__` prefix within 64. */
export const TOOL_NAME_MAX = 40

const TOOL_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*(_[a-z][a-zA-Z0-9]*){1,3}$/

/** `object.move` → `object_move`. */
export function toolNameForCommand(commandId: string): string {
  return commandId.replace(/\./g, '_')
}

/**
 * `object_move` → `object.move`; null when the name cannot be a tool name
 * (the caller then reports an unknown tool). Does not check the registry.
 */
export function commandIdForToolName(toolName: string): string | null {
  if (!TOOL_NAME_PATTERN.test(toolName)) return null
  return toolName.replace(/_/g, '.')
}

/**
 * The domains a command id can start with — the same list as the `Domain`
 * type in types.ts (kept as a value here because a type has no runtime
 * form; a test checks that every registered domain is in it).
 */
export const COMMAND_DOMAINS = [
  'deck',
  'folder',
  'token',
  'slide',
  'object',
  'text',
  'table',
  'animation',
  'guide',
  'media',
  'component',
  'share',
  'style',
  'query',
  'editor',
  'ops',
  'agent',
] as const

/**
 * A mention of a command in prose written for a model (a command
 * description, a playbook): `<domain>.<name>[.<name>…]`, optionally ending
 * in a `.*` / `*` wildcard (`table.style.*`). Group 1 is the wildcard
 * suffix. A fresh RegExp per call, because the `g` flag makes a shared one
 * stateful.
 */
export function commandMentionPattern(): RegExp {
  return new RegExp(`\\b(?:${COMMAND_DOMAINS.join('|')})(?:\\.[a-z][a-zA-Z]*)+(\\.?\\*)?`, 'g')
}

/** Written right after a mention of a command that does not exist yet. */
export const PLANNED_MARKER = ' (planned, not available yet)'

/**
 * The marker as it is recognised: after an optional closing backtick (a
 * Markdown code span around the id), with any whitespace — Markdown prose
 * wraps lines inside it.
 */
const PLANNED_AFTER_MENTION = /^`?\s+\(planned,\s+not\s+available\s+yet\)/

export interface CommandMention {
  /** The whole mention as written, wildcard included. */
  text: string
  /** The command id (or id prefix, for a wildcard). */
  id: string
  wildcard: boolean
  index: number
  /** Followed by {@link PLANNED_MARKER}. */
  planned: boolean
}

export function findCommandMentions(text: string): CommandMention[] {
  return [...text.matchAll(commandMentionPattern())].map((m) => {
    const wildcard = m[1] !== undefined
    const mention = m[0]
    return {
      text: mention,
      id: wildcard ? mention.slice(0, mention.length - m[1]!.length) : mention,
      wildcard,
      index: m.index,
      planned: PLANNED_AFTER_MENTION.test(
        text.slice(m.index + mention.length, m.index + mention.length + 64),
      ),
    }
  })
}

/**
 * Mentions that send a model to a dead end: a command that is neither
 * registered nor marked planned, a wildcard that matches nothing, or a
 * registered command marked planned. Used by the parity guards for command
 * descriptions and by the playbook tests — one rule for all model-facing
 * prose.
 */
export function danglingCommandMentions(text: string, registry: CommandRegistry): string[] {
  const ids = registry.list().map((c) => c.id)
  return findCommandMentions(text).flatMap((m) => {
    if (m.wildcard)
      return ids.some((x) => x.startsWith(m.id)) ? [] : [`${m.text} matches no command`]
    if (registry.has(m.id)) return m.planned ? [`${m.id} is registered but marked planned`] : []
    return m.planned ? [] : [`${m.id} is not a registered command (mark it${PLANNED_MARKER})`]
  })
}

/**
 * Rewrite every command mention into its tool-name form (`text.format` →
 * `text_format`, `table.style.*` → `table_style_*`), so prose served over
 * MCP names exactly the tools the model sees. Planned commands are rewritten
 * too, for consistency; the "(planned, …)" marker stays.
 */
export function rewriteCommandMentionsAsToolNames(text: string): string {
  return text.replace(commandMentionPattern(), (mention) => toolNameForCommand(mention))
}

/**
 * Whether a command's input can make the server fetch a URL on the open
 * web — every input that embeds the shared file source (`{ url }` or
 * `{ base64 }`, commands/serverShared.ts): media and font uploads, PPTX
 * import and insert. Detected structurally, so a new command that accepts a
 * file is covered without a list to maintain. Drives MCP's `openWorldHint`.
 */
export function commandFetchesUrls(def: Pick<AnyCommandDef, 'input'>): boolean {
  let found = false
  try {
    z.toJSONSchema(def.input, {
      io: 'input',
      unrepresentable: 'any',
      override: (ctx) => {
        if (ctx.zodSchema === FileSourceSchema) found = true
      },
    })
  } catch {
    // A schema that cannot be rendered cannot be offered as a tool either;
    // the MCP tool builder reports that separately.
  }
  return found
}
