/**
 * desktop/DesktopBridge.tsx
 *
 * Connects the editor to the desktop app's shell when it runs inside it
 * (ADR 0014); renders nothing, and does nothing in a browser. It sends the
 * editor's menu after every route change (the shell resets its menu on each
 * navigation, so a page that left never leaves its items behind), runs the
 * menu's clicks, and queues the PowerPoint files the app was asked to open —
 * going to the deck list, which imports them, when no import screen is open.
 */

import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { desktopBridge } from './bridge.js'
import { DESKTOP_MENU } from './menu.js'
import { dispatchMenuAction } from './menuDispatch.js'
import { enqueueOpenedFile, hasOpenedFileConsumer } from './openedFiles.js'

export function DesktopBridge(): null {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    const bridge = desktopBridge()
    if (bridge === undefined) return
    const offMenu = bridge.onMenuAction(dispatchMenuAction)
    const offFiles = bridge.onOpenFile((file) => {
      enqueueOpenedFile(file)
      if (!hasOpenedFileConsumer()) void navigate('/')
    })
    return () => {
      offMenu()
      offFiles()
    }
  }, [navigate])

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
