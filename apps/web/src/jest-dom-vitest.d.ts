/**
 * jest-dom's matchers on Vitest 5's `expect`.
 *
 * `src/test-setup.ts` registers them at runtime (`expect.extend`); this file
 * types them. jest-dom 7.0.1 ships two typings and neither reaches Vitest 5:
 * `@testing-library/jest-dom` augments `jest.Matchers`, which Vitest no
 * longer reads, and `@testing-library/jest-dom/vitest` augments
 * `Assertion<T>`, whose type parameters Vitest 5 changed to `<R, T>`.
 * Vitest 5's extension point for custom matchers is `Matchers<R, T>`; the
 * type parameters below must stay identical to its declaration.
 *
 * Delete this file (and point `tsconfig.json` → `types` at
 * `@testing-library/jest-dom/vitest`) once jest-dom ships Vitest 5 typings.
 */
import 'vitest'
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    // `expect.stringContaining()` and friends are `any` in Vitest, as in jest-dom's own typings.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extends TestingLibraryMatchers<any, R> {}
}
