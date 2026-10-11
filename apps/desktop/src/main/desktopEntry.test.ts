import { describe, expect, it } from 'vitest'
import { quoteExecArg, renderDesktopEntry } from './desktopEntry.js'

describe('Desktop Entry Exec quoting', () => {
  it.each([
    ['/opt/narrative/electron', '"/opt/narrative/electron"'],
    ['/home/p/My Apps/electron', '"/home/p/My Apps/electron"'],
    ['/home/p/$HOME/x', '"/home/p/\\\\$HOME/x"'],
    ['/home/p/say "hi"/x', '"/home/p/say \\\\"hi\\\\"/x"'],
    ['/home/p/back\\slash', '"/home/p/back\\\\\\\\slash"'],
    ['/home/p/100%/x', '"/home/p/100%%/x"'],
    ['/home/p/`cmd`', '"/home/p/\\\\`cmd\\\\`"'],
  ])('quotes %s', (arg, quoted) => {
    expect(quoteExecArg(arg)).toBe(quoted)
  })

  it('renders an entry for a URL scheme', () => {
    const text = renderDesktopEntry({
      name: 'Narrative Dev',
      exec: ['/opt/e/electron', '/home/p/app'],
      fieldCode: '%U',
      mimeTypes: ['x-scheme-handler/narrative-dev'],
      noDisplay: true,
    })
    expect(text).toContain('Exec="/opt/e/electron" "/home/p/app" %U\n')
    expect(text).toContain('MimeType=x-scheme-handler/narrative-dev;\n')
    expect(text).toContain('NoDisplay=true\n')
  })
})
