/**
 * @narrative/commands — the capability registry (ADR 0010).
 *
 * Every user-visible capability of Narrative is a command defined here. The
 * editor UI and agents (over MCP) execute the same commands through the same
 * runner, which is what keeps "an agent can do what a user can" true.
 */

export type {
  Actor,
  CommandContext,
  CommandDef,
  CommandExample,
  CommandInvocation,
  ConfirmPolicy,
  Domain,
  Effect,
  Host,
  Role,
  RouteRef,
  UndoPolicy,
} from './types.js'
export { ROLE_RANK } from './types.js'
export { CommandError, type CommandErrorCode, type CommandIssue } from './errors.js'
export { CommandRegistry, defineCommand, type AnyCommandDef } from './registry.js'
export { runBatch, runCommand, runCommandSync, type BatchResult } from './run.js'
export { SlideRefSchema, ObjectIdSchema, ObjectIdsSchema, type SlideRef } from './refs.js'
export { createDefaultRegistry } from './catalog.js'
export { buildManifest, renderManifestMarkdown, type CapabilityManifest } from './manifest.js'
export { normaliseRoute, routeCoverage, routeKey, type RouteCoverage } from './parity/routes.js'
export { KNOWN_MISSING, type KnownMissing } from './parity/knownMissing.js'
export { AGENT_ALLOWLIST, type AllowlistEntry } from './parity/allowlist.js'
