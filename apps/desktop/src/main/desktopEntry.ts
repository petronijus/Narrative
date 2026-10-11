/**
 * main/desktopEntry.ts
 *
 * Desktop Entry files (freedesktop.org), which register the dev build's
 * `narrative-dev://` scheme on Linux (main/protocol.ts). An `Exec` argument
 * is quoted as the specification requires: inside double quotes `"`, `` ` ``,
 * `$` and `\` are escaped with a backslash, the string value level then
 * doubles every backslash once more, and `%` (field codes) is written `%%`.
 * Pure: no Electron here.
 */

export function quoteExecArg(arg: string): string {
  // A newline would start another key of the entry; no path has one.
  if (/[\x00-\x1f\x7f]/.test(arg))
    throw new Error('a control character in a Desktop Entry argument')
  const quoted = `"${arg.replace(/(["`$\\])/g, '\\$1')}"`
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

export interface DesktopEntry {
  name: string
  exec: readonly string[]
  /** Field code appended to Exec (`%U`: URLs). */
  fieldCode: '%U' | '%u' | '%F' | '%f'
  mimeTypes: readonly string[]
  noDisplay: boolean
  /** An icon name from the icon theme, or an absolute path. */
  icon?: string
  categories?: readonly string[]
}

export function renderDesktopEntry(entry: DesktopEntry): string {
  const exec = `${entry.exec.map(quoteExecArg).join(' ')} ${entry.fieldCode}`
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${entry.name.replace(/[\r\n]/g, ' ')}`,
    `Exec=${exec}`,
    ...(entry.icon !== undefined ? [`Icon=${entry.icon.replace(/[\r\n]/g, '')}`] : []),
    ...(entry.categories !== undefined
      ? [`Categories=${entry.categories.map((c) => `${c};`).join('')}`]
      : []),
    'Terminal=false',
    `NoDisplay=${entry.noDisplay ? 'true' : 'false'}`,
    `MimeType=${entry.mimeTypes.map((m) => `${m};`).join('')}`,
    '',
  ].join('\n')
}
