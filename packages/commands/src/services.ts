/**
 * commands/src/services.ts
 *
 * The server capabilities a command can call, as interfaces. They are
 * DEFINED here, next to the commands that use them, and IMPLEMENTED by the
 * server (apps/server/src/services/), which injects them into the context
 * of every server-host invocation. This keeps the registry the single
 * source of truth (ADR 0010) without the commands package depending on
 * the server: a command's handler calls `requireServices(ctx).decks.rename`
 * and the very same service backs the HTTP route, so the route and the
 * command cannot drift apart.
 *
 * Every service method receives the acting user id and authorises the
 * resource itself when the command is `user`-scoped; `deck`/`folder`-scoped
 * commands are authorised by the host before they run.
 *
 * One file per domain under ./services/ (A1 fills them in); an empty
 * interface means "not implemented yet".
 */

import { CommandError } from './errors.js'
import type { CommandContext } from './types.js'

import type { DeckService } from './services/decks.js'
import type { FolderService } from './services/folders.js'
import type { SharingService } from './services/sharing.js'
import type { FolderSharingService } from './services/folderSharing.js'
import type { MediaService } from './services/media.js'
import type { ComponentService } from './services/components.js'
import type { PptxService } from './services/pptx.js'
import type { RenderService } from './services/render.js'
import type { TokenService } from './services/tokens.js'
import type { EditorService } from './services/editor.js'
import type { AgentRunService } from './services/runs.js'
import type { StylePackService } from './services/stylePacks.js'

export type {
  DeckService,
  FolderService,
  SharingService,
  FolderSharingService,
  MediaService,
  ComponentService,
  PptxService,
  RenderService,
  TokenService,
  EditorService,
  AgentRunService,
  StylePackService,
}

export interface ServerServices {
  decks: DeckService
  folders: FolderService
  sharing: SharingService
  folderSharing: FolderSharingService
  media: MediaService
  components: ComponentService
  pptx: PptxService
  render: RenderService
  tokens: TokenService
  editor: EditorService
  runs: AgentRunService
  stylePacks: StylePackService
}

export function requireServices(ctx: CommandContext): ServerServices {
  if (ctx.services === undefined) {
    throw new CommandError(
      'wrong_host',
      'this command needs the server host (it calls server services)',
    )
  }
  return ctx.services
}
