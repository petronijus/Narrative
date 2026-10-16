/**
 * email/notify.test.ts — an email of a kind is sent only while admins leave
 * the kind on (no row = on), never when its render returns null, and a
 * failure stays inside: the action it announces already happened.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendEmail = vi.fn(async () => 'sent')
vi.mock('./client.js', () => ({ sendEmail }))

const { notify } = await import('./notify.js')
const { scriptedDb } = await import('../test-support/scriptedDb.js')

const email = { subject: 'S', html: '<p>h</p>', text: 't', replyTo: 'petr@example.com' }
const log = { warn: vi.fn() }

beforeEach(() => {
  sendEmail.mockClear()
  log.warn.mockClear()
})

describe('notify', () => {
  it('sends a kind with no setting (on by default), lower-casing the address', async () => {
    const { db } = scriptedDb({ selects: [[]] })
    await notify({ db, log, kind: 'deleted', to: 'Jana@Example.com', render: () => email })
    expect(sendEmail).toHaveBeenCalledWith({
      to: 'jana@example.com',
      subject: 'S',
      html: '<p>h</p>',
      text: 't',
      replyTo: 'petr@example.com',
    })
  })

  it('sends nothing for a kind an admin turned off, and does not even render it', async () => {
    const { db } = scriptedDb({ selects: [[{ enabled: false }]] })
    const render = vi.fn(() => email)
    await notify({ db, log, kind: 'deleted', to: 'j@x.cz', render })
    expect(render).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('sends nothing when there is nothing to tell', async () => {
    const { db } = scriptedDb({ selects: [[{ enabled: true }]] })
    await notify({ db, log, kind: 'deleted', to: 'j@x.cz', render: () => null })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('logs a failure instead of throwing it', async () => {
    const { db } = scriptedDb({ selects: [[]] })
    await expect(
      notify({
        db,
        log,
        kind: 'deleted',
        to: 'j@x.cz',
        render: () => {
          throw new Error('boom')
        },
      }),
    ).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalled()
  })
})
