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
  CommandScope,
  CommandTarget,
  ConditionalConfirmation,
  ConfirmationDetail,
  AgentRunInfo,
  AgentSessionInfo,
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
export {
  CommandRegistry,
  commandConfirmationProblems,
  commandMetadataProblems,
  commandTargetProblems,
  defineCommand,
  type AnyCommandDef,
} from './registry.js'
export {
  commandReadsFolderFonts,
  commandReadsFolderTokens,
  commandUsesDocument,
  isBatchable,
  prepareInvocation,
  runBatch,
  runCommand,
  runCommandSync,
  runGroup,
  type BatchResult,
  type PreparedInvocation,
} from './run.js'
export {
  FileSourceSchema,
  fileSourceUrlHost,
  urlFetchConfirmation,
} from './commands/serverShared.js'
export { SlideRefSchema, ObjectIdSchema, ObjectIdsSchema, type SlideRef } from './refs.js'
export {
  ANCHORS,
  OPPOSITE_ANCHOR,
  anchorsOnSlide,
  fitAnchors,
  frameCorners,
  localToSlide,
  placeResized,
  resizeFromHandle,
  scaleCrop,
  shapeOutline,
  visualBounds,
  type Anchor,
  type Frame,
  type OutlineShape,
  type PathPoint,
  type Placement,
  type Point,
  type Rect,
  type ResizeHandle,
} from './geometry.js'
export {
  MAX_SLIDE_INDENT,
  levelOf,
  maxLevelBelow,
  normalizeOutline,
  shiftBlockLevels,
} from './outline.js'
export { createDefaultRegistry } from './catalog.js'
export {
  COMMAND_DOMAINS,
  PLANNED_MARKER,
  TOOL_NAME_MAX,
  commandFetchesUrls,
  commandIdForToolName,
  commandMentionPattern,
  danglingCommandMentions,
  findCommandMentions,
  rewriteCommandMentionsAsToolNames,
  toolNameForCommand,
  type CommandMention,
} from './agentSurface.js'
export { buildManifest, renderManifestMarkdown, type CapabilityManifest } from './manifest.js'
export { normaliseRoute, routeCoverage, routeKey, type RouteCoverage } from './parity/routes.js'
export { KNOWN_MISSING, type KnownMissing } from './parity/knownMissing.js'
export { AGENT_ALLOWLIST, type AllowlistEntry } from './parity/allowlist.js'
export {
  requireServices,
  type ServerServices,
  type DeckService,
  type FolderService,
  type SharingService,
  type MediaService,
  type ComponentService,
  type PptxService,
  type TokenService,
  type EditorService,
  type AgentRunService,
} from './services.js'
export type * from './services/types.js'
export { MAX_INSERT_OBJECTS, applyInsertPlan, planInsert, type InsertPlan } from './insert/plan.js'
export { MAX_LIST_PAGE_SIZE } from './services/common.js'
export type {
  AgentRunStatus,
  AgentRunSummary,
  NotRevertibleReason,
  RunDocument,
  StartRunArgs,
  ListRunsArgs,
  RevertRunArgs,
  RevertRunResult,
} from './services/runs.js'
export {
  EDITOR_SHOW_MESSAGE_TYPE,
  type EditorShowMessage,
  type OpenEditorState,
  type EditorContextArgs,
  type EditorShowArgs,
  type PresentUrlArgs,
} from './services/editor.js'
export { DEFAULT_SHADOW, GRADIENT_FILL_TYPES } from './commands/appearance.js'
export { MAX_TABLE_TRACKS, MIN_TRACK_PX } from './commands/tables.js'
export { MAX_BODY_LENGTH, displayRangeOf } from './text/body.js'
export { displayOffsetOf, rawOffsetOf } from './text/edit.js'
export { BOX_TYPOGRAPHY_KEYS } from './commands/typography.js'
export type { TextTarget } from './text/target.js'
export {
  STANDARD_WEIGHTS,
  SYSTEM_FONTS,
  allowedWeightsFor,
  effectiveFontWeight,
  matchFontWeight,
  pickPrimaryFamily,
  toNumericWeight,
  type FontFaceWeight,
  type NumericFontWeight,
} from './text/fontWeights.js'
export {
  PAGE_NUMBER_TEXT_STYLE_NAME,
  findTextStyleByName,
  textStyleField,
  textStyleFields,
} from './text/textStyle.js'
