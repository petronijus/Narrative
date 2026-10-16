/**
 * email/notify.ts
 *
 * How the services send an email of a kind (email/catalog.ts): only when the
 * kind is on (`email_settings`, admins switch it in the admin screen; no row
 * means on), always fire-and-forget — an email is a nudge, the database row
 * it announces is the truth, so nothing here throws into the caller.
 */

import { eq } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../db/client.js'
import { emailSettings } from '../db/schema.js'
import type { EmailKind } from './catalog.js'
import { sendEmail } from './client.js'
import type { RenderedEmail } from './layout.js'

/** Whether admins left this kind of email on (the default). */
export async function isEmailEnabled(db: Database, kind: EmailKind): Promise<boolean> {
  const [row] = await db
    .select({ enabled: emailSettings.enabled })
    .from(emailSettings)
    .where(eq(emailSettings.kind, kind))
    .limit(1)
  return row?.enabled !== false
}

export type OutgoingEmail = RenderedEmail & { replyTo?: string }

export interface NotifyArgs {
  db: Database
  log: Pick<FastifyBaseLogger, 'warn'>
  kind: EmailKind
  to: string
  /**
   * Builds the email; may read the database (called only when the kind is
   * on). `replyTo`: where a reply goes — the person who acted, not noreply.
   */
  render: () => Promise<OutgoingEmail | null> | OutgoingEmail | null
}

/**
 * Send one email of `kind` in the background. `render` returning null sends
 * nothing (the thing it would describe is gone). Returns the promise for
 * tests; callers do not await it.
 */
export function notify(args: NotifyArgs): Promise<void> {
  return (async () => {
    try {
      if (!(await isEmailEnabled(args.db, args.kind))) return
      const email = await args.render()
      if (email === null) return
      await sendEmail({
        to: args.to.toLowerCase(),
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo === undefined ? {} : { replyTo: email.replyTo }),
      })
    } catch (err) {
      args.log.warn({ err, kind: args.kind }, '[email] notification failed')
    }
  })()
}
