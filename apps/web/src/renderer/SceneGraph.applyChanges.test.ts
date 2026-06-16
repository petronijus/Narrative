/**
 * renderer/SceneGraph.applyChanges.test.ts
 *
 * Unit testy pro SceneGraph.applyChanges() — M3 incremental diff API.
 *
 * Pixi.js je mockován — testy běží v Node/jsdom bez GPU.
 * Testujeme applyChanges logiku: add/update/remove s ObjectChangeSet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pixiMock } from '../test/pixiMock'

vi.mock('pixi.js', () => pixiMock())

import { SceneGraph } from './SceneGraph'
import type { SlideObject, ObjectChangeSet } from '@narrative/shared'
import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'

function makeApp() {
  const stage = new Container()
  return { stage } as unknown as Application
}

const rect1: SlideObject = {
  id: 'r1',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
}

const rect2: SlideObject = {
  id: 'r2',
  type: 'rectangle',
  x: 200,
  y: 200,
  width: 50,
  height: 50,
  fill: 0x00ff00,
  rotation: 0,
  opacity: 1,
}

function emptyChangeSet(snapshot: SlideObject[] = []): ObjectChangeSet {
  return { added: [], removed: [], updated: [], snapshot }
}

describe('SceneGraph.applyChanges()', () => {
  let sg: SceneGraph

  beforeEach(() => {
    sg = new SceneGraph(makeApp())
    vi.clearAllMocks()
  })

  describe('added', () => {
    it('přidá objekty ze changeSet.added do scene graph', () => {
      sg.applyChanges({ ...emptyChangeSet(), added: [rect1, rect2] })
      expect(sg.objectCount).toBe(2)
    })

    it('přidané objekty jsou children root containeru', () => {
      sg.applyChanges({ ...emptyChangeSet(), added: [rect1] })
      const node = sg.getNode('r1')
      expect(node).toBeDefined()
      expect(node?.container).toBeInstanceOf(Container)
    })

    it('ignoruje added objekt s neznámým typem (warn, no crash)', () => {
      const unknown = { ...rect1, id: 'u1', type: 'unknown' } as unknown as SlideObject
      expect(() => sg.applyChanges({ ...emptyChangeSet(), added: [unknown] })).not.toThrow()
      expect(sg.objectCount).toBe(0)
    })
  })

  describe('removed', () => {
    it('odstraní objekty ze scene graph', () => {
      sg.applyChanges({ ...emptyChangeSet(), added: [rect1, rect2] })
      sg.applyChanges({ ...emptyChangeSet(), removed: ['r1'] })
      expect(sg.objectCount).toBe(1)
      expect(sg.getNode('r1')).toBeUndefined()
      expect(sg.getNode('r2')).toBeDefined()
    })

    it('remove neexistujícího ID je no-op (warn, no crash)', () => {
      expect(() => sg.applyChanges({ ...emptyChangeSet(), removed: ['nonexistent'] })).not.toThrow()
    })
  })

  describe('updated', () => {
    it('volá applyPatch renderereru s patch (ne celý objekt)', () => {
      sg.applyChanges({ ...emptyChangeSet(), added: [rect1] })

      // Spy na rectangleRenderer.applyPatch přes node — testujeme výsledek
      const patch = { x: 999 }
      sg.applyChanges({ ...emptyChangeSet(), updated: [{ id: 'r1', patch }] })

      const node = sg.getNode('r1')
      expect(node).toBeDefined()
      // x = patch.x + pivot.x (pivot.x = width/2 = 50)
      expect(node?.container.x).toBe(999 + 50)
    })

    it('aktualizuje data snapshot v node po patch', () => {
      sg.applyChanges({ ...emptyChangeSet(), added: [rect1] })
      sg.applyChanges({ ...emptyChangeSet(), updated: [{ id: 'r1', patch: { x: 500 } }] })

      const node = sg.getNode('r1')
      expect(node?.data.x).toBe(500)
    })

    it('update neexistujícího ID je no-op (warn, no crash)', () => {
      expect(() =>
        sg.applyChanges({ ...emptyChangeSet(), updated: [{ id: 'ghost', patch: { x: 1 } }] }),
      ).not.toThrow()
    })
  })

  describe('pořadí operací', () => {
    it('remove proběhne před add — remove+add stejného ID ve stejném changeSet', () => {
      // Přidáme rect1 napřed
      sg.applyChanges({ ...emptyChangeSet(), added: [rect1] })
      const originalNode = sg.getNode('r1')?.container

      // ChangeSet: remove r1 a add r1 nový ve stejném volání
      const newRect1: SlideObject = { ...rect1, fill: 0x0000ff }
      sg.applyChanges({
        added: [newRect1],
        removed: ['r1'],
        updated: [],
        snapshot: [newRect1],
      })

      expect(sg.objectCount).toBe(1)
      // Po remove+add je to nový container
      const newNode = sg.getNode('r1')?.container
      expect(newNode).toBeDefined()
      // Původní container byl zničen při remove
      expect(originalNode?.destroyed).toBe(true)
    })

    it('plný changeSet add+remove+update — výsledek konzistentní', () => {
      sg.applyChanges({ ...emptyChangeSet(), added: [rect1, rect2] })
      sg.applyChanges({
        added: [
          {
            id: 'r3',
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            fill: 0,
            rotation: 0,
            opacity: 1,
          },
        ],
        removed: ['r2'],
        updated: [{ id: 'r1', patch: { x: 42 } }],
        snapshot: [],
      })

      expect(sg.objectCount).toBe(2)
      expect(sg.getNode('r1')).toBeDefined()
      expect(sg.getNode('r2')).toBeUndefined()
      expect(sg.getNode('r3')).toBeDefined()
      expect(sg.getNode('r1')?.data.x).toBe(42)
    })
  })

  describe('PERF-4 child-order resync gating', () => {
    it('skips the resync entirely on update-only change sets', () => {
      sg.applyChanges({ ...emptyChangeSet(), added: [rect1, rect2] })
      const spy = vi.spyOn(
        sg.rootContainer as unknown as { setChildIndex: (...a: unknown[]) => void },
        'setChildIndex',
      )

      // Pure {x,y} drag patch — order provably can't have changed, so
      // the O(n) snapshot walk + getChildIndex scans must not run.
      sg.applyChanges({
        ...emptyChangeSet([rect1, rect2]),
        updated: [{ id: 'r1', patch: { x: 10 } }],
      })

      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('reorders on add when the snapshot order differs from insertion order', () => {
      // Add r1 then r2 (insertion order: r1, r2 → child indices 0, 1).
      sg.applyChanges({ ...emptyChangeSet(), added: [rect1] })

      const spy = vi.spyOn(
        sg.rootContainer as unknown as { setChildIndex: (...a: unknown[]) => void },
        'setChildIndex',
      )

      // Now add r2 but the snapshot places it BEFORE r1 (a send-to-back
      // style insert). The resync must move r2 to index 0.
      sg.applyChanges({
        ...emptyChangeSet([rect2, rect1]),
        added: [rect2],
      })

      expect(spy).toHaveBeenCalled()
      // r2's container should end up before r1's in the child list.
      const r2c = sg.getNode('r2')!.container
      const r1c = sg.getNode('r1')!.container
      const children = sg.rootContainer.children as unknown as Container[]
      expect(children.indexOf(r2c)).toBeLessThan(children.indexOf(r1c))
      spy.mockRestore()
    })
  })

  describe('nodeTypes tracking', () => {
    it('render() plní nodeTypes správně — backward compat', () => {
      sg.render([rect1, rect2])
      // Ověříme přes update — pokud nodeTypes chybí, update by selhal
      expect(() =>
        sg.applyChanges({ ...emptyChangeSet(), updated: [{ id: 'r1', patch: { x: 1 } }] }),
      ).not.toThrow()
      const node = sg.getNode('r1')
      expect(node?.data.x).toBe(1)
    })
  })
})
