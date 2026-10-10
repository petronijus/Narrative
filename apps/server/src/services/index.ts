/**
 * services/index.ts
 *
 * Builds the `ServerServices` the server host injects into every command
 * invocation (packages/commands/src/services.ts). One file per domain; the
 * HTTP routes call the same service functions, so an agent command and the
 * route it mirrors share one implementation.
 */

import type { ServerServices } from '@narrative/commands'
import type { ServiceDeps } from './deps.js'
import { createDecksService } from './decks.js'
import { createFoldersService } from './folders.js'
import { createSharingService } from './sharing.js'
import { createFolderSharingService } from './folderSharing.js'
import { createMediaService } from './media.js'
import { createComponentsService } from './components.js'
import { createPptxService } from './pptx.js'
import { createRenderService } from './render.js'
import { createTokensService } from './tokens.js'
import { createEditorService } from './editor.js'
import { createRunsService } from './runs.js'

export type { ServiceDeps } from './deps.js'

export function createServerServices(deps: ServiceDeps): ServerServices {
  return {
    decks: createDecksService(deps),
    folders: createFoldersService(deps),
    sharing: createSharingService(deps),
    folderSharing: createFolderSharingService(deps),
    media: createMediaService(deps),
    components: createComponentsService(deps),
    pptx: createPptxService(deps),
    render: createRenderService(deps),
    tokens: createTokensService(deps),
    editor: createEditorService(deps),
    runs: createRunsService(deps),
  }
}
