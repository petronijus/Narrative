/**
 * coverage.ts — every user action and every command names its benchmark, or
 * says why it has none (docs/plans/perf-harness.md → Design principles 2),
 * guarded like agent parity (`coverage.test.ts`, in `just check`).
 *
 * A bench covers what its definition lists in `actions` / `commands`
 * (benches.ts); everything else needs an entry below. The guard fails on:
 *
 *   - an action of USER_ACTIONS (apps/web/src/actions/catalog.ts) or a
 *     command of the registry (packages/commands) that is neither benched
 *     nor exempted — so a NEW shortcut, menu item, button or command cannot
 *     ship without a decision about its benchmark;
 *   - an exemption for an id that no longer exists, or for one a bench now
 *     covers (delete the entry when its bench lands);
 *   - a bench naming an action or command that does not exist;
 *   - a reason other than NOT_YET_BENCHED that does not say why (under 20
 *     characters), as in the action catalog.
 *
 * The lists were generated (2026-10-18) with every id as NOT_YET_BENCHED;
 * step 2 took the ids the layer I scenarios cover off them. Grouped as the
 * catalog and the registry's domains group them. A new entry goes into its group; a deliberate "never benched"
 * gets its own reason.
 *
 * Data and a pure function only: no import of the web app or the registry,
 * so nothing here runs at import time.
 */

import type { BenchDef } from './defineBench.js'

/** The default reason while the catalogue (perf-harness.md) is being built. */
export const NOT_YET_BENCHED = 'not yet benched'

export interface CoverageInput {
  actions: readonly string[]
  commands: readonly string[]
  benches: ReadonlyArray<Pick<BenchDef<never>, 'id' | 'actions' | 'commands'>>
  actionExemptions: Readonly<Record<string, string>>
  commandExemptions: Readonly<Record<string, string>>
}

export interface CoverageReport {
  /** `action <id>` / `command <id>` with neither a bench nor an exemption. */
  uncovered: string[]
  /** Exemptions for ids that do not exist. */
  staleExemptions: string[]
  /** Exemptions for ids a bench covers. */
  redundantExemptions: string[]
  /** `<bench>: action <id>` naming something that does not exist. */
  unknownTargets: string[]
  /** Exemptions whose reason does not say why. */
  weakReasons: string[]
  /** Bench ids per action / command, for the report. */
  benchedBy: { actions: Record<string, string[]>; commands: Record<string, string[]> }
}

export function coverageReport(input: CoverageInput): CoverageReport {
  const report: CoverageReport = {
    uncovered: [],
    staleExemptions: [],
    redundantExemptions: [],
    unknownTargets: [],
    weakReasons: [],
    benchedBy: { actions: {}, commands: {} },
  }
  const kinds = [
    ['action', input.actions, input.actionExemptions, 'actions'],
    ['command', input.commands, input.commandExemptions, 'commands'],
  ] as const
  for (const [kind, ids, exemptions, field] of kinds) {
    const known = new Set(ids)
    const benchedBy = report.benchedBy[field]
    for (const bench of input.benches)
      for (const id of bench[field] ?? []) {
        if (!known.has(id)) report.unknownTargets.push(`${bench.id}: ${kind} ${id}`)
        else (benchedBy[id] ??= []).push(bench.id)
      }
    for (const id of ids)
      if (benchedBy[id] === undefined && !Object.hasOwn(exemptions, id))
        report.uncovered.push(`${kind} ${id}`)
    for (const [id, reason] of Object.entries(exemptions)) {
      if (!known.has(id)) report.staleExemptions.push(`${kind} ${id}`)
      else if (benchedBy[id] !== undefined)
        report.redundantExemptions.push(`${kind} ${id} (benched by ${benchedBy[id].join(', ')})`)
      if (reason !== NOT_YET_BENCHED && reason.trim().length < 20)
        report.weakReasons.push(`${kind} ${id}`)
    }
  }
  return report
}

/** Whether the report has nothing to fix. */
export function coverageOk(r: CoverageReport): boolean {
  return (
    r.uncovered.length === 0 &&
    r.staleExemptions.length === 0 &&
    r.redundantExemptions.length === 0 &&
    r.unknownTargets.length === 0 &&
    r.weakReasons.length === 0
  )
}

/** User actions (apps/web/src/actions/catalog.ts → USER_ACTIONS) without a bench. */
export const ACTION_EXEMPTIONS: Readonly<Record<string, string>> = {
  // account
  'account.accessTokens': NOT_YET_BENCHED,
  'account.admin': NOT_YET_BENCHED,
  'account.signOut': NOT_YET_BENCHED,
  // animation
  'animation.delete': NOT_YET_BENCHED,
  // component
  'component.picker': NOT_YET_BENCHED,
  'component.promote': NOT_YET_BENCHED,
  // deck
  'deck.backToList': NOT_YET_BENCHED,
  'deck.backToPresentation': NOT_YET_BENCHED,
  'deck.delete': NOT_YET_BENCHED,
  'deck.duplicate': NOT_YET_BENCHED,
  'deck.exportMenu': NOT_YET_BENCHED,
  'deck.exportPdf': NOT_YET_BENCHED,
  'deck.exportPptx': NOT_YET_BENCHED,
  'deck.importPptx': NOT_YET_BENCHED,
  'deck.moveToFolder': NOT_YET_BENCHED,
  'deck.rename': NOT_YET_BENCHED,
  'deck.share': NOT_YET_BENCHED,
  // folder
  'folder.delete': NOT_YET_BENCHED,
  'folder.rename': NOT_YET_BENCHED,
  'folder.settings': NOT_YET_BENCHED,
  'folder.share': NOT_YET_BENCHED,
  // guide
  'guide.remove': NOT_YET_BENCHED,
  // history
  'history.redo': NOT_YET_BENCHED,
  'history.undo': NOT_YET_BENCHED,
  // media
  'media.insertImage': NOT_YET_BENCHED,
  'media.insertMenu': NOT_YET_BENCHED,
  'media.insertVideo': NOT_YET_BENCHED,
  // object
  'object.bringForward': NOT_YET_BENCHED,
  'object.bringToFront': NOT_YET_BENCHED,
  'object.copy': NOT_YET_BENCHED,
  'object.cut': NOT_YET_BENCHED,
  'object.delete': NOT_YET_BENCHED,
  'object.duplicate': NOT_YET_BENCHED,
  'object.group': NOT_YET_BENCHED,
  'object.hide': NOT_YET_BENCHED,
  'object.hyperlink': NOT_YET_BENCHED,
  'object.insertShape': NOT_YET_BENCHED,
  'object.mask': NOT_YET_BENCHED,
  'object.paste': NOT_YET_BENCHED,
  'object.sendBackward': NOT_YET_BENCHED,
  'object.sendToBack': NOT_YET_BENCHED,
  'object.toggleLock': NOT_YET_BENCHED,
  'object.ungroup': NOT_YET_BENCHED,
  // pen
  'pen.commit': NOT_YET_BENCHED,
  // present
  'present.chooseDisplay': NOT_YET_BENCHED,
  'present.exit': NOT_YET_BENCHED,
  'present.fullscreen': NOT_YET_BENCHED,
  'present.presenterView': NOT_YET_BENCHED,
  'present.preview': NOT_YET_BENCHED,
  // selection
  'selection.all': NOT_YET_BENCHED,
  'selection.clear': NOT_YET_BENCHED,
  // slide
  'slide.copy': NOT_YET_BENCHED,
  'slide.delete': NOT_YET_BENCHED,
  'slide.duplicate': NOT_YET_BENCHED,
  'slide.exportPng': NOT_YET_BENCHED,
  'slide.open': NOT_YET_BENCHED,
  'slide.paste': NOT_YET_BENCHED,
  'slide.rename': NOT_YET_BENCHED,
  'slide.toggleSkip': NOT_YET_BENCHED,
  'slide.transition': NOT_YET_BENCHED,
  // stylePack
  'stylePack.compile': NOT_YET_BENCHED,
  'stylePack.delete': NOT_YET_BENCHED,
  'stylePack.export': NOT_YET_BENCHED,
  'stylePack.import': NOT_YET_BENCHED,
  // table
  'table.deleteColumn': NOT_YET_BENCHED,
  'table.deleteRow': NOT_YET_BENCHED,
  'table.insertColumnAfter': NOT_YET_BENCHED,
  'table.insertColumnBefore': NOT_YET_BENCHED,
  'table.insertRowAbove': NOT_YET_BENCHED,
  'table.insertRowBelow': NOT_YET_BENCHED,
  'table.merge': NOT_YET_BENCHED,
  'table.split': NOT_YET_BENCHED,
  // textStyle
  'textStyle.create': NOT_YET_BENCHED,
  'textStyle.reset': NOT_YET_BENCHED,
  'textStyle.update': NOT_YET_BENCHED,
  // tool
  'tool.hand': NOT_YET_BENCHED,
  'tool.pen': NOT_YET_BENCHED,
  'tool.select': NOT_YET_BENCHED,
  'tool.shape': NOT_YET_BENCHED,
  'tool.table': NOT_YET_BENCHED,
  'tool.text': NOT_YET_BENCHED,
  // view
  'view.resetZoom': NOT_YET_BENCHED,
  'view.shortcuts': NOT_YET_BENCHED,
  'view.toggleRulers': NOT_YET_BENCHED,
  'view.toggleSnapping': NOT_YET_BENCHED,
}

/** Commands (packages/commands, the registry; capabilities.json lists them) without a bench. */
export const COMMAND_EXEMPTIONS: Readonly<Record<string, string>> = {
  // agent
  'agent.revert': NOT_YET_BENCHED,
  'agent.runs': NOT_YET_BENCHED,
  'agent.startRun': NOT_YET_BENCHED,
  // animation
  'animation.remove': NOT_YET_BENCHED,
  'animation.reorder': NOT_YET_BENCHED,
  'animation.retarget': NOT_YET_BENCHED,
  'animation.retime': NOT_YET_BENCHED,
  'animation.update': NOT_YET_BENCHED,
  // component
  'component.create': NOT_YET_BENCHED,
  'component.delete': NOT_YET_BENCHED,
  'component.get': NOT_YET_BENCHED,
  'component.list': NOT_YET_BENCHED,
  'component.promote': NOT_YET_BENCHED,
  'component.rename': NOT_YET_BENCHED,
  'component.restamp': NOT_YET_BENCHED,
  'component.stamp': NOT_YET_BENCHED,
  // deck
  'deck.activeEditors': NOT_YET_BENCHED,
  'deck.create': NOT_YET_BENCHED,
  'deck.delete': NOT_YET_BENCHED,
  'deck.duplicate': NOT_YET_BENCHED,
  'deck.exportPdf': NOT_YET_BENCHED,
  'deck.exportPng': NOT_YET_BENCHED,
  'deck.exportPptx': NOT_YET_BENCHED,
  'deck.fonts.list': NOT_YET_BENCHED,
  'deck.get': NOT_YET_BENCHED,
  'deck.importPptx': NOT_YET_BENCHED,
  'deck.insertFrom': NOT_YET_BENCHED,
  'deck.list': NOT_YET_BENCHED,
  'deck.moveToFolder': NOT_YET_BENCHED,
  'deck.refreshThumbnail': NOT_YET_BENCHED,
  'deck.rename': NOT_YET_BENCHED,
  // editor
  'editor.context': NOT_YET_BENCHED,
  'editor.present.link': NOT_YET_BENCHED,
  'editor.show': NOT_YET_BENCHED,
  // folder
  'folder.create': NOT_YET_BENCHED,
  'folder.delete': NOT_YET_BENCHED,
  'folder.fonts.delete': NOT_YET_BENCHED,
  'folder.fonts.list': NOT_YET_BENCHED,
  'folder.fonts.upload': NOT_YET_BENCHED,
  'folder.invites.cancel': NOT_YET_BENCHED,
  'folder.invites.list': NOT_YET_BENCHED,
  'folder.list': NOT_YET_BENCHED,
  'folder.members.invite': NOT_YET_BENCHED,
  'folder.members.list': NOT_YET_BENCHED,
  'folder.members.remove': NOT_YET_BENCHED,
  'folder.members.setRole': NOT_YET_BENCHED,
  'folder.rename': NOT_YET_BENCHED,
  // guide
  'guide.add': NOT_YET_BENCHED,
  'guide.remove': NOT_YET_BENCHED,
  'guide.update': NOT_YET_BENCHED,
  // media
  'media.delete': NOT_YET_BENCHED,
  'media.fontUrl': NOT_YET_BENCHED,
  'media.status': NOT_YET_BENCHED,
  'media.upload': NOT_YET_BENCHED,
  'media.uploadSession': NOT_YET_BENCHED,
  'media.url': NOT_YET_BENCHED,
  // object
  'object.align': NOT_YET_BENCHED,
  'object.alignToSlide': NOT_YET_BENCHED,
  'object.copyTo': NOT_YET_BENCHED,
  'object.create': NOT_YET_BENCHED,
  'object.crop.set': NOT_YET_BENCHED,
  'object.delete': NOT_YET_BENCHED,
  'object.distribute': NOT_YET_BENCHED,
  'object.duplicate': NOT_YET_BENCHED,
  'object.effects.shadow': NOT_YET_BENCHED,
  'object.fill.gradient': NOT_YET_BENCHED,
  'object.flip': NOT_YET_BENCHED,
  'object.group': NOT_YET_BENCHED,
  'object.insert': NOT_YET_BENCHED,
  'object.insertFromDeck': NOT_YET_BENCHED,
  'object.layer': NOT_YET_BENCHED,
  'object.line.setEndpoints': NOT_YET_BENCHED,
  'object.mask.apply': NOT_YET_BENCHED,
  'object.mask.remove': NOT_YET_BENCHED,
  'object.path.create': NOT_YET_BENCHED,
  'object.path.fromShape': NOT_YET_BENCHED,
  'object.path.setAnchors': NOT_YET_BENCHED,
  'object.resize': NOT_YET_BENCHED,
  'object.rotate': NOT_YET_BENCHED,
  'object.slideNumber.set': NOT_YET_BENCHED,
  'object.ungroup': NOT_YET_BENCHED,
  'object.update': NOT_YET_BENCHED,
  // ops
  'ops.apply': NOT_YET_BENCHED,
  // query
  'query.check': NOT_YET_BENCHED,
  'query.deck': NOT_YET_BENCHED,
  'query.object': NOT_YET_BENCHED,
  'query.render': NOT_YET_BENCHED,
  'query.slide': NOT_YET_BENCHED,
  // share
  'share.invites.cancel': NOT_YET_BENCHED,
  'share.invites.list': NOT_YET_BENCHED,
  'share.links.create': NOT_YET_BENCHED,
  'share.links.list': NOT_YET_BENCHED,
  'share.links.revoke': NOT_YET_BENCHED,
  'share.permissions.invite': NOT_YET_BENCHED,
  'share.permissions.list': NOT_YET_BENCHED,
  'share.permissions.revoke': NOT_YET_BENCHED,
  'share.permissions.setRole': NOT_YET_BENCHED,
  // slide
  'slide.applyLayout': NOT_YET_BENCHED,
  'slide.collapse': NOT_YET_BENCHED,
  'slide.copyTo': NOT_YET_BENCHED,
  'slide.delete': NOT_YET_BENCHED,
  'slide.duplicate': NOT_YET_BENCHED,
  'slide.indent': NOT_YET_BENCHED,
  'slide.notes.get': NOT_YET_BENCHED,
  'slide.notes.set': NOT_YET_BENCHED,
  'slide.rename': NOT_YET_BENCHED,
  'slide.setBackground': NOT_YET_BENCHED,
  'slide.skip': NOT_YET_BENCHED,
  // style
  'style.deck.apply': NOT_YET_BENCHED,
  'style.pack.edit': NOT_YET_BENCHED,
  'style.pack.get': NOT_YET_BENCHED,
  // table
  'table.border.preset': NOT_YET_BENCHED,
  'table.border.segment': NOT_YET_BENCHED,
  'table.col.delete': NOT_YET_BENCHED,
  'table.col.insert': NOT_YET_BENCHED,
  'table.insert': NOT_YET_BENCHED,
  'table.merge': NOT_YET_BENCHED,
  'table.resizeColumn': NOT_YET_BENCHED,
  'table.resizeRow': NOT_YET_BENCHED,
  'table.row.delete': NOT_YET_BENCHED,
  'table.row.insert': NOT_YET_BENCHED,
  'table.setSize': NOT_YET_BENCHED,
  'table.split': NOT_YET_BENCHED,
  'table.style.cell': NOT_YET_BENCHED,
  'table.style.range': NOT_YET_BENCHED,
  'table.style.table': NOT_YET_BENCHED,
  // text
  'text.format': NOT_YET_BENCHED,
  'text.list': NOT_YET_BENCHED,
  'text.replace': NOT_YET_BENCHED,
  'text.set': NOT_YET_BENCHED,
  'text.setBoxTypography': NOT_YET_BENCHED,
  'text.style.apply': NOT_YET_BENCHED,
  'text.style.createFromObject': NOT_YET_BENCHED,
  'text.style.updateFromObject': NOT_YET_BENCHED,
  // token
  'token.create': NOT_YET_BENCHED,
  'token.delete': NOT_YET_BENCHED,
  'token.list': NOT_YET_BENCHED,
  'token.seedDefaults': NOT_YET_BENCHED,
  'token.update': NOT_YET_BENCHED,
  'token.usages': NOT_YET_BENCHED,
}
