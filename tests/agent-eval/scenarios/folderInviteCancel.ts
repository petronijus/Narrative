import { Checks, allCalls, callsOf } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'

/**
 * folder.invites.cancel (folder sharing, follow-up of step 4): the user
 * shared a folder with an address nobody uses Narrative with yet — a
 * PENDING invite — and asks to take it back. The agent finds the invite
 * (folder.invites.list) and withdraws exactly that one after the user
 * confirms (the harness approves between the steps, as on Narrative's
 * page). Another pending invite stays, and a colleague who already is a
 * member keeps their access: withdrawing an invite is not removing a member.
 *
 * The pending address is on the dev stack's `.test` domain, so the
 * invitation email reaches nobody. Live-only: the confirmation is approved
 * on the page, and the memory world has one user.
 */

interface Invite {
  id: string
  email: string
}

interface Member {
  userId: string
  role: string
}

/** The id in `"confirmationId": "<id>"` of a confirmation_required message. */
function confirmationIdIn(text: string): string | null {
  return /"confirmationId": "([A-Za-z0-9_-]{22})"/.exec(text)?.[1] ?? null
}

export default defineScenario({
  id: 'folder-invite-cancel',
  title: 'Withdraw a pending folder invite, and only that',
  covers: ['folder.invites.list', 'folder.invites.cancel'],
  maxTurns: 10,
  replay: {
    reason:
      "the cancel needs a confirmation approved on Narrative's page and a second person; the memory world models neither",
  },
  async setup(world) {
    const colleague = await world.person('colleague')
    const folderName = `Client Osprey ${world.tag}`
    const folderId = await world.createFolder(folderName)
    const pendingEmail = `pending-${world.tag}@dev.narrative.test`
    // A second pending invite that must survive: withdrawing one is not
    // withdrawing all.
    const keptEmail = `keep-${world.tag}@dev.narrative.test`
    for (const [email, role] of [
      [pendingEmail, 'editor'],
      [keptEmail, 'viewer'],
      [colleague.email, 'viewer'],
    ] as const) {
      await world.run(
        { folderId },
        'folder.members.invite',
        { email, role },
        { confirm: ['folder.members.invite'] },
      )
    }
    const { invites } = await world.run<{ invites: Invite[] }>({ folderId }, 'folder.invites.list')
    const invite = invites.find((i) => i.email === pendingEmail)
    if (invite === undefined) throw new Error(`no pending invite for ${pendingEmail}`)
    return {
      folderId,
      folderName,
      pendingEmail,
      keptEmail,
      inviteId: invite.id,
      colleagueId: colleague.userId,
    }
  },
  steps: (fx) => [
    `In my Narrative folder "${fx.folderName}", withdraw the invitation that is still pending for ${fx.pendingEmail} — they should not get access after all.`,
    'I approved it in Narrative. Go ahead.',
  ],
  async afterStep(world, _fx, index, notes, transcript) {
    if (index !== 0) return
    const asked = (transcript.steps[0]?.calls ?? []).filter(
      (call) =>
        call.command === 'folder.invites.cancel' && call.errorCode === 'confirmation_required',
    )
    const last = asked.at(-1)
    if (last === undefined) return
    notes['asked'] = true
    const id = confirmationIdIn(last.text)
    if (id !== null) await world.approveConfirmation(id)
  },
  async grade({ world, fixture: fx, transcript, notes }) {
    const c = new Checks()
    c.ok('the cancel asked for the user’s confirmation first', notes['asked'] === true)
    c.eq(
      'exactly that invite was withdrawn',
      callsOf(transcript, 'folder.invites.cancel', { ok: true }).map(
        (call) => call.input['inviteId'],
      ),
      [fx.inviteId],
    )
    c.eq(
      'no member was removed and no role changed',
      allCalls(transcript)
        .filter((call) => /^folder\.members\.(remove|setRole)$/.test(call.command ?? ''))
        .map((call) => call.command),
      [],
    )
    const { invites } = await world.run<{ invites: Invite[] }>(
      { folderId: fx.folderId },
      'folder.invites.list',
    )
    c.eq(
      'no invite is pending for that address any more, and the other one still is',
      invites
        .filter((i) => i.email === fx.pendingEmail || i.email === fx.keptEmail)
        .map((i) => i.email),
      [fx.keptEmail],
    )
    const { members } = await world.run<{ members: Member[] }>(
      { folderId: fx.folderId },
      'folder.members.list',
    )
    c.eq(
      'the colleague is still a member, as a viewer',
      members.find((m) => m.userId === fx.colleagueId)?.role ?? null,
      'viewer',
    )
    return c.done()
  },
})
