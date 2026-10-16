/**
 * actions/catalog.ts — every action a person reaches through a keyboard
 * shortcut, a context or dropdown menu, or a toolbar button, and how an
 * agent reaches the same outcome (ADR 0010, plan §9.1 guard 2).
 *
 * Each action is one of:
 *
 *   - `commands`: the commands that carry its effect — the ones its handler
 *     dispatches, or, for a mode that ends in a write (a drawing tool), the
 *     command the write goes through. An agent does the same with them.
 *   - `editorOnly`: it changes nothing an agent could share — the viewport,
 *     the selection, the local clipboard, the editor's own undo history,
 *     navigation — and says why.
 *   - `planned`: shown in the UI but not built yet; no command exists.
 *
 * The binding sites name their action: `ShortcutBinding.action`, the
 * `action` prop of the menu items (components/ui), and `data-action` on the
 * toolbar's buttons. `catalog.test.ts` checks that every named command
 * exists, that every action is used, and that no toolbar button lacks one —
 * so a new shortcut, menu item or button cannot ship without saying how an
 * agent does it.
 */

export type UserAction =
  | { label: string; commands: readonly [string, ...string[]] }
  | { label: string; editorOnly: string }
  | { label: string; planned: string }

const EDITOR_UNDO =
  "the editor's own undo history (Yjs UndoManager over the person's edits); an agent undoes its work with agent.revert"
const VIEWPORT = 'moves the viewport only; the document does not change'
const SELECTION = "changes the person's selection only; agents address objects by id"
const TOOL_MODE = 'arms a canvas mode; nothing is written until the person acts'
const NAVIGATION = 'navigates the web app; nothing in the document changes'
const CLIPBOARD =
  "fills the editor's local clipboard; an agent reads objects with query.slide / query.object instead"

export const USER_ACTIONS = {
  // --- History -----------------------------------------------------------
  'history.undo': { label: 'Undo', editorOnly: EDITOR_UNDO },
  'history.redo': { label: 'Redo', editorOnly: EDITOR_UNDO },

  // --- View ---------------------------------------------------------------
  'view.zoomIn': { label: 'Zoom in', editorOnly: VIEWPORT },
  'view.zoomOut': { label: 'Zoom out', editorOnly: VIEWPORT },
  'view.resetZoom': { label: 'Reset zoom', editorOnly: VIEWPORT },
  'view.toggleRulers': {
    label: 'Toggle rulers',
    editorOnly: "shows or hides the editor's rulers; guides themselves are guide.* commands",
  },
  'view.toggleSnapping': {
    label: 'Toggle snapping',
    editorOnly: 'a drag-time aid in the editor; commands take exact positions',
  },
  'view.shortcuts': {
    label: 'Keyboard shortcuts cheatsheet',
    editorOnly: 'opens a help overlay listing the shortcuts',
  },

  // --- Selection ----------------------------------------------------------
  'selection.all': { label: 'Select all objects', editorOnly: SELECTION },
  'selection.clear': {
    label: 'Cancel pen path / crop / point edit, clear the selection',
    editorOnly: 'leaves an editor mode or clears the selection; nothing is written',
  },

  // --- Tools --------------------------------------------------------------
  'tool.select': { label: 'Select tool', editorOnly: TOOL_MODE },
  'tool.hand': { label: 'Hand / pan tool', editorOnly: VIEWPORT },
  'tool.text': { label: 'Text tool', commands: ['object.create'] },
  'tool.table': { label: 'Table tool', commands: ['table.insert'] },
  'tool.shape': { label: 'Shape tools', commands: ['object.create'] },
  'tool.pen': { label: 'Pen tool', commands: ['object.path.create'] },
  'pen.commit': { label: 'Commit pen path', commands: ['object.path.create'] },

  // --- Media and components -------------------------------------------------
  'media.insertImage': { label: 'Insert image', commands: ['media.upload', 'object.create'] },
  'media.insertVideo': { label: 'Insert video', commands: ['media.upload', 'object.create'] },
  'media.insertMenu': {
    label: 'Insert media menu',
    editorOnly: 'opens the menu of media kinds; each item is its own action',
  },
  'component.picker': { label: 'Add component', commands: ['component.list', 'component.stamp'] },
  'component.promote': { label: 'Promote to component', commands: ['component.promote'] },

  // --- Objects ------------------------------------------------------------
  'object.delete': { label: 'Delete selected object(s)', commands: ['object.delete'] },
  'object.duplicate': { label: 'Duplicate selected object(s)', commands: ['object.duplicate'] },
  'object.copy': { label: 'Copy', editorOnly: CLIPBOARD },
  'object.cut': { label: 'Cut', commands: ['object.delete'] },
  'object.paste': {
    label: 'Paste',
    commands: ['object.copyTo', 'object.insert', 'object.insertFromDeck'],
  },
  'object.group': { label: 'Group', commands: ['object.group'] },
  'object.ungroup': { label: 'Ungroup', commands: ['object.ungroup'] },
  'object.bringForward': { label: 'Bring forward', commands: ['object.layer'] },
  'object.sendBackward': { label: 'Send backward', commands: ['object.layer'] },
  'object.bringToFront': { label: 'Bring to front', commands: ['object.layer'] },
  'object.sendToBack': { label: 'Send to back', commands: ['object.layer'] },
  'object.nudge': { label: 'Nudge (Shift ×10)', commands: ['object.move'] },
  'object.toggleLock': { label: 'Lock / unlock', commands: ['object.update'] },
  'object.hide': {
    label: 'Hide',
    planned: 'hiding an object is not built yet (P12); the menu item is disabled',
  },
  'object.hyperlink': { label: 'Hyperlink…', commands: ['object.update'] },
  'object.mask': { label: 'Mask with shape', commands: ['object.mask.apply'] },
  'object.insertShape': { label: 'Insert shape', commands: ['object.create'] },

  // --- Tables -------------------------------------------------------------
  'table.insertRowAbove': { label: 'Insert row above', commands: ['table.row.insert'] },
  'table.insertRowBelow': { label: 'Insert row below', commands: ['table.row.insert'] },
  'table.insertColumnBefore': { label: 'Insert column left', commands: ['table.col.insert'] },
  'table.insertColumnAfter': { label: 'Insert column right', commands: ['table.col.insert'] },
  'table.deleteRow': { label: 'Delete row', commands: ['table.row.delete'] },
  'table.deleteColumn': { label: 'Delete column', commands: ['table.col.delete'] },
  'table.merge': { label: 'Merge cells', commands: ['table.merge'] },
  'table.split': { label: 'Split cell', commands: ['table.split'] },

  // --- Guides -------------------------------------------------------------
  'guide.remove': { label: 'Remove guide', commands: ['guide.remove'] },

  // --- Slides -------------------------------------------------------------
  'slide.next': { label: 'Next slide', editorOnly: SELECTION },
  'slide.previous': { label: 'Previous slide', editorOnly: SELECTION },
  'slide.open': { label: 'Open the active slide', editorOnly: SELECTION },
  'slide.rename': { label: 'Rename slide', commands: ['slide.rename'] },
  'slide.duplicate': { label: 'Duplicate slide', commands: ['slide.duplicate'] },
  'slide.copy': {
    label: 'Copy slide(s)',
    editorOnly:
      "fills the editor's slide clipboard; an agent copies slides with slide.copyTo or deck.insertFrom",
  },
  'slide.paste': { label: 'Paste slide(s)', commands: ['slide.copyTo', 'deck.insertFrom'] },
  'slide.toggleSkip': { label: 'Skip / unskip slide', commands: ['slide.skip'] },
  'slide.delete': { label: 'Delete slide', commands: ['slide.delete'] },
  'slide.exportPng': { label: 'Export slide as PNG', commands: ['deck.exportPng'] },
  'slide.transition': { label: 'Transition settings', commands: ['slide.setTransition'] },

  // --- Text styles ----------------------------------------------------------
  'textStyle.reset': { label: 'Reset to preset', commands: ['text.style.apply'] },
  'textStyle.update': { label: 'Update preset', commands: ['text.style.updateFromObject'] },
  'textStyle.create': { label: 'Create new text style', commands: ['text.style.createFromObject'] },

  // --- Animation ----------------------------------------------------------
  'animation.delete': { label: 'Delete animation step', commands: ['animation.remove'] },

  // --- Deck ---------------------------------------------------------------
  'deck.share': {
    label: 'Share deck',
    commands: ['share.permissions.invite', 'share.links.create'],
  },
  'deck.rename': { label: 'Rename deck', commands: ['deck.rename'] },
  'deck.duplicate': { label: 'Duplicate deck', commands: ['deck.duplicate'] },
  'deck.moveToFolder': { label: 'Move deck to…', commands: ['deck.moveToFolder'] },
  'deck.delete': { label: 'Delete deck', commands: ['deck.delete'] },
  'deck.exportMenu': {
    label: 'Export menu',
    editorOnly: 'opens the menu of export formats; each item is its own action',
  },
  'deck.exportPptx': { label: 'Export to PowerPoint', commands: ['deck.exportPptx'] },
  'deck.exportPdf': { label: 'Export to PDF', commands: ['deck.exportPdf'] },
  'deck.backToList': { label: 'Back to deck list', editorOnly: NAVIGATION },
  'deck.backToPresentation': { label: 'Back to presentation', editorOnly: NAVIGATION },

  // --- Folders ------------------------------------------------------------
  'folder.rename': { label: 'Rename folder', commands: ['folder.rename'] },
  'folder.settings': { label: 'Folder settings', editorOnly: NAVIGATION },
  'folder.share': {
    label: 'Share folder',
    commands: [
      'folder.members.invite',
      'folder.members.setRole',
      'folder.members.remove',
      'folder.invites.cancel',
    ],
  },
  'folder.delete': { label: 'Delete folder', commands: ['folder.delete'] },
  'stylePack.compile': { label: 'Compile the style pack', commands: ['style.pack.edit'] },
  'stylePack.import': { label: 'Import a style pack', commands: ['style.pack.edit'] },
  'stylePack.export': { label: 'Export the style pack', commands: ['style.pack.get'] },
  'stylePack.delete': { label: 'Delete the style pack', commands: ['style.pack.edit'] },

  // --- Presenting ---------------------------------------------------------
  'present.start': { label: 'Present', commands: ['editor.present.link'] },
  'present.preview': { label: 'Preview animations', commands: ['editor.present.link'] },
  'present.exit': { label: 'Exit presentation', editorOnly: NAVIGATION },
  'present.next': {
    label: 'Next slide / build',
    editorOnly: 'steps through a presentation someone is watching',
  },
  'present.previous': {
    label: 'Previous slide / build',
    editorOnly: 'steps through a presentation someone is watching',
  },
  'present.fullscreen': { label: 'Toggle fullscreen', editorOnly: 'a browser display mode' },
  'present.presenterView': {
    label: 'Toggle presenter view',
    editorOnly: "switches the presenter's own screen layout",
  },

  // --- Account ------------------------------------------------------------
  'account.accessTokens': {
    label: 'Access tokens',
    editorOnly:
      'opens the page where a person creates access tokens for agents; tokens are never an agent capability',
  },
  'account.admin': {
    label: 'Administration',
    editorOnly:
      'opens the admin screen where an instance admin decides who may sign in and who is an admin; ' +
      'deliberately not an agent capability (parity/allowlist.ts, ADR 0014)',
  },
  'account.signOut': { label: 'Sign out', editorOnly: "ends the person's own session" },
} as const satisfies Record<string, UserAction>

export type ActionId = keyof typeof USER_ACTIONS
