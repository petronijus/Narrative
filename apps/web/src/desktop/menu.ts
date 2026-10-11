/**
 * desktop/menu.ts
 *
 * The editor's part of the desktop app's menu bar (docs/plans/
 * desktop-d0-spec.md §5.2): sections of catalog actions, labelled from the
 * catalog, with the keys of DESKTOP_MENU_ACCELERATORS (shared with the
 * shell, which accepts no other). The page sends it with `setMenu`; a click
 * comes back as the action and runs exactly what its key would
 * (desktop/menuDispatch.ts).
 */

import {
  DESKTOP_MENU_ACCELERATORS,
  type DesktopMenuItem,
  type DesktopMenuSection,
} from '@narrative/shared'
import { USER_ACTIONS, type ActionId } from '../actions/catalog.js'

function item(action: ActionId, menuLabel?: string): DesktopMenuItem {
  const keys = DESKTOP_MENU_ACCELERATORS[action]
  return {
    action,
    label: menuLabel ?? USER_ACTIONS[action].label,
    ...(keys !== undefined ? { accelerator: keys.accelerator } : {}),
    ...(keys?.nativeFallback !== undefined ? { nativeFallback: keys.nativeFallback } : {}),
  }
}

export const DESKTOP_MENU: readonly DesktopMenuSection[] = [
  {
    id: 'edit',
    label: 'Edit',
    items: [
      item('history.undo'),
      item('history.redo'),
      'separator',
      item('object.cut'),
      item('object.copy'),
      item('object.paste', 'Paste'),
      item('object.duplicate', 'Duplicate'),
      item('object.delete', 'Delete'),
      'separator',
      item('selection.all', 'Select All'),
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      item('view.zoomIn', 'Zoom In'),
      item('view.zoomOut', 'Zoom Out'),
      item('view.resetZoom', 'Actual Size'),
      'separator',
      item('view.shortcuts', 'Keyboard Shortcuts'),
    ],
  },
  {
    id: 'arrange',
    label: 'Arrange',
    items: [
      item('object.group', 'Group'),
      item('object.ungroup', 'Ungroup'),
      'separator',
      item('object.bringToFront', 'Bring to Front'),
      item('object.bringForward', 'Bring Forward'),
      item('object.sendBackward', 'Send Backward'),
      item('object.sendToBack', 'Send to Back'),
    ],
  },
  { id: 'present', label: 'Present', items: [item('present.start', 'Present')] },
]
