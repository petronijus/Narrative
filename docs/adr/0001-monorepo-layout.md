# ADR-0001 — Monorepo layout: pnpm workspaces, apps/server as single app

**Date**: 2026-04-19
**Status**: Accepted
**Milestone**: M0 — Foundation

---

## Context

Narrative is a multi-package project: a React frontend (`apps/web`), a Node.js backend (`apps/server`), and several shared packages (`packages/shared`, `packages/slide-model`, `packages/animation`, `packages/ui`). We need a strategy for managing these in a single repository.

Three questions to resolve:

1. Why pnpm workspaces and not Turborepo or Nx from the start?
2. Why is `apps/server` a single app (API + Hocuspocus) rather than split services?
3. Why this specific packages split?

---

## Decision 1 — pnpm workspaces, Turborepo deferred

**Chosen**: pnpm workspaces only.

**Reasons**:

- At M0, the build graph is simple: four empty packages + one Vite app + one Fastify app. Turborepo's caching benefit is negligible.
- Adding Turborepo introduces a `turbo.json` pipeline definition that needs maintained alongside `package.json` scripts. That is a complexity budget we should not spend until we feel the pain of slow builds.
- pnpm's `--filter` flag covers all orchestration needed: `pnpm --filter web dev`, `pnpm -r build`, `pnpm -r typecheck`.
- `shamefully-hoist=true` in `.npmrc` solves the Windows symlink issue documented in spike-a handoff, at the cost of a flat `node_modules` (acceptable for a single-developer, self-hosted project).

**Trigger for revisiting**: build times exceed 2 minutes on a typical laptop (M6+ when packages have real content). Decision: add Turborepo at that point as a drop-in on top of existing pnpm workspace config.

---

## Decision 2 — `apps/server` is one app (API + Hocuspocus)

**Chosen**: single Fastify app handles both REST API and Hocuspocus WebSocket collaboration.

**Reasons**:

- Narrative's target is self-hosted by a solo developer with up to 15 concurrent editors. There is no traffic pattern that justifies separate processes before M12 at the earliest.
- Hocuspocus is a Fastify plugin. Integrating it in the existing Fastify instance costs nothing and simplifies deploy (one process, one port, one Docker service).
- Splitting API / Hocuspocus / workers earlier would mean three separate services, three separate log streams, and three places to manage auth middleware — with no payoff at current scale.
- BUILD_PLAN.md explicitly states: "API + Hocuspocus v jedné appce, rozdělit až bolí."

**Trigger for revisiting**: Hocuspocus load (WebSocket fan-out) starts causing latency on API requests (measurable in M29 profiling). If that happens, extract Hocuspocus to a separate process behind a shared Caddy upstream.

---

## Decision 3 — Package split rationale

| Package                  | Reason for separation                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@narrative/shared`      | Types used by both frontend and backend (e.g., API request/response shapes). Avoids duplication.                                                           |
| `@narrative/slide-model` | Yjs bindings + object type registry. Will grow large (M2-M3). Kept separate so server can import it without pulling in React.                              |
| `@narrative/animation`   | JSON DSL + GSAP compiler. Server will use it for AI-generated animation validation (M20 — renumbered from M16 on 2026-05-01). Must not depend on DOM APIs. |
| `@narrative/ui`          | Reusable React components. Separate so it can be documented/tested in isolation (Storybook, if added).                                                     |

All packages are empty shells at M0. Content arrives in milestones M2-M6.

---

## Consequences

- Every workspace inherits `tsconfig.base.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. No exceptions without explicit justification.
- CI runs `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r build`, `pnpm -r test` across all workspaces.
  > **Amended 2026-09-07**: there is no CI any more — GitHub Actions was removed
  > (commit `f55be7b`) after both workflows had been red since 2026-06-17 on a
  > pnpm version conflict. The same four commands are now run **locally** before
  > a release, per `CLAUDE.md`'s auto-run policy. The workspace-script
  > convention this ADR establishes is unchanged and is what makes `pnpm -r`
  > work at all. See
  > [ADR 0008](./0008-release-and-image-tag-discipline.md).
- When Turborepo is added, the `scripts` convention in each `package.json` (`build`, `typecheck`, `lint`, `test`) must be preserved — Turborepo will pick them up from `turbo.json` with no `package.json` changes.
