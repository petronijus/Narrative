/**
 * commands/src/commands/animations.ts — the `animation.*` domain: build-in /
 * build-out / motion steps on a slide's timeline, compiled by
 * packages/animation. Steps play in list order; `trigger` says when each one
 * starts relative to the previous one.
 */

import { z } from 'zod'
import {
  addAnimation,
  removeAnimation,
  reorderAnimations,
  retargetAnimation,
  updateAnimation,
  yMapToAnimationStep,
  type AnimationsMutationContext,
} from '@narrative/slide-model'
import {
  ANIMATION_PRESET_PARAMS_SCHEMAS,
  AnimationPresetSchema,
  AnimationStepSchema,
  AnimationTriggerSchema,
  MAX_STEP_DELAY_S,
  layoutAnimationSteps,
  type AnimationPreset,
  type AnimationStep,
  type AnimationTrigger,
} from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { CommandError, issuesFromZod } from '../errors.js'
import {
  ObjectIdSchema,
  SlideRefSchema,
  animationsOf,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
} from '../refs.js'

const animationEditor = {
  domain: 'animation',
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
} as const

/**
 * The editor's defaults for a new step (apps/web/src/ui/Inspector.tsx,
 * `AnimationsSection.handleAddAnimation` + `NEW_ANIMATION_TRIGGER`): always
 * afterPrevious — as the first step it starts with the slide anyway, since
 * the compiler anchors step 0 at time 0 whatever its trigger.
 */
export const ANIMATION_DEFAULTS = {
  trigger: 'afterPrevious',
  duration: 0.6,
  delay: 0,
  easing: 'power2.out',
} as const

/** Params the editor seeds for motion presets (slide centre; half a turn, in degrees). */
const PRESET_PARAM_DEFAULTS: Partial<Record<AnimationPreset, Record<string, unknown>>> = {
  moveTo: { targetX: 960, targetY: 540 },
  rotateTo: { angleDeg: 180 },
}

const stepShape = AnimationStepSchema.shape
const AnimationIdSchema = z.string().min(1).max(64).describe('Animation step id')
const ParamsInput = z
  .record(z.string(), z.unknown())
  .describe(
    'Preset parameters. slideIn/slideOut: direction up|down|left|right, distance px; zoomIn: fromScale; rotateIn: ' +
      'angle (radians); flipIn: axis x|y; wipeIn: direction; moveTo: targetX, targetY (slide px of the object CENTRE ' +
      'at the end, default 960, 540); rotateTo: angleDeg (degrees, default 180); any preset: repeat 0..20.',
  )

/**
 * Triggers a command may WRITE: what the editor offers for a step
 * (apps/web/src/ui/animationTriggers.ts). `onEnter` is legacy — still read
 * back from older decks and kept on a step whose trigger an update does not
 * touch, but never chosen for a new or changed step.
 */
export const WritableAnimationTriggerSchema = AnimationTriggerSchema.exclude(['onEnter']).describe(
  'afterPrevious (default) | withPrevious | onClick',
)

const PRESETS_DOC =
  'Presets: fadeIn, fadeOut, slideIn, slideOut, scaleIn, scaleOut, zoomIn, rotateIn, bounceIn, flipIn, popIn, ' +
  'dissolveIn, wipeIn, moveTo, rotateTo. Triggers: afterPrevious (starts when the previous step ends), ' +
  'withPrevious (starts together with the previous step), onClick (waits for a click or the next key). The first ' +
  'step (step 0) with afterPrevious or withPrevious starts as soon as the slide appears; an onClick step 0 waits ' +
  'for the first click. Steps of older decks may read back as trigger onEnter (legacy: starts with the slide ' +
  'wherever it sits); it cannot be chosen, and a step keeps it until its trigger is changed. Rotation units ' +
  'differ by preset, as the animation engine defines them: rotateIn `angle` is in RADIANS (the starting offset, ' +
  'default -1.5708 = a quarter turn), rotateTo `angleDeg` is in DEGREES (the absolute end angle).'

function validateParams(
  preset: AnimationPreset,
  params: Record<string, unknown>,
  at: PropertyKey[],
): void {
  const schema = ANIMATION_PRESET_PARAMS_SCHEMAS[preset] as z.ZodType
  const parsed = schema.safeParse(params)
  if (!parsed.success) {
    throw new CommandError('invalid_input', `invalid params for preset '${preset}'`, {
      issues: issuesFromZod(parsed.error).map((i) => ({
        path: [...at, ...i.path],
        message: i.message,
      })),
    })
  }
}

/** Keys a preset's params schema accepts (every preset schema is a strict object). */
function paramKeysOf(preset: AnimationPreset): Set<string> {
  return new Set(
    Object.keys((ANIMATION_PRESET_PARAMS_SCHEMAS[preset] as unknown as z.ZodObject).shape),
  )
}

function listSteps(anims: AnimationsMutationContext): AnimationStep[] {
  const out: AnimationStep[] = []
  for (let i = 0; i < anims.animations.length; i++)
    out.push(yMapToAnimationStep(anims.animations.get(i)))
  return out
}

function requireSteps(
  anims: AnimationsMutationContext,
  ids: readonly string[],
  slideId: string,
): Map<string, AnimationStep> {
  const byId = new Map(listSteps(anims).map((s) => [s.id, s]))
  for (const id of ids) {
    if (!byId.has(id))
      throw new CommandError('not_found', `animation '${id}' does not exist on slide '${slideId}'`)
  }
  return byId
}

export const animationAdd = defineCommand({
  ...animationEditor,
  id: 'animation.add',
  title: 'Add animation',
  description:
    "Append an animation step for an object to the end of its slide's timeline. Omitted fields take the editor " +
    'defaults: trigger afterPrevious, duration 0.6 s, delay 0 s, easing "power2.out"; moveTo targets the slide ' +
    'centre (960, 540) and rotateTo turns to 180°. ' +
    PRESETS_DOC +
    ' Use animation.reorder to move the step, animation.update to change it.',
  input: z.strictObject({
    slide: SlideRefSchema,
    object: ObjectIdSchema.describe('The object to animate (on the same slide)'),
    preset: AnimationPresetSchema,
    trigger: WritableAnimationTriggerSchema.optional(),
    duration: stepShape.duration.optional().describe('Seconds'),
    delay: stepShape.delay.optional().describe('Seconds after the trigger point'),
    easing: stepShape.easing.optional(),
    params: ParamsInput.optional(),
  }),
  output: z.object({ animationId: z.string() }),
  implementedWith: ['addAnimation'],
  examples: [
    {
      title: 'Fade in the ellipse after the previous step',
      input: { slide: 's1', object: 'e1', preset: 'fadeIn' },
    },
    {
      title: 'Slide the text in from the left on click',
      input: {
        slide: 's1',
        object: 't1',
        preset: 'slideIn',
        trigger: 'onClick',
        params: { direction: 'left', distance: 200 },
      },
    },
    {
      title: 'Move the rectangle to the slide centre',
      input: { slide: 's1', object: 'r1', preset: 'moveTo', duration: 1 },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    requireObjects(objectsOf(deck, slide), [input.object], slide.id)
    const params = { ...(PRESET_PARAM_DEFAULTS[input.preset] ?? {}), ...(input.params ?? {}) }
    validateParams(input.preset, params, ['params'])
    const step = addAnimation(animationsOf(deck, slide), {
      objectId: input.object,
      preset: input.preset,
      trigger: input.trigger ?? ANIMATION_DEFAULTS.trigger,
      duration: input.duration ?? ANIMATION_DEFAULTS.duration,
      delay: input.delay ?? ANIMATION_DEFAULTS.delay,
      easing: input.easing ?? ANIMATION_DEFAULTS.easing,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    })
    return { animationId: step.id }
  },
})

export const animationUpdate = defineCommand({
  ...animationEditor,
  id: 'animation.update',
  idempotent: true,
  title: 'Update animation',
  description:
    'Change an animation step: preset, trigger, duration (s), delay (s), easing, params. `params` is MERGED into ' +
    'the current params (a key set to null is removed; params: null clears them all). Changing `preset` drops ' +
    'params the new preset does not use and fills its defaults (moveTo: slide centre, rotateTo: 180°). The ' +
    'animated object cannot be changed here. ' +
    PRESETS_DOC,
  input: z.strictObject({
    slide: SlideRefSchema,
    animation: AnimationIdSchema,
    patch: z
      .strictObject({
        preset: AnimationPresetSchema.optional(),
        trigger: WritableAnimationTriggerSchema.optional(),
        duration: stepShape.duration.optional(),
        delay: stepShape.delay.optional(),
        easing: stepShape.easing.optional(),
        params: ParamsInput.nullable().optional(),
      })
      .refine((p) => Object.keys(p).length > 0, { message: 'The patch is empty' }),
  }),
  output: z.object({}),
  implementedWith: ['updateAnimation'],
  examples: [
    {
      title: 'Slow down the fade and start it on click',
      input: { slide: 's1', animation: 'a1', patch: { duration: 1.2, trigger: 'onClick' } },
    },
    {
      title: 'Turn the fade into a slide-in from below',
      input: {
        slide: 's1',
        animation: 'a1',
        patch: { preset: 'slideIn', params: { direction: 'down' } },
      },
    },
    {
      title: 'Replace a legacy onEnter trigger: run the first step with the slide',
      input: { slide: 's1', animation: 'a1', patch: { trigger: 'afterPrevious' } },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const anims = animationsOf(deck, slide)
    const current = requireSteps(anims, [input.animation], slide.id).get(input.animation)!
    const { params: paramsPatch, ...fields } = input.patch
    const preset = fields.preset ?? current.preset
    let params: Record<string, unknown> = { ...(current.params ?? {}) }
    if (preset !== current.preset) {
      const keep = paramKeysOf(preset)
      params = Object.fromEntries(Object.entries(params).filter(([k]) => keep.has(k)))
      params = { ...(PRESET_PARAM_DEFAULTS[preset] ?? {}), ...params }
    }
    if (paramsPatch === null)
      params = { ...(preset !== current.preset ? (PRESET_PARAM_DEFAULTS[preset] ?? {}) : {}) }
    else if (paramsPatch !== undefined) {
      for (const [k, v] of Object.entries(paramsPatch)) {
        if (v === null) delete params[k]
        else params[k] = v
      }
    }
    validateParams(preset, params, ['patch', 'params'])
    const paramsChanged = JSON.stringify(params) !== JSON.stringify(current.params ?? {})
    const patch: Partial<Omit<AnimationStep, 'id' | 'objectId'>> = {}
    if (fields.preset !== undefined) patch.preset = fields.preset
    if (fields.trigger !== undefined) patch.trigger = fields.trigger
    if (fields.duration !== undefined) patch.duration = fields.duration
    if (fields.delay !== undefined) patch.delay = fields.delay
    if (fields.easing !== undefined) patch.easing = fields.easing
    if (paramsChanged) patch.params = params
    updateAnimation(anims, input.animation, patch)
    return {}
  },
})

export const animationRemove = defineCommand({
  ...animationEditor,
  id: 'animation.remove',
  title: 'Remove animations',
  description:
    "Remove animation steps from a slide's timeline; the objects themselves stay. Deleting an object with " +
    'object.delete already removes its steps.',
  input: z.strictObject({
    slide: SlideRefSchema,
    animations: z.array(AnimationIdSchema).min(1).max(500),
  }),
  output: z.object({ removed: z.array(z.string()) }),
  implementedWith: ['removeAnimation'],
  examples: [{ title: 'Remove the fade-in', input: { slide: 's1', animations: ['a1'] } }],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const anims = animationsOf(deck, slide)
    const ids = [...new Set(input.animations)]
    requireSteps(anims, ids, slide.id)
    for (const id of ids) removeAnimation(anims, id)
    return { removed: ids }
  },
})

export const animationReorder = defineCommand({
  ...animationEditor,
  id: 'animation.reorder',
  title: 'Reorder animations',
  description:
    "Set the play order of a slide's animation steps. `order` must list every step id of the slide exactly once " +
    '(query.slide lists them). Triggers are kept, so an afterPrevious step now follows its new predecessor.',
  input: z.strictObject({
    slide: SlideRefSchema,
    order: z.array(AnimationIdSchema).min(1).max(500),
  }),
  output: z.object({ order: z.array(z.string()) }),
  implementedWith: ['reorderAnimations'],
  examples: [
    { title: 'Play the ellipse before the rectangle', input: { slide: 's1', order: ['a2', 'a1'] } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const anims = animationsOf(deck, slide)
    const existing = listSteps(anims).map((s) => s.id)
    requireSteps(anims, input.order, slide.id)
    if (
      new Set(input.order).size !== input.order.length ||
      input.order.length !== existing.length
    ) {
      throw new CommandError(
        'conflict',
        `order must list each of the slide's ${existing.length} animation steps exactly once (${existing.join(', ')})`,
      )
    }
    reorderAnimations(anims, [...input.order])
    return { order: [...input.order] }
  },
})

// ---------------------------------------------------------------------------
// animation.retime
// ---------------------------------------------------------------------------

/** Two times closer than this are the same time. */
const TIME_EPSILON = 1e-6

/** Times are stored to the microsecond: differences of floats carry noise. */
const roundTime = (seconds: number): number => Math.round(seconds * 1e6) / 1e6

interface PlacedStep {
  step: AnimationStep
  start: number
  duration: number
  /** Index in the current play order (ties keep it). */
  index: number
}

/**
 * The trigger and delay that put `cur` at `cur.start` after `prev` — the
 * timeline's sequence model (layoutAnimationSteps read backwards). onClick
 * stays onClick and cannot start before the previous step ends.
 */
function sequenceAfter(
  cur: PlacedStep,
  prev: PlacedStep | undefined,
): { trigger: AnimationTrigger; delay: number } {
  const onClick = cur.step.trigger === 'onClick'
  if (prev === undefined)
    return { trigger: onClick ? 'onClick' : 'afterPrevious', delay: Math.max(0, cur.start) }
  const prevEnd = prev.start + prev.duration
  if (onClick) return { trigger: 'onClick', delay: Math.max(0, cur.start - prevEnd) }
  if (cur.start + TIME_EPSILON >= prevEnd)
    return { trigger: 'afterPrevious', delay: Math.max(0, cur.start - prevEnd) }
  return { trigger: 'withPrevious', delay: Math.max(0, cur.start - prev.start) }
}

/**
 * Sorts `placed` into play order by start time (ties keep the current
 * order) and pushes every onClick step that would start before its
 * predecessor ends to that end — the earliest a click step can start. A
 * pushed step can overtake the steps after it, so this re-sorts until
 * nothing moves; starts only grow, so it settles in at most one pass per
 * step. Every other step keeps its time, whatever it follows.
 */
function placeOnTimeline(placed: PlacedStep[]): void {
  for (let pass = 0; pass <= placed.length; pass++) {
    placed.sort((a, b) => a.start - b.start || a.index - b.index)
    let pushed = false
    for (let i = 1; i < placed.length; i++) {
      const cur = placed[i]!
      const prev = placed[i - 1]!
      const prevEnd = prev.start + prev.duration
      if (cur.step.trigger === 'onClick' && cur.start + TIME_EPSILON < prevEnd) {
        cur.start = prevEnd
        pushed = true
      }
    }
    if (!pushed) return
  }
}

const TimingOutput = z.object({
  animation: z.string(),
  start: z.number(),
  duration: z.number(),
  trigger: z.string(),
  delay: z.number(),
})

export const animationRetime = defineCommand({
  ...animationEditor,
  id: 'animation.retime',
  idempotent: true,
  title: 'Retime animations',
  description:
    "Place animation steps at absolute times on the slide's timeline — `start` in seconds from the moment the " +
    'slide appears (the `start` query.slide reports for each step), and optionally a new `duration`. Steps not ' +
    'listed keep their start. The play order follows the times, and every step gets the trigger and delay that ' +
    'put it there after its new predecessor: afterPrevious when it starts at or after the previous step ends, ' +
    "withPrevious when it overlaps it. An onClick step stays onClick and starts at the previous step's end at the " +
    'earliest (the other steps keep their times); a legacy onEnter step becomes afterPrevious or withPrevious. ' +
    "Returns every step's resulting time " +
    'and trigger in play order. To change a trigger, delay or duration and let the following steps move with it, ' +
    'use animation.update instead.',
  input: z.strictObject({
    slide: SlideRefSchema,
    timing: z
      .array(
        z
          .strictObject({
            animation: AnimationIdSchema,
            start: z.number().min(0).optional().describe('Seconds from the slide start'),
            duration: stepShape.duration.optional().describe('Seconds'),
          })
          .refine((t) => t.start !== undefined || t.duration !== undefined, {
            message: 'Give start, duration or both',
          }),
      )
      .min(1)
      .max(500),
  }),
  output: z.object({
    timing: z.array(TimingOutput).describe('Every step of the slide, in play order'),
  }),
  implementedWith: ['updateAnimation', 'reorderAnimations'],
  examples: [
    {
      title: 'Start the ellipse fade at 2 s',
      input: { slide: 's1', timing: [{ animation: 'a2', start: 2 }] },
    },
    {
      title: 'Play the two fades together from 0.5 s, the second one longer',
      input: {
        slide: 's1',
        timing: [
          { animation: 'a1', start: 0.5 },
          { animation: 'a2', start: 0.5, duration: 1.5 },
        ],
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const anims = animationsOf(deck, slide)
    const ids = input.timing.map((t) => t.animation)
    if (new Set(ids).size !== ids.length)
      throw new CommandError('invalid_input', 'timing lists a step more than once')
    requireSteps(anims, ids, slide.id)
    const wanted = new Map(input.timing.map((t) => [t.animation, t]))
    const placed: PlacedStep[] = layoutAnimationSteps(listSteps(anims)).map(
      ({ step, start }, index) => {
        const w = wanted.get(step.id)
        return { step, start: w?.start ?? start, duration: w?.duration ?? step.duration, index }
      },
    )
    placeOnTimeline(placed)

    const patches: Array<[string, Partial<Omit<AnimationStep, 'id' | 'objectId'>>]> = []
    placed.forEach((cur, i) => {
      const { trigger, delay } = sequenceAfter(cur, placed[i - 1])
      if (delay > MAX_STEP_DELAY_S + TIME_EPSILON) {
        throw new CommandError(
          'invalid_input',
          `step '${cur.step.id}' would wait ${roundTime(delay)} s after its predecessor; a step waits at most ` +
            `${MAX_STEP_DELAY_S} s`,
        )
      }
      const patch: Partial<Omit<AnimationStep, 'id' | 'objectId'>> = {}
      if (trigger !== cur.step.trigger) patch.trigger = trigger
      if (Math.abs(delay - cur.step.delay) > TIME_EPSILON) patch.delay = roundTime(delay)
      if (cur.duration !== cur.step.duration) patch.duration = cur.duration
      if (Object.keys(patch).length > 0) patches.push([cur.step.id, patch])
    })
    for (const [id, patch] of patches) updateAnimation(anims, id, patch)
    const order = placed.map((p) => p.step.id)
    if (order.some((id, i) => anims.animations.get(i).get('id') !== id))
      reorderAnimations(anims, order)

    return {
      timing: layoutAnimationSteps(listSteps(anims)).map(({ step, start }) => ({
        animation: step.id,
        start: roundTime(start),
        duration: step.duration,
        trigger: step.trigger,
        delay: step.delay,
      })),
    }
  },
})

// ---------------------------------------------------------------------------
// animation.retarget
// ---------------------------------------------------------------------------

export const animationRetarget = defineCommand({
  ...animationEditor,
  id: 'animation.retarget',
  idempotent: true,
  title: 'Retarget animations',
  description:
    'Make animation steps animate another object on the same slide. Each step keeps its id, its place in the ' +
    'play order, its trigger, timing, preset and params — a moveTo still ends at the same slide position. Use ' +
    'it when an object was replaced (a new picture in place of the old one) instead of removing and re-adding ' +
    'its steps — and before deleting the old object, since object.delete removes the steps of what it deletes.',
  input: z.strictObject({
    slide: SlideRefSchema,
    animations: z.array(AnimationIdSchema).min(1).max(500),
    object: ObjectIdSchema.describe('The object the steps animate from now on (on the same slide)'),
  }),
  output: z.object({ retargeted: z.array(z.string()) }),
  implementedWith: ['retargetAnimation'],
  examples: [
    {
      title: "Let the ellipse do the rectangle's fade-in",
      input: { slide: 's1', animations: ['a1'], object: 'e1' },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    requireObjects(objectsOf(deck, slide), [input.object], slide.id)
    const anims = animationsOf(deck, slide)
    const ids = [...new Set(input.animations)]
    const steps = requireSteps(anims, ids, slide.id)
    for (const id of ids) {
      if (steps.get(id)!.objectId !== input.object) retargetAnimation(anims, id, input.object)
    }
    return { retargeted: ids }
  },
})

export const animationCommands = [
  animationAdd,
  animationUpdate,
  animationRemove,
  animationReorder,
  animationRetime,
  animationRetarget,
]
