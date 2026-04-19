# Narrative

Self-hosted collaborative presentation tool with Keynote-level animations, real-time multi-user editing, and AI-assisted slide generation. Built for small teams (up to 15 simultaneous editors) on your own infrastructure.

## Requirements

- Node.js >= 22
- pnpm >= 9
- Docker (for local Postgres)

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env template and fill in values
cp .env.example .env
# Edit .env — at minimum set POSTGRES_PASSWORD

# 3. Start local Postgres
docker compose -f infra/docker-compose.yml up -d

# 4. Start dev servers (web on :5173, server on :3001)
pnpm dev
```

Verify the server is running:

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

## Structure

```
apps/
  web/      React + Vite + TS + Tailwind (editor frontend)
  server/   Fastify + TypeScript (API + Hocuspocus, added M4)
packages/
  shared/       Shared types (API shapes, etc.)
  slide-model/  Yjs bindings + object type registry
  animation/    JSON DSL + GSAP compiler
  ui/           Reusable React components
infra/
  docker-compose.yml   Postgres (dev) — extended in M4/M10/M11
  scripts/             Deploy + backup scripts
docs/
  adr/       Architecture Decision Records
  handoff/   Per-milestone handoff documents
```

See [BUILD_PLAN.md](./BUILD_PLAN.md) for the full milestone roadmap and stack decisions.

See [docs/agents.md](./docs/agents.md) for the AI agent workflow and ownership model.

## Development scripts

```bash
pnpm dev          # Start web + server in parallel
pnpm -r build     # Build all workspaces
pnpm -r typecheck # TypeScript check across all workspaces
pnpm -r lint      # ESLint across all workspaces
pnpm -r test      # Tests across all workspaces
```

## CI

GitHub Actions runs on every push and PR to `main`:
lint → typecheck → build → test.

See [.github/workflows/ci.yml](.github/workflows/ci.yml).
