/**
 * present/PresentDisplayPicker.tsx
 *
 * "Display" in the presentation's corner: which display fullscreen (F) puts
 * the presentation on (present/presentScreen.ts). Shown only where the
 * browser can place a window on another display; opening it is the click
 * that may ask for the window-management permission.
 */

import { useState } from 'react'
import {
  canChooseDisplay,
  displayName,
  findChosenDisplay,
  listDisplays,
  readDisplayChoice,
  writeDisplayChoice,
  type DisplayScreen,
} from './presentScreen.js'

type PickerState =
  | { kind: 'closed' }
  | { kind: 'open'; screens: readonly DisplayScreen[]; chosen: DisplayScreen | null }
  | { kind: 'note'; text: string }

export function PresentDisplayPicker() {
  const [state, setState] = useState<PickerState>({ kind: 'closed' })
  if (!canChooseDisplay()) return null

  const open = async (): Promise<void> => {
    if (state.kind !== 'closed') {
      setState({ kind: 'closed' })
      return
    }
    const details = await listDisplays()
    if (details === null) {
      setState({ kind: 'note', text: 'Allow window management to choose a display.' })
    } else if (details.screens.length < 2) {
      setState({ kind: 'note', text: 'Only one display is connected.' })
    } else {
      setState({
        kind: 'open',
        screens: details.screens,
        chosen: findChosenDisplay(details.screens, readDisplayChoice()),
      })
    }
  }

  const choose = (screen: DisplayScreen | null): void => {
    writeDisplayChoice(screen)
    setState({ kind: 'closed' })
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void open()}
        aria-haspopup="menu"
        aria-expanded={state.kind === 'open'}
        className="rounded border border-white/20 px-2 py-0.5 text-xs text-white/60 hover:border-white/40 hover:text-white"
        title="Choose the display the presentation goes fullscreen on"
      >
        Display
      </button>
      {state.kind === 'note' && (
        <p
          role="status"
          className="absolute bottom-7 left-0 w-56 rounded bg-black/80 p-2 text-xs text-white/80"
        >
          {state.text}
        </p>
      )}
      {state.kind === 'open' && (
        <div
          role="menu"
          aria-label="Present on"
          className="absolute bottom-7 left-0 w-72 rounded border border-white/20 bg-black/90 p-1 text-xs text-white/80"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={state.chosen === null}
            data-action="present.chooseDisplay"
            onClick={() => choose(null)}
            className="block w-full rounded px-2 py-1 text-left hover:bg-white/10"
          >
            Where this window is
          </button>
          {state.screens.map((screen) => (
            <button
              key={`${screen.label}@${screen.left},${screen.top}`}
              type="button"
              role="menuitemradio"
              aria-checked={state.chosen === screen}
              data-action="present.chooseDisplay"
              onClick={() => choose(screen)}
              className="block w-full rounded px-2 py-1 text-left hover:bg-white/10"
            >
              {displayName(screen)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
