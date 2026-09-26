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
import { textCommands } from './commands/text.js'
import { tableCommands } from './commands/tables.js'
import { animationCommands } from './commands/animations.js'
import { guideCommands } from './commands/guides.js'
import { queryCommands } from './commands/queries.js'
import { createOpsApply } from './commands/ops.js'

export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry()
  registry.registerAll(slideCommands)
  registry.registerAll(objectCommands)
  registry.registerAll(objectEditCommands)
  registry.registerAll(textCommands)
  registry.registerAll(tableCommands)
  registry.registerAll(animationCommands)
  registry.registerAll(guideCommands)
  registry.registerAll(queryCommands)
  registry.register(createOpsApply(registry))
  return registry
}
