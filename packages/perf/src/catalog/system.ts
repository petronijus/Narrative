/**
 * catalog/system.ts — layer S benches run by the harness's own CLI rather
 * than a browser driver (docs/plans/perf-harness.md → Layers).
 *
 * `deck.open.lighthouse` is `just lighthouse` (docs/plans/performance.md →
 * G2): a production build served by `vite preview` in front of the dev
 * backend, Lighthouse's desktop preset on a seeded deck's `/deck/:id` (not the
 * login page), five runs, compared with this machine's baseline — a
 * regression fails the recipe. Nothing is uploaded anywhere.
 */

import { defineBench, type BenchDef, type MetricSpec } from '../defineBench.js'
import { SCENES } from './interaction.js'

const ms: MetricSpec = { unit: 'ms', better: 'lower', kind: 'time' }

export const LIGHTHOUSE_BENCH_ID = 'deck.open.lighthouse'

export const SYSTEM_BENCHES: ReadonlyArray<BenchDef<never>> = [
  defineBench<never>({
    id: LIGHTHOUSE_BENCH_ID,
    area: 'deck',
    layer: 'S',
    scene: SCENES.deck10,
    run: () => {
      throw new Error(`${LIGHTHOUSE_BENCH_ID} runs from \`just lighthouse\``)
    },
    metrics: {
      'lh.fcp': ms,
      'lh.lcp': ms,
      'lh.tbt': ms,
      'lh.si': ms,
      'lh.tti': ms,
      'lh.cls': { unit: 'ratio', better: 'lower', kind: 'time', threshold: 0.5 },
      'lh.score': { unit: 'ratio', better: 'higher', kind: 'time' },
    },
    // Lighthouse's simulated throttling is noisy run to run.
    threshold: 0.1,
  }),
]
