# Agent Orchestration — Narrative

Jak spolupracují specializovaní agenti na projektu Narrative.

## Struktura

```
                   ┌─────────────┐
                   │  tech-lead  │  (hlavní vlákno — rozhoduje, integruje, řeší konflikty)
                   └──────┬──────┘
                          │ dispatches
        ┌─────────────────┼─────────────────┬──────────────┐
        │                 │                 │              │
   ┌────▼────┐      ┌─────▼──────┐    ┌─────▼─────┐   ┌────▼─────┐
   │  BUILD  │      │  QUALITY   │    │   DOCS    │   │   OPS    │
   │ agents  │      │  agents    │    │   agent   │   │  agent   │
   └─────────┘      └────────────┘    └───────────┘   └──────────┘
```

## Build agenti (píšou produkční kód)

| Agent | Scope | Klíčové packages |
|---|---|---|
| `renderer` | PixiJS scene graph, resource manager, reconciler, DOM overlay compositor | `apps/web/src/renderer/` |
| `state-sync` | Yjs data model, object type registry, Hocuspocus server, persistence | `packages/slide-model/`, `packages/shared/`, `apps/server/src/hocuspocus/` |
| `animation` | JSON DSL, GSAP compiler, timeline runtime, mixed-target dispatch | `packages/animation/` |
| `editor-ui` | React editor shell, Tailwind UI, toolbar/inspector/panels, keyboard | `apps/web/src/ui/`, `packages/ui/` |
| `media` | tus uploads, MinIO, imgproxy, ffmpeg workers, preloading | `apps/server/src/uploads/`, `apps/workers/` |
| `infra` | Docker, Caddy, CI/CD, deploy, backups, observability stack | `infra/`, `.github/workflows/` |
| `ai-integration` | Anthropic SDK, tool use, streaming, server-side Yjs client pro AI | `apps/server/src/ai/` |

## Quality agenti (kontrolují, netvoří features)

| Agent | Scope |
|---|---|
| `qa-tester` | Testy napříč packages, synthetic load, visual regression, performance baseline |
| `code-reviewer` | Review diffů proti architektonickým principům + code quality |
| `security-reviewer` | Security audit (XSS, auth, IDOR, SSRF, DoS, secret leak) |

## Docs/Ops agent

| Agent | Scope |
|---|---|
| `docs-scribe` | ADRs, handoff dokumenty, CHANGELOG, README, runbook |

## Tech-lead (main thread, tj. já)

- Dekomponuje milestone na pracovní balíky.
- Dispatchne build agenty paralelně tam, kde jsou balíky nezávislé.
- Řeší konflikty mezi agenty (např. renderer vs. state-sync hranice).
- Schvaluje ADR draft před aplikací.
- Před milestone close: dispatchne quality agenty (qa-tester → code-reviewer → security-reviewer podle relevance).
- Po milestone close: dispatchne `docs-scribe` na handoff dokument.
- Zapisuje výsledky do conversation history, kterou user vidí.

---

## Paralelizační patterny

### Čistě paralelní (nezávislé balíky ve stejném milestonu)

Příklad z M6 (Animation engine):
- `animation` agent: DSL + GSAP compiler + runtime
- `editor-ui` agent: timeline preview button + preset dropdown (pouze UI, volá animation API)
- `infra` agent: Sentry integrace + metrics baseline (observability)
- `qa-tester` agent: load harness scaffold (po dokončení animation milestonu)

Všichni startují ve stejné session/worktree, integrace na konci.

### Sekvenční (závislé)

Příklad z M4 (MVP):
1. `state-sync` dokončí Hocuspocus + Postgres persistence.
2. `infra` přidá do docker-compose (závisí na tom, co state-sync potřebuje za env/volume).
3. `infra` napíše deploy skript.
4. `editor-ui` integruje HocuspocusProvider (potřebuje API od state-sync).
5. `qa-tester` ověří multi-tab sync a persistence přes restart.
6. `security-reviewer` reviewuje WebSocket auth flow (i když auth přijde až v M10, základy se kladou teď).
7. `docs-scribe` napíše handoff M4.

### Quality gate před milestone close

Vždy v tomto pořadí:
1. `qa-tester` — existují testy kritických cest? Prošly? Load test OK?
2. `code-reviewer` — architektonické principy dodrženy?
3. `security-reviewer` — pouze pokud milestone dotýká user-facing surface / auth / perms / media / AI / deploy.

Pokud některý quality agent flagne blocker → tech-lead dispatchne příslušného build agenta na fix, ne docs-scribe na handoff.

### Handoff routing

Po quality gate zelené:
1. Build agenti pošlou tech-leadovi krátký status (co udělali, co rozhodli, co je další).
2. Tech-lead agreguje + dispatchne `docs-scribe` s těmi vstupy.
3. `docs-scribe` napíše `docs/handoff/MXX-<název>.md` dle šablony.
4. Tech-lead reviewuje, commit, user potvrzuje "hotovo".

---

## Konfliktní zóny (dobré mít předem ošetřené)

| Zóna | Owner | Co ostatní nesmí |
|---|---|---|
| Pixi scene graph | `renderer` | Ostatní nevolají Pixi přímo. Všechno přes renderer API. |
| Y.Doc schema | `state-sync` | Animation ukládá DSL do Y.Map podle schema definovaného state-syncem, netvoří si vlastní storage. |
| GSAP volání | `animation` | Žádný `import { gsap } from 'gsap'` mimo `packages/animation`. |
| docker-compose.yml | `infra` | Ostatní popíší requirements (porty, volumes, env), infra začlení. |
| Env var schema | `infra` | Owner feature ohlásí potřebu env var, infra přidá do schema a `.env.example`. |
| Anthropic API volání | `ai-integration` | Žádný přímý API klient mimo `apps/server/src/ai/`. |

---

## Jak tech-lead volá agenty

Pomocí Claude Code `Agent` tool (Task):

```
Agent(
  description: "Implement M6 DSL compiler",
  subagent_type: "animation",
  prompt: "...self-contained brief s full kontextem..."
)
```

Paralelně: více `Agent` invocations v jednom message bloku.

Každý agent má svou vlastní context window, nezná předchozí konverzaci → tech-lead musí v promptu dodat všechen potřebný kontext: milestone goal, relevantní ADR, co ostatní agenti dělají souběžně, kde jsou hranice.

---

## Memory & handoff napříč sessions

- `docs/handoff/MXX-<název>.md` — primární resume point po každém milestonu.
- `docs/adr/` — architektonická paměť.
- Claude user memory (`~/.claude/projects/D--Narrative/memory/`) — user preferences, feedback, persistent context napříč sessions.
- Git history — co se kdy stalo.

Nová session začne tak, že tech-lead přečte:
1. Latest `docs/handoff/MXX-*.md`
2. `BUILD_PLAN.md` (jaký je další milestone)
3. Memory index (`MEMORY.md`)
4. `docs/adr/` relevantní k nadcházející práci

Pak začne dispatchovat.
