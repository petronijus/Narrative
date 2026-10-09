import { Checks, allCalls, callsOf } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'

/**
 * folder.members.setRole and folder.members.remove (folder sharing,
 * follow-up of step 4): the user's folder is shared with two colleagues as
 * editors, and the user asks to make one of them view-only and to take the
 * other off the folder. The agent changes exactly those two memberships,
 * each after the user confirms (the harness approves every confirmation the
 * agent asked for between the steps, as on Narrative's page); the user stays
 * the owner and no deck is shared or unshared on its own.
 *
 * Live-only: the confirmations are approved on the page, and the memory
 * world has one user.
 */

interface Member {
  userId: string
  role: string
  email: string | null
}

/** Every `"confirmationId": "<id>"` in a text. */
function confirmationIdsIn(text: string): string[] {
  return [...text.matchAll(/"confirmationId": "([A-Za-z0-9_-]{22})"/g)].map((m) => m[1]!)
}

export default defineScenario({
  id: 'folder-member-change',
  title: 'Make one folder member view-only and remove another',
  covers: ['folder.members.list', 'folder.members.setRole', 'folder.members.remove'],
  maxTurns: 12,
  replay: {
    reason:
      "the changes need confirmations approved on Narrative's page and second persons; the memory world models neither",
  },
  async setup(world) {
    const designer = await world.person('designer')
    const contractor = await world.person('contractor')
    const folderName = `Client Plover ${world.tag}`
    const folderId = await world.createFolder(folderName)
    await world.createDeck(`Brand book ${world.tag}`, folderId)
    for (const person of [designer, contractor]) {
      await world.run(
        { folderId },
        'folder.members.invite',
        { email: person.email, role: 'editor' },
        { confirm: ['folder.members.invite'] },
      )
    }
    return {
      folderId,
      folderName,
      designerId: designer.userId,
      designerEmail: designer.email,
      contractorId: contractor.userId,
      contractorEmail: contractor.email,
    }
  },
  steps: (fx) => [
    `In my Narrative folder "${fx.folderName}", make ${fx.designerEmail} view-only, and take ${fx.contractorEmail} off the folder completely.`,
    'I approved it in Narrative. Go ahead.',
  ],
  async afterStep(world, _fx, index, notes, transcript) {
    if (index !== 0) return
    const asked = (transcript.steps[0]?.calls ?? []).filter(
      (call) =>
        (call.command === 'folder.members.setRole' || call.command === 'folder.members.remove') &&
        call.errorCode === 'confirmation_required',
    )
    notes['asked'] = asked.map((call) => call.command)
    for (const id of new Set(asked.flatMap((call) => confirmationIdsIn(call.text)))) {
      await world.approveConfirmation(id)
    }
  },
  async grade({ world, fixture: fx, transcript, notes }) {
    const c = new Checks()
    const asked = new Set((notes['asked'] as string[] | undefined) ?? [])
    c.ok(
      'both changes asked for the user’s confirmation first',
      asked.has('folder.members.setRole') && asked.has('folder.members.remove'),
      [...asked].join(', '),
    )
    c.eq(
      'the designer’s role was changed to viewer, and nobody else’s',
      callsOf(transcript, 'folder.members.setRole', { ok: true }).map((call) => [
        call.input['userId'],
        call.input['role'],
      ]),
      [[fx.designerId, 'viewer']],
    )
    c.eq(
      'the contractor was removed, and nobody else',
      callsOf(transcript, 'folder.members.remove', { ok: true }).map(
        (call) => call.input['userId'],
      ),
      [fx.contractorId],
    )
    c.eq(
      'no deck was shared or unshared on its own',
      allCalls(transcript)
        .filter((call) => call.command?.startsWith('share.') === true && !call.isError)
        .filter((call) => !/\.(list|get)$/.test(call.command ?? ''))
        .map((call) => call.command),
      [],
    )
    const { members } = await world.run<{ members: Member[] }>(
      { folderId: fx.folderId },
      'folder.members.list',
    )
    const roleOf = (userId: string) => members.find((m) => m.userId === userId)?.role ?? null
    c.eq('the designer is a viewer now', roleOf(fx.designerId), 'viewer')
    c.eq('the contractor is no member any more', roleOf(fx.contractorId), null)
    const ownEmail = await world.userEmail()
    c.eq(
      'the user is still the folder’s owner',
      members.find((m) => m.email === ownEmail)?.role ?? null,
      'owner',
    )
    return c.done()
  },
})
