import { Checks, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

/**
 * The trap: the slide already has a click-triggered step. `animation.add`
 * appends, so a fade-in appended after it would wait for that click. Playing
 * "as soon as the slide appears" needs the step at index 0 with trigger
 * afterPrevious / withPrevious (onEnter is legacy and cannot be chosen).
 */
export default defineScenario({
  id: 'animation-fade-on-open',
  title: 'Fade the title in when the slide opens (step 0, not after the click step)',
  covers: ['animation.add', 'animation.reorder', 'animation.update'],
  maxTurns: 12,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Launch plan ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Launch plan') },
            {
              key: 'card',
              object: {
                type: 'rectangle',
                x: 120,
                y: 320,
                width: 700,
                height: 400,
                fill: '#2f6fed',
                cornerRadius: 24,
                name: 'Card',
              },
            },
          ],
          animations: [
            { key: 'cardStep', objectKey: 'card', preset: 'slideIn', trigger: 'onClick' },
          ],
        },
      ],
      world.evalFolderId,
    )
    return {
      deckId: deck.deckId,
      title: deck.title,
      titleId: deck.objects[0]!['title']!,
      cardId: deck.objects[0]!['card']!,
      cardStepId: deck.animations[0]!['cardStep']!,
    }
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, make the title fade in automatically as soon as the slide appears — the audience should not have to click for it. Keep the card's click animation as it is.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const steps = slide.animations
    const titleSteps = steps.filter((s) => s.objectId === fx.titleId)
    if (!c.eq('exactly one step animates the title', titleSteps.length, 1)) return c.done()
    const step = titleSteps[0]!
    c.eq('it is a fade-in', step.preset, 'fadeIn')
    c.eq('it is step 0 of the timeline', steps.indexOf(step), 0)
    c.ok(
      'its trigger starts it with the slide (afterPrevious / withPrevious, not onEnter or onClick)',
      step.trigger === 'afterPrevious' || step.trigger === 'withPrevious',
      `trigger is ${step.trigger}`,
    )
    const card = steps.find((s) => s.id === fx.cardStepId)
    c.ok('the card step is still there', card !== undefined)
    c.eq(
      'the card step is unchanged (slideIn on click)',
      card && { objectId: card.objectId, preset: card.preset, trigger: card.trigger },
      {
        objectId: fx.cardId,
        preset: 'slideIn',
        trigger: 'onClick',
      },
    )
    c.eq('the timeline has exactly two steps', steps.length, 2)
    return c.done()
  },
})
