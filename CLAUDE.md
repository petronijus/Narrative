@AGENTS.md

## Claude Code in this repo

Project configuration lives in `.claude/` (committed); `.claude/settings.local.json`
is yours.

- **Hooks** (`.claude/settings.json`):
  - every file you write — with the edit tools or from the shell (`sed -i`,
    `>`, heredocs) — is formatted with `tools/dev/format.sh` (Prettier; ESLint
    runs at commit and in `just check`); a complaint it cannot fix comes back
    to you;
  - writing key material (`.env`, `infra/.env.prod`, keys), lockfiles and
    generated files (`dist/`, the capability manifest, the plugin, eval
    recordings) is refused — each refusal names the recipe that regenerates
    it — and so is a shell command that prints key material (`cat .env`, a
    resolved `compose config`), also when wrapped (`sudo -u x cat …`) or
    reached by a recursive search (`grep -r`; use `rg` or `git grep`, which
    skip gitignored files); a call the guard cannot parse is denied; changing an existing database migration asks
    first;
  - when you finish a turn whose content (code, config and docs) has not passed before, the
    affected lane runs (`just check-affected`: formatting of the changed
    files, the docs check, typecheck, lint and unit tests of the packages
    the change reaches and their dependents; the whole `just check` when a
    shared file changed — `tools/dev/check-affected.sh`); it is skipped while
    background agents of the session are still working, and runs in the turn
    the last one reports back. `tools/dev/check-cache.sh` remembers what
    passed. If it fails you get the output and must fix it before stopping.
    pre-push still runs the whole `just check`. The rows of AGENTS.md →
    "When to run what" are still yours to run;
  - `just deploy` and `just eval` ask before running (production, paid).
- Sub-agents always run on Opus in this repo: pass `model: 'opus'` to the
  Agent tool (Sonnet output needs reviewer rework here).
- Connecting to the production hosts needs Petr's explicit per-host consent
  (the auto-mode classifier blocks agent-inferred prod SSH targets).

## Subagents — delegate to them

| Agent                                                                                  | When                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `test-runner`                                                                          | after code changes, on any failing test or build, to reproduce a UI bug in a real browser, and to write tests |
| `code-reviewer`                                                                        | before committing a feature or refactor: the architecture invariants                                          |
| `agent-parity`                                                                         | after any new or changed user capability: did it reach the agent surface                                      |
| `security-reviewer`                                                                    | auth, sharing, new routes, MCP, uploads, deploy config                                                        |
| `narrative-docs`                                                                       | after a significant success or failure: sweep and reconcile the docs                                          |
| `state-sync`, `renderer`, `editor-ui`, `animation`, `media`, `ai-integration`, `infra` | work inside their area (`docs/agents.md` has the ownership map)                                               |

## Committing

When Petr asks to run the checks and commit a stretch of work, follow the
global `commit-in-background` skill: snapshot the finished tree, let a
background fork split it into small commits and verify each one in its own
git worktree (`just ci` after the last), keep working meanwhile, then adopt
its commits with `git reset --mixed`. Small diffs are committed inline.
Never push without its own word.

## Skills

- `/playwright-e2e` — writing and debugging Playwright specs against the dev
  stack (deterministic seeding, canvas pixel assertions, traces).
