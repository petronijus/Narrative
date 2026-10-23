import { describe, expect, it } from 'vitest'
import { Container, Graphics, GraphicsContext } from 'pixi.js'
import { releaseOwnedGraphicsContexts } from './graphicsContextRelease.js'

releaseOwnedGraphicsContexts()

describe('releaseOwnedGraphicsContexts', () => {
  it('destroys the context a Graphics made when a tree is destroyed with options', () => {
    const node = new Container()
    const g = new Graphics().rect(0, 0, 10, 10).fill(0xff0000)
    node.addChild(g)
    const ctx = g.context
    // What the object renderers do: Container.destroy hands the options to every child.
    node.destroy({ children: true })
    expect(g.destroyed).toBe(true)
    expect(ctx.destroyed).toBe(true)
  })

  it('still destroys it with no options, once', () => {
    const g = new Graphics()
    const ctx = g.context
    g.destroy()
    expect(ctx.destroyed).toBe(true)
  })

  it('leaves a context it was given, a shared clone and an explicit context: false alone', () => {
    const given = new GraphicsContext()
    new Graphics(given).destroy({ children: true })
    expect(given.destroyed).toBe(false)

    const original = new Graphics()
    const clone = original.clone()
    clone.destroy({ children: true })
    original.destroy({ children: true })
    // A shallow clone shares the context: the original gave up owning it.
    expect(original.context).toBeNull()
    expect(clone.destroyed && original.destroyed).toBe(true)

    const kept = new Graphics()
    const ctx = kept.context
    kept.destroy({ children: true, context: false })
    expect(ctx.destroyed).toBe(false)
  })

  it('installs once', () => {
    const before = Graphics.prototype.destroy
    releaseOwnedGraphicsContexts()
    expect(Graphics.prototype.destroy).toBe(before)
  })
})
