/**
 * desktop/DesktopBridge.tsx
 *
 * Connects the editor to the desktop app's shell when it runs inside it
 * (ADR 0015); renders nothing, and does nothing in a browser. It sends the
 * editor's menu after every route change (the shell resets its menu on each
 * navigation, so a page that left never leaves its items behind), runs the
 * menu's clicks, and queues the PowerPoint files the app was asked to open —
 * going to the deck list, which imports them, when no import screen is open.
 */

import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { desktopBridge } from './bridge.js'
import { desktopMenuFor } from './menu.js'
import { dispatchMenuAction } from './menuDispatch.js'
import { enqueueOpenedFile, hasOpenedFileConsumer } from './openedFiles.js'

export function DesktopBridge(): null {
  const location = useLocation()
  // useNavigate() changes identity with every route; the listeners are
  // registered once (a re-registration re-subscribes, and the shell then
  // announces every waiting file again).
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  useEffect(() => {
    const bridge = desktopBridge()
    if (bridge === undefined) return
    const offMenu = bridge.onMenuAction(dispatchMenuAction)
    const offFiles = bridge.onOpenFile((file) => {
      enqueueOpenedFile(file)
      if (!hasOpenedFileConsumer()) void navigateRef.current('/')
    })
    return () => {
      offMenu()
      offFiles()
    }
  }, [])

  useEffect(() => {
    desktopBridge()?.setMenu(desktopMenuFor(location.pathname))
  }, [location.pathname])

  useEffect(
    () => () => {
      desktopBridge()?.setMenu([])
    },
    [],
  )

  return null
}
