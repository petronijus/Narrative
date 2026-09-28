import { describe, expect, it } from 'vitest'
import { NOTES_LINK_DEFAULTS, type NotesDoc } from '@narrative/slide-model'
import { notesFromMarkdown, notesToMarkdown } from './markdown.js'

const p = (...content: NotesDoc) => ({ type: 'paragraph', content })

describe('notesFromMarkdown', () => {
  it('maps blocks onto the notes editor schema', () => {
    expect(
      notesFromMarkdown(
        [
          '# Opening',
          '',
          'Say hello.',
          '',
          '- one',
          '  - nested',
          '- two',
          '',
          '3. third',
          '4. fourth',
          '',
          '> quoted',
          '',
          '```ts',
          'const x = 1',
          '```',
          '',
          '---',
        ].join('\n'),
      ),
    ).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ text: 'Opening' }] },
      p({ text: 'Say hello.' }),
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              p({ text: 'one' }),
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [p({ text: 'nested' })] }],
              },
            ],
          },
          { type: 'listItem', content: [p({ text: 'two' })] },
        ],
      },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [
          { type: 'listItem', content: [p({ text: 'third' })] },
          { type: 'listItem', content: [p({ text: 'fourth' })] },
        ],
      },
      { type: 'blockquote', content: [p({ text: 'quoted' })] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ text: 'const x = 1' }] },
      { type: 'horizontalRule' },
    ])
  })

  it('maps inline formatting onto marks, links with the editor defaults', () => {
    expect(
      notesFromMarkdown(
        'A **bold *both*** ~~gone~~ `code` <u>under</u> [site](https://example.com/talk)',
      ),
    ).toEqual([
      p(
        { text: 'A ' },
        { text: 'bold ', marks: { bold: {} } },
        { text: 'both', marks: { bold: {}, italic: {} } },
        { text: ' ' },
        { text: 'gone', marks: { strike: {} } },
        { text: ' ' },
        { text: 'code', marks: { code: {} } },
        { text: ' ' },
        { text: 'under', marks: { underline: {} } },
        { text: ' ' },
        {
          text: 'site',
          marks: { link: { href: 'https://example.com/talk', ...NOTES_LINK_DEFAULTS } },
        },
      ),
    ])
  })

  it('treats a newline inside a paragraph as a line break', () => {
    expect(notesFromMarkdown('first line\nsecond line')).toEqual([
      p({ text: 'first line' }, { type: 'hardBreak' }, { text: 'second line' }),
    ])
  })

  it('drops link targets the sanitiser refuses, keeping the text', () => {
    expect(notesFromMarkdown('[click](javascript:alert(1))')).toEqual([p({ text: 'click' })])
  })

  it('reads blank input as no notes', () => {
    expect(notesFromMarkdown('')).toEqual([])
    expect(notesFromMarkdown('  \n\n ')).toEqual([])
  })
})

describe('notesToMarkdown', () => {
  it('renders empty notes as an empty string', () => {
    expect(notesToMarkdown([])).toBe('')
  })

  it('round-trips everything the notes editor can hold', () => {
    const markdown = [
      '## Agenda',
      '',
      'Intro with **bold**, *italic*, ~~strike~~, `code`, <u>under</u> and a [link](https://example.com/talk).\\',
      'Next line.',
      '',
      '- first',
      '  - nested',
      '- second',
      '',
      '5. five',
      '6. six',
      '',
      '> A quote.',
      '',
      '```js',
      'let a = 1',
      '```',
      '',
      '---',
      '',
      'The end.',
    ].join('\n')
    const doc = notesFromMarkdown(markdown)
    expect(notesToMarkdown(doc)).toBe(markdown)
    expect(notesFromMarkdown(notesToMarkdown(doc))).toEqual(doc)
  })
})
