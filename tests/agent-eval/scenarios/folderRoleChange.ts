import { Checks, callsOf, finalText } from '../lib/checks.js'
import { defineScenario, type Person, type World } from '../lib/types.js'

/**
 * A folder role that changes binds the agent at once (folder sharing,
 * follow-up of step 4): a colleague shared their folder with the user as a
 * VIEWER, and the user asks for a new folder colour. The agent acts as the
 * user: it may read the role in folder.list and not try, or try and get
 * `forbidden` — either way no colour is added and the user is told why
 * (live on 2026-10-09 it read the role and did not try). Between the steps
 * the colleague makes the user an EDITOR; asked again, the agent adds the
 * colour — once, to that folder.
 *
 * Live-only: the folder belongs to a second person (`World.person`).
 */

interface ColorToken {
  id: string
  name: string
  value: string
}

interface Member {
  userId: string
  email: string | null
}

const COLOUR = { name: 'Kestrel Teal', hex: '#0f766e' }

/** The agent's own user id, as the folder's owner sees it in the member list. */
async function ownUserId(world: World, owner: Person, folderId: string): Promise<string> {
  const email = await world.userEmail()
  const { members } = await world.runAs<{ members: Member[] }>(
    owner,
    { folderId },
    'folder.members.list',
  )
  const me = members.find((m) => m.email === email)
  if (me === undefined) throw new Error(`${email} is not a member of folder ${folderId}`)
  return me.userId
}

export default defineScenario({
  id: 'folder-role-change',
  title: "A viewer's agent may not add a folder colour; made an editor, it may",
  covers: ['token.create', 'token.list', 'folder.list'],
  maxTurns: 10,
  replay: {
    reason: 'the folder belongs to a second person, and the memory world has one user',
  },
  async setup(world) {
    const owner = await world.person('folder-owner')
    const folderName = `Partner Kestrel ${world.tag}`
    const folderId = await world.createFolderAs(owner, folderName)
    await world.runAs(
      owner,
      { folderId },
      'folder.members.invite',
      { email: await world.userEmail(), role: 'viewer' },
      { confirm: ['folder.members.invite'] },
    )
    const { colors } = await world.runAs<{ colors: ColorToken[] }>(
      owner,
      { folderId },
      'token.list',
    )
    return { folderId, folderName, colorsBefore: colors.length }
  },
  steps: (fx) => [
    `Add a colour "${COLOUR.name}" ${COLOUR.hex} to the design tokens of my Narrative folder "${fx.folderName}".`,
    'The folder owner has just made me an editor of that folder. Please try again.',
  ],
  async afterStep(world, fx, index) {
    if (index !== 0) return
    const owner = await world.person('folder-owner')
    await world.runAs(
      owner,
      { folderId: fx.folderId },
      'folder.members.setRole',
      { userId: await ownUserId(world, owner, fx.folderId), role: 'editor' },
      { confirm: ['folder.members.setRole'] },
    )
  },
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const asViewer = transcript.steps[0]
    c.eq(
      'as a viewer, no colour was added',
      (asViewer?.calls ?? []).filter((call) => call.command === 'token.create' && !call.isError)
        .length,
      0,
    )
    const answer = asViewer?.finalText ?? ''
    c.ok(
      'the agent told the user they can only view that folder',
      /view(er| only| access)|read[- ]only|permission|not allowed|can't (add|edit|change)|cannot (add|edit|change)|editor role|needs? (the )?editor/i.test(
        answer,
      ),
      `answer: ${answer.slice(0, 400)}`,
    )
    c.eq(
      'as an editor, the colour was added once, to that folder',
      callsOf(transcript, 'token.create', { ok: true }).map((call) => [
        call.input['category'],
        call.input['folderId'],
      ]),
      [['colors', fx.folderId]],
    )
    const { colors } = await world.run<{ colors: ColorToken[] }>(
      { folderId: fx.folderId },
      'token.list',
    )
    c.eq(
      'the folder has exactly one such colour, with the value asked for',
      colors
        .filter((t) => t.name.toLowerCase() === COLOUR.name.toLowerCase())
        .map((t) => t.value.toLowerCase()),
      [COLOUR.hex],
    )
    c.eq('nothing else was added', colors.length, fx.colorsBefore + 1)
    c.ok('the agent answered the second request', finalText(transcript).trim().length > 0)
    return c.done()
  },
})
