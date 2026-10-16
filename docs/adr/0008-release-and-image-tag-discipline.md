# ADR 0008 — Release discipline: git tag = package version = deployed image tag

**Status**: Accepted (2026-09-07, extended 2026-09-09).
**Scope**: versioning, `CHANGELOG.md`, git tags, `infra/scripts/build-push.sh`,
`infra/scripts/deploy.sh`, and the version stamped into the web bundle.
**Supersedes**: the informal "deploy whatever is on `main`" practice used up
to 0.8.1, and the earlier build-on-the-VM deploy path.
**Related**: `docs/handoff/0.9.x-production-hardening.md`.

## Context

Before 0.9.0 the project had milestone handoff notes and a CHANGELOG, but no
tags, no version bumps, and no relationship between "what is running in
production" and "what is in the repo". Three concrete failures followed from
that:

- **Nobody could say what production was running.** `/opt/narrative` on the VM
  is an rsync of a working tree, not a git checkout, so `git log` there means
  nothing and the images were hand-built from whatever was checked out at the
  time.
- **`index.html` had no `Cache-Control`**, so browsers cached it heuristically
  off `Last-Modified` — roughly 10 % of the document's age, which makes an
  _older_ document _more_ patient. On 2026-09-09 production was serving a
  June document pulling June chunks to a client whose server had moved on
  months earlier. A deploy could not be distinguished from a no-op.
- **Docker builds have no `.git`**, so a version resolver that shells out to
  git produced the same fallback string (`v<pkg>+build`) for every build,
  which is worse than no version at all.

Meanwhile GitHub Actions had been red since 2026-06-17 on a pnpm version
conflict and was providing no signal; it was removed rather than repaired.

## Decision

**One version identifier flows through the whole pipeline, unchanged:**

```
package.json version  ==  git tag (vX.Y.Z)  ==  GHCR image tag  ==  /version.json
```

The rules that keep it true:

1. **Every deployable state gets a version bump, a CHANGELOG section and a
   tag.** An entry without a tag is a lie about what a user can run; a tag
   without an entry is a release nobody can read. Config-only changes that go
   out between tags are recorded under `Unreleased` and say so explicitly.
2. **Images are built locally and pushed to GHCR** by
   `infra/scripts/build-push.sh`; the VM only pulls. The prod host has no
   source checkout and no build load, and the artifact that ships is the exact
   one that was built and tested. `NARRATIVE_TAG` selects it on both sides.
3. **The build stamps its own version into the bundle _and_ into
   `/version.json`.** `build-push.sh` passes the real tag + short sha via
   `VITE_BUILD_VERSION` precisely because the Docker context has no `.git`.
   The version must be resolved **once** per build and reused — resolving it
   twice (as `vite.config.ts` did until 0.9.3) lets two calls disagree.
4. **The client enforces it.** `apps/web/src/state/versionGuard.ts` compares
   the bundle's version against `/version.json` at startup and on tab focus and
   reloads a browser that is stuck on a stale document. It is conservative by
   construction: an unreadable version never triggers a reload, and each served
   version reloads at most once per tab, so an offline moment or a proxy pinned
   to an old document cannot cost anyone unsaved work.
5. **`index.html` is served `no-cache`.** Hashed assets stay immutable and
   long-cached; only the document is revalidated.
6. **Checks are local, not CI.** `pnpm typecheck`, `pnpm lint`, `pnpm -r test`
   before a release, per `CLAUDE.md`. There is no `.github/` directory.

## Consequences

- **"What is in production?" is now a one-line question**:
  `curl -s https://<domain>/version.json`. It answered `v0.9.3+c4305b8` on
  2026-09-09.
- **A divergence between tag, `package.json` and the deployed image is a bug**,
  not a nuance — it means the pipeline was bypassed by hand.
- **Rollback is `NARRATIVE_TAG=vX.Y.Z ./infra/scripts/deploy.sh prod`**, not a
  git checkout plus a rebuild. Forward-only DB migrations are the limit on how
  far back this is safe.
- Config-only fixes (Caddyfile, compose) still ship by rsync + redeploy without
  a version bump, and therefore **do not move `/version.json`**. Two such
  changes shipped after `v0.9.3` (PRs #72 and #73). When checking whether a
  config change is live, check the served artifact — the header, the mount —
  never the version endpoint and never the file on disk.
- Losing CI is a real cost: nothing mechanically enforces that the local checks
  ran. The mitigation is `CLAUDE.md`'s auto-run policy plus the pre-commit
  hooks; if this proves insufficient, the answer is a working CI, not a looser
  rule.
