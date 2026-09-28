# Narrative — Claude project guide

Read this before changing code. It tells you which test commands to run
automatically based on what you're touching, where the strategy lives,
and what NOT to add.

> Strategy + roadmap: [`docs/testing-strategy.md`](./docs/testing-strategy.md).
> Setup + env: [`SETUP.md`](./SETUP.md).
> Architecture / agent ownership: [`docs/agents.md`](./docs/agents.md).

## Auto-run policy: which tests to run when

Run the tests below **automatically before declaring work complete** —
do not wait for the user to ask. Pick the rows that match what you
touched. Always run unit + typecheck + lint as the baseline.

| Files you touched                                                                                                                               | Run automatically                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything                                                                                                                                        | `pnpm typecheck` + `pnpm lint` + `pnpm -r test`                                                                                                                                                                                                                                                                                                                              |
| `packages/slide-model/src/**`                                                                                                                   | `pnpm --filter @narrative/slide-model test` (incl. property-based CRDT)                                                                                                                                                                                                                                                                                                      |
| `packages/animation/src/**`                                                                                                                     | `pnpm --filter @narrative/animation test`                                                                                                                                                                                                                                                                                                                                    |
| `packages/commands/**`, or ANY new/changed user capability (UI control, shortcut, menu item, server route, object property, slide-model export) | `pnpm --filter @narrative/commands test` (contract + parity guards) + `pnpm --filter @narrative/commands capabilities --check` (regenerate with `pnpm capabilities`) + `pnpm --filter server test` (route guard `routes/agentParity.test.ts`) + invoke the **`agent-parity`** agent. Plan §9, ADR 0010.                                                                      |
| `packages/commands/playbooks/**`, MCP prompts/instructions, command descriptions/schemas/examples                                               | `pnpm agent:eval` (real headless Claude Code against the local dev stack; costs subscription usage — run before a release too). The free replay subset runs in `pnpm --filter @narrative/commands test`; refresh recordings with `pnpm agent:eval --record` when a scenario or command behaviour changes on purpose. See `tests/agent-eval/README.md`                        |
| `apps/server/src/**` (routes, auth, hocuspocus, media)                                                                                          | `pnpm --filter server test` — covers lifecycle + leak guards                                                                                                                                                                                                                                                                                                                 |
| Drizzle stores (`apps/server/src/**/*Store.ts`, `mcp/oauth/store.ts`, `agent/runStore.ts`), migrations                                          | `pnpm --filter server test:integration` (runs the Drizzle stores against the dev Postgres from `.env`; it writes rows there)                                                                                                                                                                                                                                                 |
| `apps/web/src/renderer/**` or any Pixi-touching code                                                                                            | unit tests + the sampled-thumbnail e2e: `pnpm --filter web test:e2e -g "renderer-visual\|inspector-flows"`                                                                                                                                                                                                                                                                   |
| `apps/web/src/ui/**` or `apps/web/src/components/**`                                                                                            | unit + relevant e2e: `pnpm --filter web test:e2e -g "<feature>"`                                                                                                                                                                                                                                                                                                             |
| Keyboard shortcuts, focus scope, drag/drop                                                                                                      | `pnpm --filter web test:e2e -g "keyboard-shortcuts"`                                                                                                                                                                                                                                                                                                                         |
| `apps/server/src/pptx/**` (PowerPoint import / export)                                                                                          | `pnpm --filter server test` (round-trip matrix + ECMA-376 schema check, needs `xmllint`) + `npx tsx src/scripts/pptxRoundtrip.ts <real deck>` in `apps/server` — target is 0 differences; see `apps/server/src/pptx/README.md`. **As of 2026-09-26 the real deck shows 5 pre-existing differences** (regressed in 0.9.26–0.9.29, not bisected): your change must not add any |
| Auth, sharing, folders, cascade-delete                                                                                                          | `pnpm --filter web test:e2e -g "destructive-flows"` + `pnpm --filter server test`                                                                                                                                                                                                                                                                                            |
| Yjs mutations, Hocuspocus, sync                                                                                                                 | `pnpm --filter @narrative/slide-model test` + `pnpm --filter web test:e2e -g "multi-client-collab"` (**flaky as of 2026-09-26**: "three clients … converge" failed 6/6 on clean 0.9.29 and 2/6 with A0 — compare against a clean baseline before blaming your change)                                                                                                        |
| Bundle entry points, dynamic imports, vendor chunks                                                                                             | `pnpm size` (size-limit budgets must stay green; **the Tiptap chunk is 12.6 kB over its budget as of 2026-09-26, pre-existing** — do not grow any chunk)                                                                                                                                                                                                                     |
| Hot edit / awareness / doc-growth perf-sensitive paths                                                                                          | `pnpm load:all` (compares against `tests/load/baselines.json`, warns on > 20% drift)                                                                                                                                                                                                                                                                                         |
| Editor render path (FCP / LCP / TTI suspects)                                                                                                   | `pnpm lighthouse` (warn-level Core Web Vitals)                                                                                                                                                                                                                                                                                                                               |
| `packages/slide-model/src/{mutations,slides}.ts` deep changes                                                                                   | `pnpm --filter @narrative/slide-model mutate` (Stryker — slow, ~5min). **Broken as of 2026-09-26**: the dry run crashes with `Cannot destructure property 'moduleGraph' of 'project.server'` (`@stryker-mutator/vitest-runner` 8.x vs vitest 4) — say so instead of skipping silently                                                                                        |

If a command doesn't exist or fails to start (port collision, missing
service), say so explicitly in your update — don't silently skip it.

**Playwright needs help on this machine.** Playwright refuses to install its
own browsers on Ubuntu 26.04 (`Playwright does not support chromium on
ubuntu26.04-x64`, and the same for its ffmpeg build), so a bare
`pnpm --filter web test:e2e` fails before the first test. Drive the system
Chrome instead — `apps/web/playwright.config.ts` already supports it:

```bash
PLAYWRIGHT_USE_SYSTEM_CHROME=1 PLAYWRIGHT_NO_VIDEO=1 pnpm --filter web test:e2e
# or point at a specific binary: PLAYWRIGHT_CHROME_EXECUTABLE=/usr/bin/google-chrome
```

`PLAYWRIGHT_NO_VIDEO=1` is required, not optional — video capture needs the
ffmpeg build that can't be installed either. On the Omarchy (Arch) desktop
(2026-09-28) the slide specs pass with
`PLAYWRIGHT_CHROME_EXECUTABLE=/usr/bin/google-chrome-stable PLAYWRIGHT_NO_VIDEO=1`
(the executable variable only works since it became a launch option in A2.2;
before, it was silently ignored). Whether the suite _passes_ with
those set is unmeasured as of 2026-09-09; only that it starts.

On macOS Playwright's bundled Chromium works without these variables
(verified 2026-09-26). Every environment needs the dev stack running
(`pnpm dev` + the docker services from SETUP.md). Known environment-dependent
failure: `m16-component-flows` hardcodes a Drafts folder id that only exists
in one developer's database.

## What NOT to test

These were deleted from the suite this audit; do not re-introduce them:

- **DOM-presence component tests** — `getByText('Fill')`, `expect(button).toBeInTheDocument()`. They break on every UI iteration without catching real bugs.
- **Pixi renderer unit tests asserting mock-call shapes** — replaced by sampled-thumbnail e2e in `apps/web/e2e/renderer-visual.spec.ts` and `inspector-flows.spec.ts`.
- **jsdom keyboard-shortcut tests** — focus model is approximate; real keyboard belongs in `apps/web/e2e/keyboard-shortcuts.spec.ts`.
- **CRDT byte-equality assertions** — `Y.encodeStateAsUpdate` is NOT canonical (clock entries serialise in insertion order). Use structural deep-equality of `listSlides()` instead.

## Architecture invariants — don't violate

- **State = Yjs only.** No parallel React state for object data. New mutations go in `packages/slide-model/src/mutations.ts`.
- **Every user capability is a command** (ADR 0010). A new mutation, route, control or object property also needs a command in `packages/commands` (zod input, model-quality description, runnable examples) — agents reach Narrative only through that registry (over MCP, ADR 0011). The parity guards fail the build otherwise; if a capability is deliberately not for agents, it goes in `packages/commands/src/parity/allowlist.ts` with a reason. The UI still calls slide-model directly until phase A2 moves it onto `useCommand()`.
- **Object locks are editor-only.** `locked` stops canvas drag/resize/nudge/delete for a human; commands and agents ignore it (decision 2026-09-26).
- **Render = SceneGraph diff only.** No direct Pixi mutations outside `apps/web/src/renderer/`.
- **Animation = DSL only.** Compile through `packages/animation/`, never call GSAP from a component.
- **Custom upload metadata goes in tus JSON body, not headers.** Browser CORS strips custom `X-Narrative-*` headers.
- **Hocuspocus settings**: `unloadImmediately: false` + `debounce: 2000` (lifecycle test enforces this).
- **Sub-agents always on Opus.** When delegating to the Agent tool in this repo, pass `model: 'opus'` — Sonnet output needs reviewer rework here.

## Test command quick reference

```bash
pnpm dev                                       # web :5173 + server :3001 + video-worker
pnpm dev:no-worker                             # skip video-worker for faster startup

pnpm typecheck && pnpm lint                    # always before declaring done
pnpm -r test                                   # 3,192 tests / 223 files (32 skipped) — 2026-09-27
pnpm --filter web test:e2e                     # 53 Playwright spec files — needs the dev stack (+ env vars above on Ubuntu 26.04)
pnpm capabilities                              # regenerate docs/capabilities.md + packages/commands/capabilities.json
pnpm agent:eval                                # agent eval: headless Claude Code vs the local stack (--filter/--keep/--record)
pnpm size                                      # bundle budgets
pnpm load:all                                  # load tests + drift detection
pnpm lighthouse                                # Core Web Vitals (built preview)
pnpm --filter @narrative/slide-model mutate    # Stryker mutation report
```

Filter a single e2e spec: `pnpm --filter web test:e2e <spec-name>`.
Filter by test name: `pnpm --filter web test:e2e -g "<grep-pattern>"`.

## Skipped tests

30 web tests are `it.skip` with rationale comments in-file (plus one each in
server and video-worker). Don't un-skip without reading the comment — most are
deferred until a specific UI redesign lands or have an e2e replacement noted.

The count was 23 for a long time and drifted to 30 unnoticed; ~7 skips have
never been triaged. If you add a skip, say why in the file **and** move the
number here, or the next person inherits the same blind spot.

## Git policy

- **No pull requests on this project — commit straight to `main`.** Petr is the
  only reviewer and reads the diff in the terminal, so a PR adds a round trip and
  a merge commit without adding a reader. Do not open one, do not branch first
  "to be safe"; that overrides the usual branch-off-default habit.
- Never commit without explicit user confirmation ("push", "commit", "ship", "merge", "hotovo").
- Never `--no-verify` or force-push.
- Always read before editing a file.
- Conventional commits: `test:`, `fix:`, `feat:`, `chore:`, `perf:`.

## Deployment & prod access (verified 2026-06-14)

**Where prod runs:** a dedicated Proxmox VM `103 narrative` @ **`192.0.2.147`**
(subnet `192.0.2.x`, **NOT on Tailscale** — only reachable through the `pve`
jump host). 8 containers via Docker Compose, all healthy: `narrative-server`,
`-caddy`, `-postgres`, `-minio`, `-imgproxy`, `-imgproxy-cache`, `-video-worker`,
`-media-redis`. Public via an **external Cloudflare tunnel** (shared-tunnel mode).

**How to get in (SSH aliases in `~/.ssh/config`, keys served by the 1Password
SSH agent — approve the Touch ID popup on connect):**

```bash
ssh narrative          # → petr@192.0.2.147, ProxyJump pve (the only path in)
ssh pve                # → root@100.64.0.100 (Proxmox host + jump host, Tailscale)
```

- Login user on the narrative VM is **`petr`** (in `sudo` + `docker`), NOT root/petronijus.
- `pve` (Tailscale `100.64.0.100`) is the Proxmox hypervisor; auth works via the
  1P agent as root. The Tailscale host `docker` (`100.64.0.101`, alias `docker-vm`)
  is an **unrelated** homelab box — Narrative does NOT live there.

**Deploy layout & procedure:**

- Code lives at **`/opt/narrative`** (owner `petr`) — **this is NOT a git checkout**,
  it's copied files. So there's no `git pull`; new code must be synced in (rsync from
  a local checkout of `main`, or convert the dir to a git checkout once).
- Prod secrets: **`/opt/narrative/infra/.env.prod`** — never commit, never print.
- Compose runs with three overlays (`docker-compose.yml` + `.prod.yml` +
  `.prod.shared-tunnel.yml`, i.e. `USE_SHARED_TUNNEL=1`).
- **Images are built locally and pulled by the VM** (since 2026-09-08 — the VM no
  longer builds from source):
  1. on your machine: `NARRATIVE_TAG=v0.9.3 infra/scripts/build-push.sh` — builds
     server / video-worker / web and pushes them to GHCR (needs `infra/.env.prod`
     and a `docker login ghcr.io`);
  2. rsync the tree to `/opt/narrative`;
  3. on the VM: `cd /opt/narrative && NARRATIVE_TAG=v0.9.3 ./infra/scripts/deploy.sh prod`
     — pulls the images, extracts the web bundle into the `web_static` volume,
     runs migrations, `compose up -d`, healthchecks.

  Full procedure, rollback and troubleshooting: **[`docs/deploy.md`](./docs/deploy.md)**.

- **There is no CI.** Both GitHub Actions workflows were deleted in 0.9.0 (they had
  been failing since 2026-06-17). Nothing gates a push — the auto-run policy above
  is the only safety net, so actually run it.
- **Agentic layer (A1) needs prod config before its first deploy** — see
  `docs/deploy.md` "Releasing the agentic layer (A1)": `AGENT_PRINCIPAL_KEY_SECRET`
  is REQUIRED (compose uses `:?`, so even `build-push.sh`'s `compose build` fails
  without it), `CLOUDFLARED_TRUSTED_PROXIES` must be the real cloudflared
  address (the committed default is a documentation placeholder), migrations
  0016–0023, and the Caddy root `/.well-known/oauth-*` routes.
- **Version invariant** (since 0.9.0): git tag = package version = GHCR image tag =
  what `/version.json` serves. Releasing means bump every workspace
  `package.json`, write the CHANGELOG section, tag `vX.Y.Z`, then build-push with
  that tag. Verify prod with `curl -s https://narrative.bastla.com/version.json`.

**Connecting to these hosts needs Petr's explicit per-host consent** (the auto-mode
classifier blocks agent-inferred prod SSH targets).
