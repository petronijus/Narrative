/** Types for eslint.one-door.js (a plain ES module so eslint.config.js can load it). */

import type { Linter } from 'eslint'

export declare const SLIDE_MODEL_WRITERS: readonly string[]
export declare const ONE_DOOR_FILES: readonly string[]
export declare const ONE_DOOR_IGNORES: readonly string[]
export declare const ONE_DOOR_RULES: Linter.RulesRecord
export declare const ONE_DOOR_PENDING: ReadonlyArray<{ file: string; step: string }>
