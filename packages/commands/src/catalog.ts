/**
 * commands/src/catalog.ts
 *
 * The default registry: every command Narrative offers. Hosts import
 * `createDefaultRegistry()`; the parity test and the capability manifest
 * are computed from it, so a command that is not registered here does not
 * exist as far as agents are concerned.
 */

import { CommandRegistry } from './registry.js'
import { slideCommands } from './commands/slides.js'
import { objectCommands } from './commands/objects.js'
import { objectEditCommands } from './commands/objectEdit.js'
import { transformCommands } from './commands/transforms.js'
import { appearanceCommands } from './commands/appearance.js'
import { pathCommands } from './commands/paths.js'
import { insertCommands } from './commands/insert.js'
import { textCommands } from './commands/text.js'
import { tableCommands } from './commands/tables.js'
import { typographyCommands } from './commands/typography.js'
import { textEditCommands } from './commands/textEdit.js'
import { animationCommands } from './commands/animations.js'
import { guideCommands } from './commands/guides.js'
import { queryCommands } from './commands/queries.js'
import { agentCommands } from './commands/agent.js'
import { editorCommands } from './commands/editor.js'
import { deckCommands } from './commands/decks.js'
import { folderCommands } from './commands/folders.js'
import { shareCommands } from './commands/sharing.js'
import { folderSharingCommands } from './commands/folderSharing.js'
import { mediaCommands } from './commands/media.js'
import { componentCommands } from './commands/components.js'
import { pptxCommands } from './commands/pptx.js'
import { renderCommands } from './commands/render.js'
import { tokenCommands } from './commands/tokens.js'
import { stylePackCommands } from './commands/stylePacks.js'
import { layoutCommands } from './commands/layouts.js'
import { checkCommands } from './commands/check.js'
import { createOpsApply } from './commands/ops.js'

export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry()
  registry.registerAll(slideCommands)
  registry.registerAll(objectCommands)
  registry.registerAll(objectEditCommands)
  registry.registerAll(transformCommands)
  registry.registerAll(appearanceCommands)
  registry.registerAll(pathCommands)
  registry.registerAll(insertCommands)
  registry.registerAll(textCommands)
  registry.registerAll(tableCommands)
  registry.registerAll(typographyCommands)
  registry.registerAll(textEditCommands)
  registry.registerAll(animationCommands)
  registry.registerAll(guideCommands)
  registry.registerAll(queryCommands)
  registry.registerAll(agentCommands)
  registry.registerAll(editorCommands)
  registry.registerAll(deckCommands)
  registry.registerAll(folderCommands)
  registry.registerAll(shareCommands)
  registry.registerAll(folderSharingCommands)
  registry.registerAll(mediaCommands)
  registry.registerAll(componentCommands)
  registry.registerAll(pptxCommands)
  registry.registerAll(renderCommands)
  registry.registerAll(tokenCommands)
  registry.registerAll(stylePackCommands)
  registry.registerAll(layoutCommands)
  registry.registerAll(checkCommands)
  registry.register(createOpsApply(registry))
  return registry
}
