/**
 * desktop/DesktopBridge.tsx
 *
 * Connects the editor to the desktop app's shell when it runs inside it
 * (ADR 0014); renders nothing, and does nothing in a browser. It sends the
 * editor's menu after every route change (the shell resets its menu on each
 * navigation, so a page that left never leaves its items behind) and runs
 * the menu's clicks.
 */

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { desktopBridge } from './bridge.js'
import { DESKTOP_MENU } from './menu.js'
import { dispatchMenuAction } from './menuDispatch.js'

export function DesktopBridge(): null {
  const location = useLocation()

  useEffect(() => {
    const bridge = desktopBridge()
    if (bridge === undefined) return
    return bridge.onMenuAction(dispatchMenuAction)
  }, [])

  useEffect(() => {
    desktopBridge()?.setMenu(DESKTOP_MENU)
  }, [location.pathname])

  useEffect(
    () => () => {
      desktopBridge()?.setMenu([])
    },
    [],
  )

  return null
}
