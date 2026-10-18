/**
 * ui/AutofitHeights.tsx — mounts the editor's write-back of a person's
 * growing text boxes (state/autofitHeights.ts) on the open deck: measured
 * with the text renderer itself, written with `object.update`. Not for a
 * viewer, who changes nothing.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { perfCount } from '@narrative/shared'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useCommand } from '../state/useCommand.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { watchAutofitHeights } from '../state/autofitHeights.js'
import { measureTextBoxLayout } from '../renderer/objectRenderers/textRenderer.js'

export function AutofitHeights(): null {
  const { deckCtx } = useSlideDoc()
  const { role } = useDeckRole()
  const command = useCommand()

  // The dispatcher changes with the page's context; the watcher outlives a render.
  const commandRef = useRef(command)
  useLayoutEffect(() => {
    commandRef.current = command
  })

  useEffect(() => {
    if (role === 'viewer') return
    return watchAutofitHeights(deckCtx.doc, {
      measure: (data) => {
        perfCount('text.autofit.measure')
        return measureTextBoxLayout(data).height
      },
      write: (slide, object, height) => {
        commandRef.current.tryRun('object.update', { slide, object, patch: { height } })
      },
    })
  }, [deckCtx, role])

  return null
}
