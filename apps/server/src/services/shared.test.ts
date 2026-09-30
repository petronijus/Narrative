/**
 * services/shared.test.ts — requireComponentRole, the one rule for acting on
 * a component (docs/plans/folder-sharing.md): the caller's role in the
 * component's folder, read from folder_permissions on the scripted database
 * (the component row, then the caller's rows in its folder).
 */

import { describe, expect, it } from 'vitest'
import { scriptedDb } from '../test-support/scriptedDb.js'
import { serviceErrorOf } from '../test-support/serviceErrors.js'
import { bypassAliases, requireComponentRole } from './shared.js'

const COMPONENT = {
  id: 'cmp1',
  folderId: 'f1',
  name: 'Headline',
  thumbnailKey: null,
  createdAt: new Date('2026-09-30'),
  updatedAt: new Date('2026-09-30'),
}

describe('requireComponentRole', () => {
  it('returns the component with the role the caller holds in its folder', async () => {
    const script = scriptedDb({ selects: [[COMPONENT], [{ role: 'editor' }]] })
    const row = await requireComponentRole(script.db, 'cmp1', 'u1', 'editor')
    expect(row).toEqual({ ...COMPONENT, role: 'editor' })
    expect(script.remaining().selects).toBe(0)
  })

  it('takes the highest of the rows the caller counts as (BYPASS: the demo user too)', async () => {
    const script = scriptedDb({ selects: [[COMPONENT], [{ role: 'viewer' }, { role: 'owner' }]] })
    const row = await requireComponentRole(script.db, 'cmp1', 'dev-user', 'owner', { bypass: true })
    expect(row.role).toBe('owner')
  })

  it('answers a missing component with 404, without reading any role', async () => {
    const script = scriptedDb({ selects: [[]] })
    const err = await serviceErrorOf(requireComponentRole(script.db, 'cmp1', 'u1', 'viewer'))
    expect(err.status).toBe(404)
    expect(err.message).toBe('Component not found')
    expect(script.remaining().selects).toBe(0)
  })

  it('answers a component of another folder than the expected one with 404', async () => {
    // The role select is scripted but must not be read: the folder mismatch decides first.
    const script = scriptedDb({ selects: [[COMPONENT], [{ role: 'owner' }]] })
    const err = await serviceErrorOf(
      requireComponentRole(script.db, 'cmp1', 'u1', 'viewer', { folderId: 'f2' }),
    )
    expect(err.status).toBe(404)
    expect(err.message).toBe('Component not found')
    expect(script.remaining().selects).toBe(1)
  })

  it('refuses a caller outside the folder with 403', async () => {
    const script = scriptedDb({ selects: [[COMPONENT], []] })
    const err = await serviceErrorOf(requireComponentRole(script.db, 'cmp1', 'u1', 'viewer'))
    expect(err.status).toBe(403)
    expect(err.message).toBe('Forbidden')
  })

  it("answers a caller outside the folder with 404 when told the component's existence must not leak", async () => {
    const script = scriptedDb({ selects: [[COMPONENT], []] })
    const err = await serviceErrorOf(
      requireComponentRole(script.db, 'cmp1', 'u1', 'viewer', { unseen: 'not_found' }),
    )
    expect(err.status).toBe(404)
    expect(err.message).toBe('Component not found')
  })

  it('refuses a member whose role is too low with 403 naming the role it needs, even with unseen: not_found', async () => {
    const script = scriptedDb({ selects: [[COMPONENT], [{ role: 'viewer' }]] })
    const err = await serviceErrorOf(
      requireComponentRole(script.db, 'cmp1', 'u1', 'editor', { unseen: 'not_found' }),
    )
    expect(err.status).toBe(403)
    expect(err.message).toBe('Forbidden: this needs the editor role in the folder')
  })

  it("names the owner role when the owner's is required", async () => {
    const script = scriptedDb({ selects: [[COMPONENT], [{ role: 'editor' }]] })
    const err = await serviceErrorOf(requireComponentRole(script.db, 'cmp1', 'u1', 'owner'))
    expect(err.status).toBe(403)
    expect(err.message).toBe("Forbidden: only the folder's owner may do this")
  })
})

describe('bypassAliases', () => {
  it('counts the legacy demo user as the caller under BYPASS_AUTH only', () => {
    expect(bypassAliases(true)).toEqual(['demo-user'])
    expect(bypassAliases(false)).toEqual([])
    expect(bypassAliases(undefined)).toEqual([])
  })
})
