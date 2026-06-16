/**
 * packages/animation/src/compiler.ts
 *
 * DSL → GSAP timeline compiler.
 *
 * Vstup:  AnimationStep[] (JSON DSL)
 * Výstup: CompiledTimeline (GSAP timeline + dispose)
 *
 * PRAVIDLA:
 * - Veškerý GSAP kód pouze zde a v presets/ — nikde jinde.
 * - Proxy pattern pro Pixi targets (viz Spike A ADR).
 * - onClick trigger pausuje timeline a čeká na InputBridge.onAdvance.
 * - Null target → skip + warn, engine nekrashne.
 */

import { gsap } from 'gsap'
import type { AnimationStep, AnimationContext, CompiledTimeline } from './types.js'
import { getPresetFactory } from './presets/index.js'

// ---------------------------------------------------------------------------
// Safety clamps (client-side DoS guard)
// ---------------------------------------------------------------------------
//
// An editor (or a hostile/legacy DSL) can author an effectively-infinite or
// extreme-duration animation that ships to every viewer, causing a runaway
// rAF / GSAP timeline (client-side DoS). The compiler is the single choke
// point through which every animation passes, so we clamp here. Clamping is
// SILENT — a bad value is capped, never thrown — so legacy decks keep playing.

/** Max duration for a single step, in seconds (10 min — well past any sane slide animation). */
export const MAX_STEP_DURATION_S = 600
/** Max delay before a single step starts, in seconds. */
export const MAX_STEP_DELAY_S = 600
/**
 * Max total timeline duration (sum of clamped per-step duration + delay), in
 * seconds. Once exceeded, further steps are clamped to zero so the timeline
 * can never grow past this bound (~20 min of authored animation).
 */
export const MAX_TIMELINE_DURATION_S = 1200
/**
 * Max repeat count for any step carrying `params.repeat`. `-1` is GSAP's
 * "repeat forever" sentinel — that and any value above this bound collapse to
 * MAX_REPEAT, so an infinite loop becomes a finite (large) one.
 */
export const MAX_REPEAT = 20

/**
 * Clamp a numeric value into [min, max].
 *   - +Infinity → max (an "infinite" duration is the worst case we cap hardest)
 *   - -Infinity → min
 *   - NaN / non-number → min (treat garbage as the safe lower bound)
 */
function clampNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Returns a step whose duration/delay/params.repeat are clamped to sane
 * maxima, plus how much of the timeline budget it consumes. `budgetLeft` is
 * the remaining MAX_TIMELINE_DURATION_S; once it hits zero, this step's
 * duration+delay are forced to zero so the cumulative timeline stays bounded.
 *
 * Returns the original step object unchanged when nothing needed clamping, to
 * avoid churning allocations on the common (well-behaved) path.
 */
export function clampStep(
  step: AnimationStep,
  budgetLeft: number = MAX_TIMELINE_DURATION_S,
): { step: AnimationStep; cost: number } {
  let duration = clampNumber(step.duration, 0, MAX_STEP_DURATION_S)
  let delay = clampNumber(step.delay, 0, MAX_STEP_DELAY_S)

  // Bound the cumulative timeline length.
  const wanted = duration + delay
  if (wanted > budgetLeft) {
    const scale = budgetLeft <= 0 ? 0 : budgetLeft / wanted
    duration *= scale
    delay *= scale
  }

  // Clamp params.repeat when present (GSAP's -1 == repeat forever).
  let repeatClamped = false
  let repeat: number | undefined
  const rawRepeat = step.params?.['repeat']
  if (rawRepeat !== undefined) {
    const r = typeof rawRepeat === 'number' && Number.isFinite(rawRepeat) ? rawRepeat : 0
    repeat = r < 0 || r > MAX_REPEAT ? MAX_REPEAT : Math.floor(r)
    repeatClamped = repeat !== rawRepeat
  }

  const changed = duration !== step.duration || delay !== step.delay || repeatClamped
  if (!changed) {
    return { step, cost: duration + delay }
  }

  const next: AnimationStep = { ...step, duration, delay }
  if (repeat !== undefined) {
    next.params = { ...(step.params ?? {}), repeat }
  }
  return { step: next, cost: duration + delay }
}

/**
 * Interní state pro jeden step s onClick triggerem.
 * Drží label (pro seek) a unsubscribe funkci pro InputBridge.
 */
interface ClickPauseEntry {
  stepId: string
  labelName: string
  unsubscribe: (() => void) | null
}

/**
 * Vypočítá GSAP position string pro step v timeline.
 *
 * onEnter / první krok → position 0 (start)
 * withPrevious         → '<' (stejná pozice jako předchozí tween)
 * afterPrevious        → '>' (po předchozím tweenu, GSAP default)
 * onClick              → '>' (vkládá se za předchozí, pak pause label)
 */
function resolvePosition(step: AnimationStep, index: number): string | number {
  if (index === 0 || step.trigger === 'onEnter') return 0
  if (step.trigger === 'withPrevious') return '<'
  // afterPrevious nebo onClick — oba za předchozím krokem
  return '>'
}

/**
 * Zkompiluje pole AnimationStep do pausovaného GSAP timeline.
 *
 * Caller musí zavolat dispose() při unmount aby se uklidily listenery.
 */
export function compileSteps(steps: AnimationStep[], ctx: AnimationContext): CompiledTimeline {
  const tl = gsap.timeline({ paused: true })
  const clickPauseEntries: ClickPauseEntry[] = []
  const disposers: Array<() => void> = []
  let timelineBudget = MAX_TIMELINE_DURATION_S

  for (let i = 0; i < steps.length; i++) {
    const rawStep = steps[i]
    // TypeScript strict — steps[i] může být undefined (noUncheckedIndexedAccess)
    if (rawStep === undefined) continue

    // Silently clamp extreme/infinite durations & repeats before they reach
    // GSAP. Consumes from the shared timeline budget so a sequence can't sum
    // to an unbounded total.
    const { step, cost } = clampStep(rawStep, timelineBudget)
    timelineBudget = Math.max(0, timelineBudget - cost)

    const target = ctx.targetResolver.resolve(step.objectId)
    if (target === null) {
      console.warn(
        `[animation] compileSteps: target pro objectId '${step.objectId}' nenalezen — step '${step.id}' přeskočen`,
      )
      continue
    }

    const factory = getPresetFactory(step.preset)
    if (factory === null) {
      console.warn(
        `[animation] compileSteps: neznámý preset '${step.preset}' — step '${step.id}' přeskočen`,
      )
      continue
    }

    const position = resolvePosition(step, i)

    if (step.trigger === 'onClick') {
      // onClick flow:
      // 1. Vlož pause label do timeline na aktuální pozici
      // 2. Vlož animaci za label
      // 3. Při playback: timeline se zastaví na labelu, advance() ji pokračuje
      const labelName = `click:${step.id}`
      // Anchor the pause AND the label to the SAME explicit time. Previously
      // the pause used `position` ('>' = end of the last-ADDED tween) while the
      // label defaulted to the timeline END (end of ALL content). Those differ
      // when an earlier `withPrevious` tween extends past the last-added one,
      // landing the pause mid-animation. `tl.duration()` is the timeline end
      // for both; position 0 (an onClick that is the first step) stays at 0.
      const at = position === 0 ? 0 : tl.duration()
      tl.addPause(at, undefined, undefined)
      tl.addLabel(labelName, at)
      factory(step, target, tl, labelName)

      clickPauseEntries.push({ stepId: step.id, labelName, unsubscribe: null })
    } else {
      factory(step, target, tl, position)
    }
  }

  // Zapoj InputBridge pro onClick entries po kompilaci celé timeline
  if (clickPauseEntries.length > 0 && ctx.inputBridge) {
    const bridge = ctx.inputBridge

    // Jeden sdílený onAdvance handler — resumuje timeline
    const unsub = bridge.onAdvance(() => {
      tl.play()
    })
    disposers.push(unsub)
  } else if (clickPauseEntries.length > 0 && !ctx.inputBridge) {
    console.warn(
      '[animation] compileSteps: kroky s onClick triggerem existují, ale inputBridge není poskytnut. ' +
        'onClick se bude chovat jako afterPrevious (timeline nepausuje).',
    )
    // Bez bridge jedeme dál — timeline onClick pauses zůstanou, ale nikdo je nespustí.
    // Runtime advance() je stále dostupné pro manuální volání.
  }

  const dispose = () => {
    tl.kill()
    for (const fn of disposers) {
      fn()
    }
    disposers.length = 0
  }

  return { gsapTimeline: tl, dispose }
}
