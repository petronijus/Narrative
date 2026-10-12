/**
 * packHelpers.ts — fixtures for the style pack scenarios (A4.8): a folder
 * holding the example pack (shared's `exampleStylePack`, no brand), compiled
 * into its tokens and masters, and a deck in it.
 */

import { exampleStylePack } from '@narrative/shared'
import type { World } from '../lib/types.js'
import { buildDeck } from './helpers.js'

export interface PackFixture {
  folderId: string
  deckId: string
  title: string
  slideIds: string[]
}

/** A folder with the example pack, compiled, and a deck of `slides` empty slides in it. */
export async function packDeck(world: World, name: string, slides = 1): Promise<PackFixture> {
  const folderId = await world.createFolder(`${name} ${world.tag}`)
  await world.run({ folderId }, 'style.pack.edit', { op: 'set', pack: exampleStylePack() })
  await world.run({ folderId }, 'style.pack.edit', { op: 'compile' })
  const deck = await buildDeck(
    world,
    `${name} ${world.tag}`,
    Array.from({ length: slides }, () => ({ objects: [] })),
    folderId,
  )
  return { folderId, deckId: deck.deckId, title: deck.title, slideIds: deck.slideIds }
}

export interface CheckResult {
  errors: number
  warnings: number
  findings: Array<{ level: string; rule: string; slideId?: string; message: string }>
}

/** The brand check of the deck, without measuring (the grader reads the document). */
export function checkOf(world: World, deckId: string): Promise<CheckResult> {
  return world.run<CheckResult>({ deckId }, 'query.check', { fit: false })
}
