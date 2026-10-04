import { Checks, allCalls, callsOf } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'

/**
 * folder.members.invite, positive (folder sharing step 4): the user asks to
 * share a whole folder with a colleague who should be able to work on it.
 * The agent shares the FOLDER (one folder.members.invite as editor), not each
 * deck on its own, and asks the user first: the harness approves the
 * confirmation between the steps, as the user would on Narrative's page.
 * The colleague is a second person on the dev stack (`World.person`) who
 * already has an account, so they become a member at once.
 *
 * Live-only: the confirmation is approved on the page, and the memory world
 * has one user.
 */

/** The id in `"confirmationId": "<id>"` of a confirmation_required message. */
function confirmationIdIn(text: string): string | null {
  return /"confirmationId": "([A-Za-z0-9_-]{22})"/.exec(text)?.[1] ?? null
}

interface Member {
  userId: string
  role: string
  email: string | null
}

export default defineScenario({
  id: 'folder-share-member',
  title: 'Share a whole folder with a colleague as an editor',
  covers: ['folder.list', 'folder.members.invite'],
  maxTurns: 10,
  replay: {
    reason:
      "the invitation needs a confirmation approved on Narrative's page and a second person; the memory world models neither",
  },
  async setup(world) {
    const colleague = await world.person('colleague')
    const folderName = `Client Kestrel ${world.tag}`
    const folderId = await world.createFolder(folderName)
    await world.createDeck(`Kickoff ${world.tag}`, folderId)
    await world.createDeck(`Roadmap ${world.tag}`, folderId)
    return { folderId, folderName, colleagueId: colleague.userId, colleagueEmail: colleague.email }
  },
  steps: (fx) => [
    `Share my Narrative folder "${fx.folderName}" with ${fx.colleagueEmail} so they can work on everything in it.`,
    'I approved it in Narrative. Go ahead.',
  ],
  async afterStep(world, _fx, index, notes, transcript) {
    if (index !== 0) return
    const asked = (transcript.steps[0]?.calls ?? []).filter(
      (call) =>
        call.command === 'folder.members.invite' && call.errorCode === 'confirmation_required',
    )
    const last = asked.at(-1)
    if (last === undefined) return
    notes['confirmationText'] = last.text
    const id = confirmationIdIn(last.text)
    if (id !== null) await world.approveConfirmation(id)
  },
  async grade({ world, fixture: fx, transcript, notes }) {
    const c = new Checks()
    const asked = (transcript.steps[0]?.calls ?? []).filter(
      (call) =>
        call.command === 'folder.members.invite' && call.errorCode === 'confirmation_required',
    )
    c.ok('the invitation asked for the user’s confirmation first', asked.length > 0)
    const text = typeof notes['confirmationText'] === 'string' ? notes['confirmationText'] : ''
    c.ok(
      'the confirmation named the recipient and a role over the whole folder',
      text.includes(fx.colleagueEmail) && /editor — can change the folder's decks/.test(text),
      text.slice(0, 600),
    )
    const invites = callsOf(transcript, 'folder.members.invite', { ok: true })
    c.eq(
      'one invitation went through, to the colleague, as editor',
      invites.map((call) => [call.input['email'], call.input['role']]),
      [[fx.colleagueEmail, 'editor']],
    )
    c.eq(
      'no deck was shared on its own',
      allCalls(transcript)
        .filter((call) => call.command?.startsWith('share.') === true)
        .map((call) => call.command),
      [],
    )
    const { members } = await world.run<{ members: Member[] }>(
      { folderId: fx.folderId },
      'folder.members.list',
    )
    c.eq(
      'the colleague is a member of the folder with the editor role',
      members.find((m) => m.userId === fx.colleagueId)?.role ?? null,
      'editor',
    )
    return c.done()
  },
})
