/**
 * vitest.timeouts.ts — the time limit of every test and hook in every
 * workspace's vitest suite (each package's config spreads it into `test`;
 * the server's integration suite inherits it).
 *
 * A limit is there to end a test that HANGS, not to measure speed: speed has
 * lanes of its own (`just load`, `just lighthouse`, `just size`). Vitest's
 * defaults (5 s a test, 10 s a hook) measured speed by accident: on a busy
 * machine — the 12-thread MacBook running `just check` beside a dev stack, an
 * agent eval or another session's tests, at a load of 30–80 on 2026-10-07/09 —
 * tests that take 0.1–0.8 s alone crossed them one after another, a different
 * one each run: property tests, MCP worlds, xmllint schema validation, the
 * catalog's TypeScript parse, React renders. 30 s still ends a hang well
 * inside a `just check`.
 */
export const TEST_TIMEOUTS = { testTimeout: 30_000, hookTimeout: 30_000 } as const
