/**
 * benches.ts — every bench of the harness, one list. Step 2 of
 * docs/plans/perf-harness.md brought the layer I scenarios (catalog/
 * interaction.ts, driven from apps/web/e2e/perf); each bench lands
 * here (or in a file of its area imported here) and names the actions and
 * commands it covers, which takes them off the "not yet benched" exemptions
 * in coverage.ts.
 */

import { INTERACTION_BENCHES } from './catalog/interaction.js'
import { AGENT_BENCHES } from './catalog/server.js'
import { SYSTEM_BENCHES } from './catalog/system.js'
import type { BenchDef } from './defineBench.js'

export const ALL_BENCHES: ReadonlyArray<BenchDef<never>> = [
  ...INTERACTION_BENCHES,
  ...SYSTEM_BENCHES,
  ...AGENT_BENCHES,
]
