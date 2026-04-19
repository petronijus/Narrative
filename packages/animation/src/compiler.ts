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

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    // TypeScript strict — steps[i] může být undefined (noUncheckedIndexedAccess)
    if (step === undefined) continue

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
      tl.addPause(position, undefined, undefined)
      tl.addLabel(labelName)
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
